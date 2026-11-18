// Adversarial fuzz tests for Markdown mode's conversion layer.
//
// Independent of test/markdown.test.js: instead of hand-picked cases this file
// attacks the conversion with a seeded PRNG. It exists to verify the promises
// documented at the top of assets/doc/markdown.js rather than re-test the
// emitter's own choices:
//
//   1. rich blocks -> source lines -> rich blocks keeps the stored HTML
//      byte-identical for everything the rich model can hold, and the source
//      lines are stable from the first cycle on;
//   2. arbitrary user text is total (never throws), bounded, and reaches a
//      stable fixpoint; the HTML escape hatch never produces an image block or
//      a scheme-relative/unsafe href (absolute links stay http/https/mailto,
//      and stored relative/fragment links round-trip rather than being lost);
//   3. toggling a random source document is stable on the second cycle, source
//      lines never absorb image payloads, and image blocks pass through by
//      identity;
//   4. caret maps always return in-range positions, and the documented exact
//      round trip holds for plain paragraph lines;
//   5. a large-document performance measurement (reported, with one linear-time
//      guard for bracket-dense lines because link scanning used to rescan).
//
// editor.test.js owns the harness runner: it collects window.__extraTests and
// runs them after its own tests on the same page. This file only registers
// tests, so it needs no DOM setup and no runner of its own.
//
// Tests are deterministic: every random case comes from mulberry32(seed), so a
// failure message names the seed and the exact blocks/source to reproduce it.

import {
  inlineToRuns,
  lineToBlocks,
  mapRichCaretToSource,
  mapSourceCaretToRich,
  readLine,
  richToSource,
  runsToInline,
  sourceToRich,
  stripInline,
  writeLine,
} from "/assets/doc/markdown.js";
import {
  blockLength,
  blockText,
  createBlock,
  parseDocument,
  serializeDocument,
} from "/assets/doc/model.js";
import { inspect } from "/assets/doc/markdown-edit.js";

window.__extraTests = window.__extraTests || [];

function test(name, fn) {
  window.__extraTests.push({ name, fn });
}

/* --------------------------------------------------------------------------
   Assertions
   -------------------------------------------------------------------------- */

// `message` may be a function so hot loops only format it on failure.
function assert(condition, message) {
  if (!condition) {
    throw new Error(typeof message === "function" ? message() : message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((typeof message === "function" ? message() : message) + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      (typeof message === "function" ? message() : message) +
        ": expected " + expectedJson.slice(0, 4000) +
        ", got " + actualJson.slice(0, 4000),
    );
  }
}

/* --------------------------------------------------------------------------
   Seeded PRNG (mulberry32) and helpers
   -------------------------------------------------------------------------- */

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) | value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createRandom(seed) {
  const random = mulberry32(seed);
  return {
    next: random,
    int(min, max) {
      return min + Math.floor(random() * (max - min + 1));
    },
    chance(probability) {
      return random() < probability;
    },
    pick(list) {
      return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
    },
    char(alphabet) {
      return alphabet[Math.min(alphabet.length - 1, Math.floor(random() * alphabet.length))];
    },
  };
}

function sourceBlock(text) {
  const block = createBlock("p", text ? [{ text: String(text) }] : []);
  block.source = true;
  return block;
}

function sourceBlocks(lines) {
  return lines.map(sourceBlock);
}

// A compact, comparable view of source blocks: image blocks become a marker so
// two conversions can be compared even though images keep their identity.
function sourceTexts(blocks) {
  return blocks.map((block) => (block && block.type === "image" ? "[image]" : block ? blockText(block) : "[null]"));
}

function documentChars(blocks) {
  let total = 0;
  for (const block of blocks) {
    total += block && block.type !== "image" ? blockLength(block) : 0;
  }
  return total;
}

function jsonSlice(value, limit) {
  const text = JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? -1 : limit;
}

function contextAround(text, offset) {
  return JSON.stringify(text.slice(Math.max(0, offset - 100), offset + 100));
}

const SAFE_HREF_PATTERN = /^(?:https?:\/\/\S+|mailto:\S+)$/i;

// The parser may hand back absolute links (http/https/mailto) and the relative
// or fragment links the stored format already allows. Protocol-relative
// targets and backslashes must never survive.
function isSafeHrefValue(href) {
  if (typeof href !== "string") {
    return false;
  }
  const value = href.trim();
  if (!value || /[\u0000-\u0020\u007f]/.test(value) || value.includes("\\")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return SAFE_HREF_PATTERN.test(value);
  }
  return !value.startsWith("//");
}

function requireHrefSafe(href, context) {
  if (typeof href !== "string") {
    throw new Error(context + ": href is not a string: " + JSON.stringify(href));
  }
  if (!isSafeHrefValue(href)) {
    throw new Error(context + ": href is not http/https/mailto or a relative target: " + JSON.stringify(href));
  }
}

function checkHrefsInBlocks(blocks, context) {
  for (const block of blocks) {
    if (!block || !block.runs) {
      continue;
    }
    for (const run of block.runs) {
      if (run && run.href) {
        requireHrefSafe(run.href, context());
      }
    }
  }
}

// The parser must never turn document text into a loading image or a script
// element. Serialized HTML escapes text, so a raw `<img` can only come from a
// real element the parser built.
function checkNoActiveElements(blocks, context) {
  for (const block of blocks) {
    assert(block && block.type !== "image", () => context() + ": source text produced an image block");
  }
  const html = serializeDocument(blocks);
  for (const tag of ["img", "script", "iframe", "svg", "object", "embed"]) {
    assert(!new RegExp("<" + tag + "\\b", "i").test(html), () => context() + ": serialized HTML has a <" + tag + "> element: " + html.slice(0, 600));
  }
}

/* --------------------------------------------------------------------------
   Random rich documents
   -------------------------------------------------------------------------- */

// Text a run may hold. `\r`, NBSP and other characters that the stored-HTML
// parser normalizes are excluded from the lossless generator (they are not
// reproducible through parseDocument either); the arbitrary-text test below
// covers them for totality and fixpoint stability instead.
const RICH_TEXT_ALPHABET = "abcXYZ 012\t\n*_~`[]<>\\#!+-.()&;:\"'/=é中✓😀";

// Prefixes that would be read as a block marker or an HTML escape hatch when a
// paragraph's text happened to start with them.
const RICH_HAZARD_PREFIXES = [
  "# ",
  "## ",
  "### ",
  "> ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "12. ",
  "```",
  "````",
  "  - ",
  "\t- ",
  " <p>",
  "<p>",
  '<p data-align="center">',
  "<h1>",
  "<ul>",
  "<blockquote>",
  "<u>",
  "<br>",
  "<img ",
  "<script>",
  "<a href=",
  "\\",
];

const SAFE_HREFS = [
  "https://example.com/",
  "https://example.com/a?q=1&r=2",
  "http://localhost:8080/x",
  "mailto:user@example.com",
  "https://example.com/wiki/Foo_(bar)",
  "https://example.com/quote\"and'apostrophe",
  "https://example.com/%C3%A9",
];

const CODE_ALPHABET = "abcXYZ 012`~*_[]<>\\#!+-.()&;:\"'/=é中✓😀\t";

let imageCounter = 0;

function randomText(random, maxLength) {
  let text = "";
  if (random.chance(0.18)) {
    text = random.pick(RICH_HAZARD_PREFIXES);
  }
  const length = random.int(0, maxLength);
  for (let index = 0; index < length; index += 1) {
    text += random.char(RICH_TEXT_ALPHABET);
  }
  return text;
}

function randomRuns(random) {
  const runs = [];
  const count = random.chance(0.12) ? 0 : random.int(1, 3);
  for (let index = 0; index < count; index += 1) {
    let text = randomText(random, 9);
    if (!text) {
      continue;
    }
    const run = { text };
    if (random.chance(0.32)) run.b = true;
    if (random.chance(0.32)) run.i = true;
    if (random.chance(0.22)) run.u = true;
    if (random.chance(0.22)) run.s = true;
    if (random.chance(0.22)) run.code = true;
    if (random.chance(0.24)) run.href = random.pick(SAFE_HREFS);
    runs.push(run);
  }
  return runs;
}

function randomCodeText(random) {
  const lineCount = random.int(0, 4);
  const lines = [];
  for (let index = 0; index < lineCount; index += 1) {
    let line = "";
    const length = random.int(0, 12);
    for (let character = 0; character < length; character += 1) {
      line += random.char(CODE_ALPHABET);
    }
    if (random.chance(0.25)) {
      // A backtick run at a random line position, so the emitter has to grow
      // the fence or keep the run as code content.
      const position = random.int(0, line.length);
      line = line.slice(0, position) + "`".repeat(random.int(1, 5)) + line.slice(position);
    }
    lines.push(line);
  }
  let text = lines.join("\n");
  if (random.chance(0.3)) {
    text += "\n";
  }
  if (random.chance(0.2)) {
    text = "";
  }
  return text;
}

function randomImageBlock(random) {
  const mode = random.pick(["block", "left", "right", "free"]);
  const maybePosition = () => (random.chance(0.5) ? random.int(-40, 400) : null);
  imageCounter += 1;
  return {
    id: "fuzz-image-" + imageCounter,
    type: "image",
    mode,
    x: mode === "free" || random.chance(0.2) ? maybePosition() : null,
    y: mode === "free" || random.chance(0.2) ? maybePosition() : null,
    src: "data:image/png;base64," + random.pick(["AAAA", "BBBB", "CCCC", "iVBORw0KGgo="]),
    alt: random.chance(0.5) ? random.pick(["pic", 'a "quoted" alt', "alt & more", "é中"]) : "",
    width: random.chance(0.9) ? random.int(1, 500) : 0,
    height: random.chance(0.9) ? random.int(1, 500) : 0,
    displayWidth: random.chance(0.4) ? random.int(1, 500) : null,
    radius: random.chance(0.4) ? random.int(0, 200) : null,
  };
}

function applyRandomFormat(random, block) {
  if (random.chance(0.18)) {
    block.align = random.pick(["center", "right", "justify"]);
  } else if (random.chance(0.05)) {
    block.align = "left";
  }
  if (random.chance(0.12)) {
    block.indent = random.int(1, 6);
  }
  return block;
}

function randomRichBlock(random) {
  const roll = random.next();
  if (roll < 0.07) {
    return randomImageBlock(random);
  }
  if (roll < 0.15) {
    return { ...createBlock("code", [{ text: randomCodeText(random) }]), id: "fuzz-code-" + random.int(0, 1e9) };
  }
  if (roll < 0.25) {
    const block = createBlock("list", randomRuns(random));
    block.ordered = random.chance(0.5);
    block.depth = random.int(0, 6);
    return applyRandomFormat(random, block);
  }
  if (roll < 0.35) {
    return applyRandomFormat(random, createBlock("quote", randomRuns(random)));
  }
  if (roll < 0.45) {
    return applyRandomFormat(random, createBlock(random.pick(["h1", "h2", "h3"]), randomRuns(random)));
  }
  if (roll < 0.51) {
    return applyRandomFormat(random, createBlock("p", []));
  }
  return applyRandomFormat(random, createBlock("p", randomRuns(random)));
}

function randomRichDocument(random) {
  const blocks = [];
  const count = random.int(1, 7);
  for (let index = 0; index < count; index += 1) {
    blocks.push(randomRichBlock(random));
  }
  return blocks;
}

/* --------------------------------------------------------------------------
   1. Lossless round trip over random rich documents
   -------------------------------------------------------------------------- */

function checkRichRoundTrip(blocks, describe) {
  const before = JSON.stringify(blocks);
  const stored = serializeDocument(blocks);

  const first = richToSource(blocks);
  assertEqual(first.blocks.length, first.lineMap.length, () => describe() + ": source blocks and lineMap disagree");
  assertEqual(first.blocks.length >= 1, true, () => describe() + ": richToSource returned no source block");
  assertEqual(first.richLines.length, blocks.length, () => describe() + ": richLines length");

  // Source blocks are one line each: paragraph blocks marked source, or the
  // original image objects passed through untouched.
  const imageCount = blocks.filter((block) => block && block.type === "image").length;
  let sourceImageCount = 0;
  for (const block of first.blocks) {
    if (block.type === "image") {
      sourceImageCount += 1;
      assert(blocks.indexOf(block) >= 0, () => describe() + ": source image is not the original block object");
      continue;
    }
    assert(block.type === "p" && block.source === true, () => describe() + ": source block is not a source paragraph");
    assert(!blockText(block).includes("\n"), () => describe() + ": one source block holds two lines: " + JSON.stringify(blockText(block)));
  }
  assertEqual(sourceImageCount, imageCount, () => describe() + ": image count changed in source");

  const sourceSnapshot = JSON.stringify(first.blocks);
  const back = sourceToRich(first.blocks);
  assertEqual(back.blocks.length >= 1, true, () => describe() + ": sourceToRich returned no block");
  assertEqual(back.lineMap.length, first.blocks.length, () => describe() + ": back lineMap length");
  assertEqual(JSON.stringify(first.blocks), sourceSnapshot, () => describe() + ": sourceToRich mutated its input");
  assertEqual(JSON.stringify(blocks), before, () => describe() + ": richToSource/sourceToRich mutated the rich blocks");

  // Images pass through both conversions by identity, in the same order.
  const backImages = back.blocks.filter((block) => block && block.type === "image");
  assertEqual(backImages.length, imageCount, () => describe() + ": image count changed after parsing source");
  for (const image of backImages) {
    assert(blocks.indexOf(image) >= 0, () => describe() + ": parsed image is not the original block object");
  }

  const roundtrip = serializeDocument(back.blocks);
  if (stored !== roundtrip) {
    const difference = firstDifference(stored, roundtrip);
    throw new Error(
      describe() +
        ": stored HTML changed through Markdown source" +
        "\n  rich blocks: " + jsonSlice(blocks, 6000) +
        "\n  source lines: " + jsonSlice(sourceTexts(first.blocks), 4000) +
        "\n  stored:      " + jsonSlice(stored, 2000) +
        "\n  round trip:  " + jsonSlice(roundtrip, 2000) +
        "\n  first difference at " + difference + ": stored " + contextAround(stored, difference) + " vs round trip " + contextAround(roundtrip, difference),
    );
  }

  // The source produced from the round-tripped blocks must be identical to the
  // first source: entering and leaving the mode a second time changes nothing.
  const second = richToSource(back.blocks);
  assertDeepEqual(
    sourceTexts(second.blocks),
    sourceTexts(first.blocks),
    () => describe() + ": second cycle source is not stable\n  rich blocks: " + jsonSlice(blocks, 6000),
  );

  return { first, back, stored };
}

test("markdown fuzz: random rich documents round-trip losslessly (2000 seeds)", async () => {
  const SEEDS = 2000;
  for (let seedIndex = 0; seedIndex < SEEDS; seedIndex += 1) {
    const seed = 0x100000 + seedIndex;
    const random = createRandom(seed);
    const blocks = randomRichDocument(random);
    checkRichRoundTrip(blocks, () => "random rich document seed " + seed);
  }
});

test("markdown fuzz: documents read back from stored HTML round-trip (500 seeds)", async () => {
  // The real input to entering Markdown mode is a document parsed from the
  // stored sanitized HTML, not a hand-built block array. Serialize, parse, and
  // run the same invariant on what the editor would actually open.
  const SEEDS = 500;
  for (let seedIndex = 0; seedIndex < SEEDS; seedIndex += 1) {
    const seed = 0x110000 + seedIndex;
    const random = createRandom(seed);
    const blocks = randomRichDocument(random);
    const html = serializeDocument(blocks);
    const stored = parseDocument(html);
    checkRichRoundTrip(stored, () => "stored document seed " + seed + "\n  html: " + jsonSlice(html, 4000));
  }
});

test("markdown fuzz: hand-built extremes round-trip", async () => {
  // Empty block array: the editor always shows a line, so richToSource makes a
  // placeholder and parsing it back is one empty paragraph.
  const emptySource = richToSource([]);
  assertEqual(emptySource.blocks.length, 1, "empty document has one source line");
  assertEqual(blockText(emptySource.blocks[0]), "", "empty source line");
  assertEqual(serializeDocument(sourceToRich(emptySource.blocks).blocks), "<p></p>", "empty document parses back to one paragraph");

  const documents = [
    [createBlock("p", [{ text: " \t " }])],
    [createBlock("p", [{ text: "\n" }])],
    [createBlock("p", [{ text: "\n\n" }])],
    [createBlock("p", [{ text: "\\" }])],
    [createBlock("p", [{ text: "\\*" }])],
    [createBlock("p", [{ text: "*_~`[]<>#!+-.()" }])],
    [createBlock("p", [{ text: "# heading-looking text" }])],
    [createBlock("p", [{ text: "1. list-looking text" }])],
    [createBlock("p", [{ text: "```" }])],
    [createBlock("p", [{ text: "> quote-looking text" }])],
    [createBlock("p", [{ text: "<br>" }])],
    [createBlock("p", [{ text: "<u>x</u>" }])],
    [createBlock("p", [{ text: "" }])],
    [createBlock("h1", [])],
    [createBlock("h2", [])],
    [createBlock("h3", [])],
    [createBlock("quote", [])],
    [createBlock("code", [{ text: "" }])],
    [createBlock("code", [{ text: "\n" }])],
    [createBlock("code", [{ text: "````" }])],
    [createBlock("code", [{ text: "a```b\n\nc\n" }])],
    [createBlock("p", [{ text: "a\nb", code: true }])],
    [createBlock("p", [{ text: "x", href: "https://example.com/wiki/Foo_(bar)" }])],
    [createBlock("p", [{ text: "x", href: "https://example.com/a)b?c=d" }])],
    [createBlock("list", [])],
    [createBlock("list", [{ text: "" }, { text: "marked", b: true }])],
  ];
  for (let index = 0; index < documents.length; index += 1) {
    const blocks = documents[index];
    for (let repeat = 0; repeat < 2; repeat += 1) {
      checkRichRoundTrip(blocks, () => "hand-built extreme " + index + " (repeat " + repeat + ")");
    }
  }

  // Every block type in one document, with empty paragraphs between them.
  const mixed = [
    createBlock("p", [{ text: "first" }]),
    createBlock("p", []),
    createBlock("h1", [{ text: "Heading", b: true }]),
    createBlock("quote", [{ text: "quoted\nline" }]),
    createBlock("list", [{ text: "item" }]),
    createBlock("code", [{ text: "code\n`x`" }]),
    { id: "fuzz-image-x", type: "image", mode: "free", x: 3, y: 4, src: "data:image/png;base64,AAAA", alt: "a", width: 10, height: 20, displayWidth: 10, radius: 4 },
    createBlock("p", []),
    createBlock("p", [{ text: "last" }]),
  ];
  mixed[4].ordered = true;
  mixed[4].depth = 2;
  mixed[4].align = "center";
  mixed[2].indent = 3;
  checkRichRoundTrip(mixed, () => "mixed document");
});

/* --------------------------------------------------------------------------
   2. Arbitrary user text: totality, bounds, fixpoint
   -------------------------------------------------------------------------- */

const HAZARD_ALPHABET =
  "\\`*_~[]()<>#!+-., 0123456789abcXYZpuhrefsvgiframenoltimgscript\n\r\t\u0000\u0001\u0008\u000b\u000c\u001f\u007f\u00a0\u2028\u2029\u3000é中✓😀&;:\"'/=";

const MARKDOWN_WORDS = ["img", "script", "iframe", "svg", "onload", "onerror", "onclick", "href", "src", "http://", "https://", "mailto:", "javascript:", "data:image/png;base64,", "<p", "</p>", "<a ", "<u>", "</u>", "<br>", "**", "~~", "```", "[x](", "](https://example.com)"];

function randomUserText(random, maxLength) {
  let text = "";
  const wordCount = random.chance(0.4) ? random.int(1, 4) : 0;
  for (let index = 0; index < wordCount; index += 1) {
    text += random.pick(MARKDOWN_WORDS);
  }
  const length = random.int(0, maxLength);
  for (let index = 0; index < length; index += 1) {
    text += random.char(HAZARD_ALPHABET);
  }
  return text;
}

function checkSingleLineText(text, describe) {
  const runs = inlineToRuns(text);
  assert(Array.isArray(runs), () => describe() + ": inlineToRuns did not return an array");
  let total = 0;
  for (const run of runs) {
    assert(run && typeof run.text === "string" && run.text.length > 0, () => describe() + ": bad inline run " + JSON.stringify(run));
    total += run.text.length;
    if (run.href) {
      requireHrefSafe(run.href, describe);
    }
  }
  assert(total <= text.length, () => describe() + ": inlineToRuns grew text (" + total + " > " + text.length + ")");

  const inline = runsToInline(runs);
  assert(typeof inline === "string", () => describe() + ": runsToInline did not return a string");
  assert(inline.length <= text.length * 6 + 400, () => describe() + ": runsToInline grew without bound (" + inline.length + " for " + text.length + ")");

  const stripped = stripInline(text);
  assert(typeof stripped === "string", () => describe() + ": stripInline did not return a string");
  assert(stripped.length <= text.length + 8, () => describe() + ": stripInline grew text");

  const line = readLine(text);
  assert(line && typeof line.kind === "string", () => describe() + ": readLine did not classify");
  assert(typeof writeLine(line) === "string", () => describe() + ": writeLine did not return a string");

  const blocks = lineToBlocks(text);
  assert(Array.isArray(blocks), () => describe() + ": lineToBlocks did not return an array");
  for (const block of blocks) {
    assert(block.type !== "image", () => describe() + ": lineToBlocks produced an image");
    assert(block.type !== "code", () => describe() + ": a single line produced a code block without a fence context");
  }
  checkHrefsInBlocks(blocks, describe);
}

test("markdown fuzz: arbitrary user text is total, bounded, and reaches a fixpoint (1200 cases)", async () => {
  const CASES = 1200;
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const seed = 0x200000 + caseIndex;
    const random = createRandom(seed);
    const describe = () => "user text seed " + seed;

    const lineCount = random.int(1, 3);
    const lines = [];
    for (let index = 0; index < lineCount; index += 1) {
      lines.push(randomUserText(random, 60));
    }
    for (const line of lines) {
      checkSingleLineText(line, () => describe() + " line " + JSON.stringify(line));
    }

    // whole document: parse, emit, parse again; the second pair must match.
    const source = sourceBlocks(lines);
    const parsed = sourceToRich(source);
    assert(parsed.blocks.length >= 1, () => describe() + ": sourceToRich returned no block");
    assertEqual(parsed.lineMap.length, source.length, () => describe() + ": lineMap length");
    assertEqual(parsed.imageTargets.length, source.length, () => describe() + ": imageTargets length");
    checkHrefsInBlocks(parsed.blocks, describe);
    assertEqual(parsed.blocks.some((block) => block.type === "image"), false, () => describe() + ": user text produced an image block");

    const storedOnce = serializeDocument(parsed.blocks);
    const sourceOnce = richToSource(parsed.blocks).blocks;
    const parsedTwice = sourceToRich(sourceOnce);
    const storedTwice = serializeDocument(parsedTwice.blocks);
    if (storedOnce !== storedTwice) {
      const difference = firstDifference(storedOnce, storedTwice);
      throw new Error(
        describe() + ": user text did not reach a fixpoint" +
          "\n  lines: " + jsonSlice(lines, 3000) +
          "\n  stored once:  " + jsonSlice(storedOnce, 1500) +
          "\n  stored twice: " + jsonSlice(storedTwice, 1500) +
          "\n  difference at " + difference + ": " + contextAround(storedOnce, difference) + " vs " + contextAround(storedTwice, difference),
      );
    }
    const sourceTwice = richToSource(parsedTwice.blocks).blocks;
    assertDeepEqual(sourceTexts(sourceTwice), sourceTexts(sourceOnce), () => describe() + ": source lines change on the second cycle");

    // Emitted source is always one line per block, image-free, and bounded.
    for (const block of sourceOnce) {
      assert(block.type === "p" && block.source === true, () => describe() + ": emitted user text block is not a source paragraph");
      const emitted = blockText(block);
      assert(!emitted.includes("\n"), () => describe() + ": emitted source line contains a newline");
      assert(emitted.length <= lines.join("").length * 8 + 800, () => describe() + ": emitted source is not bounded");
    }
  }
});

test("markdown fuzz: malformed and non-string inputs are tolerated", async () => {
  // These are the documented pure entry points; none may throw on empty or
  // wrong-typed input, because callers pass selection/clipboard data through.
  assertEqual(richToSource(null).blocks.length, 1, "richToSource(null) yields the placeholder line");
  assertEqual(richToSource(undefined).blocks.length, 1, "richToSource(undefined) yields the placeholder line");
  assertEqual(richToSource("not blocks").blocks.length, 1, "richToSource(non-array) yields the placeholder line");
  assertEqual(sourceToRich(null).blocks.length, 1, "sourceToRich(null) yields one paragraph");
  assertEqual(sourceToRich(undefined).blocks.length, 1, "sourceToRich(undefined) yields one paragraph");
  assertEqual(blockText(sourceToRich([]).blocks[0]), "", "sourceToRich([]) yields an empty paragraph");
  assertEqual(mapRichCaretToSource(null, null).block, 0, "mapRichCaretToSource(null) clamps");
  assertEqual(mapSourceCaretToRich(null, null).block, 0, "mapSourceCaretToRich(null) clamps");
  assertEqual(mapRichCaretToSource({}, { block: "x", offset: NaN }).offset, 0, "mapRichCaretToSource tolerates a bad caret");
  assertEqual(mapSourceCaretToRich({ lineMap: [] }, {}).block, 0, "mapSourceCaretToRich tolerates a bad caret");
  assertEqual(inlineToRuns(null).length, 0, "inlineToRuns(null)");
  assertEqual(inlineToRuns(undefined).length, 0, "inlineToRuns(undefined)");
  assertEqual(inlineToRuns(42)[0].text, "42", "inlineToRuns(number) stringifies");
  assertEqual(runsToInline(null), "", "runsToInline(null)");
  assertEqual(runsToInline(undefined), "", "runsToInline(undefined)");
  assertEqual(readLine(null).kind, "blank", "readLine(null)");
  assertEqual(writeLine(null), "", "writeLine(null)");
  assertEqual(writeLine({}), "", "writeLine({})");
  assertEqual(lineToBlocks(null).length, 0, "lineToBlocks(null)");
  assertEqual(stripInline(null), "", "stripInline(null)");
  assertEqual(stripInline(undefined), "", "stripInline(undefined)");
});

/* --------------------------------------------------------------------------
   3. Malicious HTML lines never become images or unsafe links
   -------------------------------------------------------------------------- */

const ATTACK_LINES = [
  '<img src="http://evil.example/track.png">',
  "<img src=http://evil.example/track.png>",
  "<img src='http://evil.example/track.png'>",
  '<img src="data:image/png;base64,AAAA">',
  "<script>alert(1)</script>",
  "<script src=http://evil.example/x.js></script>",
  "<p onclick=\"fetch('http://evil.example')\">x</p>",
  '<p onmouseover="alert(1)">x</p>',
  '<a href="javascript:alert(1)">x</a>',
  "<a href=javascript:alert(1)>x</a>",
  '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="file:///etc/passwd">x</a>',
  '<iframe src="http://evil.example/frame"></iframe>',
  "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
  '<svg onload="alert(1)"></svg>',
  "<svg onload=alert(1)>",
  '<svg><script>alert(1)</script></svg>',
  '<p data-align="center"><img src="http://evil.example/x.png"></p>',
  "<blockquote><script>alert(1)</script></blockquote>",
  "<ul><li><img src=http://evil.example/x.png></li></ul>",
  '<div style="background:url(http://evil.example/x)">x</div>',
  '<p style="color:red">x</p>',
  '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
  "<p><img src=\"data:image/png;base64,AAAA\"></p>",
  '<a href="https://ok.example/">ok</a>',
  '<p><a href="https://ok.example/">marked</a></p>',
  "<p>unterminated",
  '<p data-indent="0">x</p>',
  '<p data-align="evil">x</p>',
  '<img srcset="http://evil.example/x 1x">',
  '<base href="http://evil.example/">',
  '<link rel="stylesheet" href="http://evil.example/x.css">',
  '<meta http-equiv="refresh" content="0;url=http://evil.example/">',
  "<style>@import url(http://evil.example/x.css)</style>",
  "![alt](http://evil.example/x.png)",
  "![alt](javascript:alert(1))",
  "[x](javascript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD4=)",
  "[x](vbscript:msgbox(1))",
  "<!DOCTYPE html>",
  "<p><!-- comment -->x</p>",
  "<p><![CDATA[<script>alert(1)</script>]]></p>",
  "<p><?php echo 1 ?></p>",
  '<p><a href="https://ok.example/" target="_blank">x</a></p>',
  '<p data-align="center" data-align="right">x</p>',
  '<P data-align="center">x</P>',
  "<p data-align='center'>x</p>",
  '<blockquote><p>a</p><p>b</p></blockquote>',
  '<ul data-depth="0" data-ordered="0"><li><ul><li>x</li></ul></li></ul>',
];

const ATTACK_TOKENS = [
  "<",
  ">",
  "</p>",
  "<p>",
  "<img ",
  "img",
  "src=",
  "srcset=",
  "http://evil.example/x.png",
  "https://evil.example/x.png",
  "data:image/png;base64,AAAA",
  "data:text/html;base64,PHNjcmlwdD4=",
  "javascript:alert(1)",
  "vbscript:x",
  "script",
  "iframe",
  "svg",
  "onload=",
  "onerror=",
  "onclick=",
  "<a href=",
  '"',
  "'",
  "[",
  "](",
  ")",
  "<script>",
  "<svg onload=",
  "<iframe src=",
  "&",
  "\\",
  "`",
  "\n",
  "\u0000",
  "\u00a0",
  "é中",
];

function checkAttackSource(lines, describe) {
  const blocks = sourceToRich(sourceBlocks(lines)).blocks;
  checkNoActiveElements(blocks, describe);
  checkHrefsInBlocks(blocks, describe);
  for (const block of blocks) {
    assert(block.type === "p" || block.type === "h1" || block.type === "h2" || block.type === "h3" || block.type === "quote" || block.type === "list", () => describe() + ": unexpected block type " + block.type);
  }

  // lineToBlocks is the per-line path the toolbar uses; it must agree.
  for (const line of lines) {
    const single = lineToBlocks(line);
    checkNoActiveElements(single, () => describe() + " lineToBlocks " + JSON.stringify(line));
    checkHrefsInBlocks(single, () => describe() + " lineToBlocks " + JSON.stringify(line));
    const inline = inlineToRuns(line);
    for (const run of inline) {
      if (run.href) {
        requireHrefSafe(run.href, () => describe() + " inlineToRuns " + JSON.stringify(line));
      }
    }
  }
}

test("markdown fuzz: malicious HTML lines never become images or unsafe links", async () => {
  checkAttackSource(ATTACK_LINES, () => "curated attack lines");

  // Accepted inline escape hatch shapes still carry only safe hrefs.
  const accepted = sourceToRich(sourceBlocks(['<p><a href="https://ok.example/">x</a></p>'])).blocks;
  assertEqual(accepted.length, 1, "one accepted escape block");
  assertEqual(accepted[0].runs[0].href, "https://ok.example/", "safe accepted href survives");
  assertEqual(accepted[0].type, "p", "accepted escape block is a paragraph");

  const randomSeeds = 400;
  for (let seedIndex = 0; seedIndex < randomSeeds; seedIndex += 1) {
    const seed = 0x300000 + seedIndex;
    const random = createRandom(seed);
    const tokenCount = random.int(1, 10);
    let line = "";
    for (let index = 0; index < tokenCount; index += 1) {
      line += random.pick(ATTACK_TOKENS);
      if (random.chance(0.4)) {
        line += random.chance(0.5) ? " " : "";
      }
    }
    line = random.chance(0.3) ? random.pick(["<p>", "<p data-align=\"center\">", "<blockquote>", "<ul>", "<h1>", "<li>"]) + line : line;
    checkAttackSource([line], () => "attack token soup seed " + seed + " line " + JSON.stringify(line));
  }

  // The emitted source for a document whose text *looks* like HTML stays text:
  // parsing it back cannot upgrade the literal text into an element either.
  for (const line of ATTACK_LINES) {
    const parsed = sourceToRich([sourceBlock(line)]).blocks;
    const emitted = richToSource(parsed).blocks;
    checkNoActiveElements(emitted, () => "attack emitted source " + JSON.stringify(line));
    checkHrefsInBlocks(emitted, () => "attack emitted source " + JSON.stringify(line));
  }
});

test("markdown fuzz: unsafe stored hrefs are dropped", async () => {
  // A stored document can only hold what the sanitizer allows, but the model
  // parser accepts any href attribute and older files are read as-is. The
  // emitter documents that hrefs the dialect cannot carry safely are dropped
  // instead of being written back as a different link; verify that, and that
  // nothing unsafe reaches the emitted source or the parsed blocks. Relative
  // and fragment links are carried (see the preservation test below).
  const unsupported = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "//evil.example/x",
    "https://example.com/a b",
    "mailto:",
    "",
  ];
  for (const href of unsupported) {
    const block = createBlock("p", [{ text: "label" }]);
    block.runs[0].href = href;
    const conversion = richToSource([block]);
    const lines = sourceTexts(conversion.blocks);
    for (const line of lines) {
      assert(!/javascript:|vbscript:|data:text|file:|\/\/evil|href=/i.test(line), () => "unsafe href " + JSON.stringify(href) + " leaked into source line " + JSON.stringify(line));
    }
    const back = sourceToRich(conversion.blocks).blocks;
    checkHrefsInBlocks(back, () => "unsafe href " + JSON.stringify(href));
    const html = serializeDocument(back);
    assert(!/<a\b/i.test(html), () => "unsafe href " + JSON.stringify(href) + " produced an anchor: " + html);
    assertEqual(blockText(back[0]), "label", () => "unsafe href " + JSON.stringify(href) + " lost its label text");
  }

  // The documented absolute schemes survive; the label text is never dropped.
  for (const href of ["https://example.com/x", "http://example.com/x", "mailto:user@example.com"]) {
    const block = createBlock("p", [{ text: "label" }]);
    block.runs[0].href = href;
    const back = sourceToRich(richToSource([block]).blocks).blocks;
    assertEqual(back[0].runs[0].href, href, "safe href " + href + " is carried");
    assertEqual(blockText(back[0]), "label", "safe href label text");
  }

  // The stored format also accepts relative and fragment links (the server
  // sanitizer passes them through). Any unrelated edit in Markdown mode must
  // not quietly drop them.
  for (const href of ["/other/doc", "#section", "notes/one.html", "?q=1"]) {
    const block = createBlock("p", [{ text: "label" }]);
    block.runs[0].href = href;
    const source = richToSource([block]);
    const back = sourceToRich(source.blocks).blocks;
    assertEqual(back[0].runs[0].href, href, "relative href " + href + " is carried");
    assertEqual(blockText(back[0]), "label", "relative href label text");

    // A block that also carries a rich-only attribute is emitted through the
    // HTML escape hatch; the anchor must still survive that path.
    const aligned = { ...block, id: "aligned-1", align: "center" };
    const escaped = richToSource([aligned]);
    const alignedBack = sourceToRich(escaped.blocks).blocks;
    assertEqual(alignedBack[0].runs[0].href, href, "escape-hatch relative href " + href + " is carried");
  }
});

/* --------------------------------------------------------------------------
   4. Toggle invariant: stable source, images stay blocks and keep identity
   -------------------------------------------------------------------------- */

const SOURCE_MARKDOWN_LINES = [
  "# Heading",
  "## Smaller",
  "### Third",
  "#### four hashes are text",
  "> quoted",
  "- item",
  "  - nested",
  "    + deep",
  "1. first",
  "  2. second",
  "```",
  "````",
  "",
  "   ",
  '<p data-align="center">aligned</p>',
  '<h2 data-indent="2">indented</h2>',
  "<p></p>",
  '<blockquote><p data-align="right">q</p></blockquote>',
  '<ul data-depth="1" data-ordered="0"><li data-align="center">x</li></ul>',
  "plain paragraph",
  "with **bold** and *italic* and `code`",
  "[link](https://example.com/x)",
  "<u>under</u> and<br>break",
  "\\*literal\\*",
  "1\\. not a list",
  "```not a fence```",
  "<div>rejected html</div>",
  '<img src="http://evil.example/x.png">',
  "<script>alert(1)</script>",
];

function randomSourceLine(random) {
  if (random.chance(0.55)) {
    return random.pick(SOURCE_MARKDOWN_LINES);
  }
  return randomUserText(random, 36);
}

function randomSourceDocument(random, seed) {
  const blocks = [];
  const count = random.int(0, 8);
  for (let index = 0; index < count; index += 1) {
    if (random.chance(0.16)) {
      const payload = "CASE" + seed + "XPAYLOAD" + index + "ZZ";
      blocks.push({
        id: "fuzz-source-image-" + seed + "-" + index,
        type: "image",
        mode: random.pick(["block", "left", "right", "free"]),
        x: random.chance(0.4) ? random.int(0, 300) : null,
        y: random.chance(0.4) ? random.int(0, 300) : null,
        src: "data:image/png;base64," + payload,
        alt: "image " + index,
        width: 10,
        height: 10,
        displayWidth: null,
        radius: null,
      });
      continue;
    }
    blocks.push(sourceBlock(randomSourceLine(random)));
  }
  return blocks;
}

test("markdown fuzz: random source documents toggle stably and keep images as blocks (600 cases)", async () => {
  const CASES = 600;
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const seed = 0x400000 + caseIndex;
    const random = createRandom(seed);
    const describe = () => "source document seed " + seed;
    const document = randomSourceDocument(random, seed);
    const images = document.filter((block) => block.type === "image");
    const payloads = images.map((image) => image.src);

    // Cycle 1: parse the user's source, emit canonical source.
    const parsed = sourceToRich(document);
    assertEqual(parsed.blocks.length >= 1, true, () => describe() + ": parse returned no block");
    for (const image of images) {
      assert(parsed.blocks.indexOf(image) >= 0, () => describe() + ": image block was not passed through by identity");
    }
    const storedOnce = serializeDocument(parsed.blocks);
    for (const payload of payloads) {
      assert(storedOnce.includes(payload), () => describe() + ": image payload was lost");
    }

    const firstSource = richToSource(parsed.blocks);
    let sourceImageCount = 0;
    for (const block of firstSource.blocks) {
      if (block.type === "image") {
        sourceImageCount += 1;
        assert(images.indexOf(block) >= 0, () => describe() + ": emitted source image is not the original block");
        continue;
      }
      const text = blockText(block);
      // User text may legitimately mention "data:image"; what must never appear
      // is the src (or its base64 payload) of an actual image block.
      for (const image of images) {
        assert(!text.includes(image.src), () => describe() + ": source line contains an image src: " + JSON.stringify(text));
      }
      for (const payload of payloads) {
        assert(!text.includes(payload), () => describe() + ": source line contains image payload: " + JSON.stringify(text));
      }
    }
    assertEqual(sourceImageCount, images.length, () => describe() + ": image count changed while emitting source");

    // Cycle 2: converting the canonical source again changes nothing.
    const parsedAgain = sourceToRich(firstSource.blocks);
    const storedAgain = serializeDocument(parsedAgain.blocks);
    if (storedOnce !== storedAgain) {
      const difference = firstDifference(storedOnce, storedAgain);
      throw new Error(
        describe() + ": toggle is not stable on the second cycle" +
          "\n  source lines: " + jsonSlice(sourceTexts(firstSource.blocks), 4000) +
          "\n  stored once:  " + jsonSlice(storedOnce, 1500) +
          "\n  stored again: " + jsonSlice(storedAgain, 1500) +
          "\n  difference at " + difference + ": " + contextAround(storedOnce, difference) + " vs " + contextAround(storedAgain, difference),
      );
    }
    const secondSource = richToSource(parsedAgain.blocks).blocks;
    assertDeepEqual(sourceTexts(secondSource), sourceTexts(firstSource.blocks), () => describe() + ": second cycle source lines differ");
    for (const image of images) {
      assert(parsedAgain.blocks.indexOf(image) >= 0, () => describe() + ": image identity lost on the second cycle");
      assert(secondSource.indexOf(image) >= 0, () => describe() + ": image identity lost while emitting the second time");
    }
  }
});

test("markdown fuzz: canonical source toggles without rewriting itself", async () => {
  // A document already in the emitter's own dialect is the normal toggle case:
  // entering and leaving with no edits must reproduce the same lines exactly.
  for (let seedIndex = 0; seedIndex < 300; seedIndex += 1) {
    const seed = 0x500000 + seedIndex;
    const random = createRandom(seed);
    const describe = () => "canonical source seed " + seed;
    const blocks = randomRichDocument(random);
    const first = richToSource(blocks).blocks;
    const parsed = sourceToRich(first).blocks;
    const second = richToSource(parsed).blocks;
    assertDeepEqual(sourceTexts(second), sourceTexts(first), () => describe() + ": canonical source was rewritten on a no-op toggle");
    assertEqual(serializeDocument(sourceToRich(second).blocks), serializeDocument(parsed), () => describe() + ": canonical source parse changed");
  }
});

/* --------------------------------------------------------------------------
   5. Caret maps
   -------------------------------------------------------------------------- */

function checkCaretInRange(caret, conversion, blocks, describe) {
  assert(Number.isInteger(caret.block), () => describe() + ": caret block is not an integer: " + JSON.stringify(caret));
  assert(caret.block >= 0 && caret.block < blocks.length, () => describe() + ": caret block out of range: " + JSON.stringify(caret));
  assert(Number.isInteger(caret.offset), () => describe() + ": caret offset is not an integer: " + JSON.stringify(caret));
  const length = blocks[caret.block] && blocks[caret.block].type === "image" ? 0 : blockText(blocks[caret.block]).length;
  assert(caret.offset >= 0 && caret.offset <= length, () => describe() + ": caret offset out of range: " + JSON.stringify(caret) + " block length " + length);
}

function randomCaret(random, blockCount) {
  // Deliberately include values outside the document: the maps must clamp.
  const block = random.chance(0.2) ? random.int(-6, blockCount + 6) : random.int(0, Math.max(0, blockCount - 1));
  const offset = random.chance(0.2) ? random.int(-10, 300) : random.int(0, 40);
  return { block, offset };
}

test("markdown fuzz: caret maps always return in-range positions", async () => {
  // Rich documents in both directions.
  for (let seedIndex = 0; seedIndex < 120; seedIndex += 1) {
    const seed = 0x600000 + seedIndex;
    const random = createRandom(seed);
    const describe = () => "rich caret doc seed " + seed;
    const blocks = randomRichDocument(random);
    const conversion = richToSource(blocks);
    const back = sourceToRich(conversion.blocks);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const richCaret = randomCaret(random, blocks.length);
      const sourceCaret = mapRichCaretToSource(conversion, richCaret);
      checkCaretInRange(sourceCaret, conversion, conversion.blocks, () => describe() + " rich->source " + JSON.stringify(richCaret));
      const backRich = mapSourceCaretToRich(back, sourceCaret);
      checkCaretInRange(backRich, back, back.blocks, () => describe() + " source->rich " + JSON.stringify(sourceCaret));

      const sourceRandom = randomCaret(random, conversion.blocks.length);
      const richRandom = mapSourceCaretToRich(back, sourceRandom);
      checkCaretInRange(richRandom, back, back.blocks, () => describe() + " source->rich random " + JSON.stringify(sourceRandom));
      const sourceBack = mapRichCaretToSource(conversion, richRandom);
      checkCaretInRange(sourceBack, conversion, conversion.blocks, () => describe() + " rich->source random " + JSON.stringify(richRandom));
    }

    // A rich caret on an image lands on the matching source image block, and a
    // source caret on an image lands back on the rich image.
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].type !== "image") {
        continue;
      }
      const sourceCaret = mapRichCaretToSource(conversion, { block: index, offset: 0 });
      assert(conversion.blocks[sourceCaret.block] === blocks[index], () => describe() + ": rich image caret did not land on the source image");
      assertEqual(sourceCaret.offset, 0, () => describe() + ": rich image caret offset");
      const richCaret = mapSourceCaretToRich(back, sourceCaret);
      assert(back.blocks[richCaret.block] === blocks[index], () => describe() + ": source image caret did not land on the rich image");
      assertEqual(richCaret.offset, 0, () => describe() + ": source image caret offset");
    }

    // Every line emitted as inline Markdown (not the HTML escape hatch) maps
    // carets exactly; the escape hatch deliberately maps to the line start.
    for (let index = 0; index < blocks.length; index += 1) {
      const entry = conversion.richLines[index];
      if (!entry || entry.html) {
        continue;
      }
      for (let offset = 0; offset <= blockLength(blocks[index]); offset += 1) {
        const sourceCaret = mapRichCaretToSource(conversion, { block: index, offset });
        const richCaret = mapSourceCaretToRich(back, sourceCaret);
        assertDeepEqual(richCaret, { block: index, offset }, () => describe() + ": inline-Markdown caret did not survive the map for block " + index);
      }
    }
  }

  // Source documents in both directions.
  for (let seedIndex = 0; seedIndex < 120; seedIndex += 1) {
    const seed = 0x610000 + seedIndex;
    const random = createRandom(seed);
    const describe = () => "source caret doc seed " + seed;
    const document = randomSourceDocument(random, seed);
    const parsed = sourceToRich(document);
    const conversion = richToSource(parsed.blocks);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sourceCaret = randomCaret(random, document.length);
      const richCaret = mapSourceCaretToRich(parsed, sourceCaret);
      checkCaretInRange(richCaret, parsed, parsed.blocks, () => describe() + " source->rich " + JSON.stringify(sourceCaret));
      const richRandom = randomCaret(random, parsed.blocks.length);
      const sourceBack = mapRichCaretToSource(conversion, richRandom);
      checkCaretInRange(sourceBack, conversion, conversion.blocks, () => describe() + " rich->source " + JSON.stringify(richRandom));
    }
  }
});

test("markdown fuzz: plain paragraph lines map carets exactly", async () => {
  // The documented exact case: a paragraph emitted as inline Markdown (not the
  // HTML escape hatch) round-trips every caret offset. Text is chosen so every
  // block stays an inline-Markdown line; hard breaks and escaping still occur.
  const PLAIN_ALPHABET = "abcXYZ 012\n.,:;!?-/()'\"";
  const SEEDS = 160;
  for (let seedIndex = 0; seedIndex < SEEDS; seedIndex += 1) {
    const seed = 0x700000 + seedIndex;
    const random = createRandom(seed);
    const describe = () => "plain caret doc seed " + seed;
    const blocks = [];
    const count = random.int(1, 4);
    for (let index = 0; index < count; index += 1) {
      let text = String.fromCharCode(97 + random.int(0, 25)); // a letter: never a marker at the start
      const length = random.int(0, 24);
      for (let character = 0; character < length; character += 1) {
        text += random.char(PLAIN_ALPHABET);
      }
      blocks.push(createBlock("p", [{ text }]));
    }

    const conversion = richToSource(blocks);
    for (let index = 0; index < blocks.length; index += 1) {
      assert(!conversion.richLines[index].html, () => describe() + ": plain paragraph " + index + " used the HTML escape hatch: " + JSON.stringify(sourceTexts(conversion.blocks)));
      for (let offset = 0; offset <= blockLength(blocks[index]); offset += 1) {
        const sourceCaret = mapRichCaretToSource(conversion, { block: index, offset });
        const back = sourceToRich(conversion.blocks);
        const richCaret = mapSourceCaretToRich(back, sourceCaret);
        assertDeepEqual(richCaret, { block: index, offset }, () => describe() + ": rich caret did not survive the map");
      }
    }
  }
});

/* --------------------------------------------------------------------------
   6. Performance report (measurements only, no timing assertions)
   -------------------------------------------------------------------------- */

function minTimeMilliseconds(repetitions, action) {
  let best = Infinity;
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    action();
    const elapsed = performance.now() - started;
    if (elapsed < best) {
      best = elapsed;
    }
  }
  return Math.round(best * 100) / 100;
}

function largeRichDocument() {
  const blocks = [];
  for (let index = 0; blocks.length < 3000; index += 1) {
    const kind = index % 20;
    let block;
    if (kind === 0) {
      block = createBlock("h2", [{ text: "Section " + index }]);
    } else if (kind === 1) {
      block = createBlock("p", [{ text: "text " }, { text: "bold", b: true }, { text: " more" }]);
    } else if (kind === 2) {
      block = createBlock("p", [{ text: "paragraph " + index }, { text: " link", href: "https://example.com/page/" + index }]);
    } else if (kind === 3) {
      block = createBlock("quote", [{ text: "quote " + index }]);
    } else if (kind === 4) {
      block = createBlock("list", [{ text: "item " + index }]);
      block.ordered = false;
      block.depth = index % 3;
    } else if (kind === 5) {
      block = createBlock("list", [{ text: "item " + index }]);
      block.ordered = true;
      block.depth = index % 2;
    } else if (kind === 6) {
      block = createBlock("code", [{ text: "line " + index + "\ncode `x`" + index }]);
    } else if (kind === 7) {
      imageCounter += 1;
      block = {
        id: "perf-image-" + imageCounter,
        type: "image",
        mode: "block",
        x: null,
        y: null,
        src: "data:image/png;base64,AAAA",
        alt: "",
        width: 10,
        height: 10,
        displayWidth: null,
        radius: null,
      };
    } else if (kind === 8) {
      block = createBlock("p", [{ text: "centered " + index }]);
      block.align = "center";
    } else if (kind === 9) {
      block = createBlock("p", [{ text: "right " + index }]);
      block.align = "right";
      block.indent = index % 6;
    } else if (kind === 10) {
      block = createBlock("p", [{ text: "break\nline " + index }]);
    } else if (kind < 15) {
      block = createBlock("p", [{ text: "filler " + index }]);
    } else {
      block = createBlock("p", [{ text: "Paragraph number " + index + " with a few words in it." }]);
    }
    blocks.push(block);
  }
  return blocks;
}

function largeSourceDocument() {
  const blocks = [];
  const payload = "data:image/png;base64,PERFPAYLOAD";
  for (let index = 0; index < 2000; index += 1) {
    const kind = index % 20;
    let text;
    if (kind === 0) {
      text = "# Heading " + index;
    } else if (kind === 1) {
      text = "- item " + index;
    } else if (kind === 2) {
      text = "> quote " + index;
    } else if (kind === 3) {
      text = "Paragraph with **bold** " + index;
    } else if (kind === 4) {
      text = '<p data-align="center">aligned ' + index + "</p>";
    } else if (kind === 5) {
      text = "1. ordered " + index;
    } else {
      text = "plain source line " + index;
    }
    blocks.push(sourceBlock(text));
  }
  imageCounter += 1;
  blocks.splice(1500, 0, {
    id: "perf-source-image-" + imageCounter,
    type: "image",
    mode: "block",
    x: null,
    y: null,
    src: payload,
    alt: "",
    width: 10,
    height: 10,
    displayWidth: null,
    radius: null,
  });
  return blocks;
}

test("markdown fuzz: large-document performance report", async () => {
  const rich = largeRichDocument();
  const richCharacters = documentChars(rich);
  const richToSourceOnce = minTimeMilliseconds(3, () => richToSource(rich));
  const source = richToSource(rich).blocks;
  const sourceCharacters = documentChars(source);
  const sourceToRichOnce = minTimeMilliseconds(3, () => sourceToRich(source));
  const roundTrip = sourceToRich(richToSource(rich).blocks);

  // A conversion this large must still be lossless (this is the property, not
  // the timing).
  assertEqual(serializeDocument(roundTrip.blocks), serializeDocument(rich), "large document round-trips losslessly");

  // markdown-edit.js inspect() runs on every selection change; measure a caret
  // at the very end of a 2000-line source (it classifies the prefix up to the
  // caret) and one at the top, where only one line is classified.
  const sourceDocument = largeSourceDocument();
  const deepSelection = { anchor: { block: 1999, offset: 6 }, focus: { block: 1999, offset: 6 }, collapsed: true };
  const shallowSelection = { anchor: { block: 0, offset: 2 }, focus: { block: 0, offset: 2 }, collapsed: true };
  const deepInspect = inspect(sourceDocument, deepSelection);
  assertEqual(deepInspect.style, "p", "deep inspect returns a paragraph style");
  inspect(sourceDocument, shallowSelection);
  const inspectDeepMs = minTimeMilliseconds(6, () => inspect(sourceDocument, deepSelection));
  const inspectShallowMs = minTimeMilliseconds(6, () => inspect(sourceDocument, shallowSelection));

  // Pathological single lines. The inline parser looks ahead for link labels
  // and urls, so bracket-dense lines are the worst case; measure the scaling
  // (report only) because a pasted line can be far longer than a normal one.
  const lineProbes = {};
  const probeLine = (name, text) => {
    const started = performance.now();
    inlineToRuns(text);
    lineProbes[name] = { chars: text.length, ms: Math.round((performance.now() - started) * 100) / 100 };
  };
  const prose = "the quick brown fox jumps over the lazy dog ".repeat(200);
  probeLine("prose8000", prose.slice(0, 8000));
  for (const size of [2000, 4000, 8000]) {
    probeLine("unmatchedBrackets" + size, "[".repeat(size));
    probeLine("nestedBrackets" + size, "[".repeat(size / 2) + "]".repeat(size / 2));
    probeLine("linkPrefixes" + size, "[x](".repeat(size / 4));
  }
  // Bracket and parenthesis pairing is one pass over the line. Before that it
  // rescanned the rest of the line for every "[", so these probes took 33 ms at
  // 4000 and 135 ms at 8000 characters. Keep the linear behavior guarded.
  for (const name of ["unmatchedBrackets8000", "nestedBrackets8000", "linkPrefixes8000"]) {
    assert(
      lineProbes[name].ms < 50,
      "bracket-dense line " + name + " should parse in linear time, took " + lineProbes[name].ms + " ms",
    );
  }

  const report = {
    richBlocks: rich.length,
    richCharacters,
    sourceLines: source.length,
    sourceCharacters,
    richToSourceMs: richToSourceOnce,
    sourceToRichMs: sourceToRichOnce,
    combinedMs: Math.round((richToSourceOnce + sourceToRichOnce) * 100) / 100,
    sourceDocumentLines: sourceDocument.length,
    inspectDeepMs,
    inspectShallowMs,
    lineProbes,
  };
  const concerns = [];
  if (report.richToSourceMs > 50) concerns.push("richToSource " + report.richToSourceMs + " ms");
  if (report.sourceToRichMs > 50) concerns.push("sourceToRich " + report.sourceToRichMs + " ms");
  if (report.combinedMs > 50) concerns.push("combined conversion " + report.combinedMs + " ms");
  if (report.inspectDeepMs > 50) concerns.push("inspect at a deep caret " + report.inspectDeepMs + " ms");
  for (const [name, probe] of Object.entries(lineProbes)) {
    if (probe.ms > 50) concerns.push(name + " " + probe.ms + " ms");
  }
  console.log("[markdown-fuzz perf] " + JSON.stringify(report));
  console.log(
    "[markdown-fuzz perf] " +
      (concerns.length ? "CONCERN: " + concerns.join(", ") : "no measured operation above the 50 ms concern threshold"),
  );
  window.__markdownFuzzPerf = report;
});

/* --------------------------------------------------------------------------
   Inline parser regressions
   -------------------------------------------------------------------------- */

test("markdown fuzz: an empty-label link stays literal text", async () => {
  // A link needs a label. Before the bracket pairing fix this syntax was
  // consumed and silently produced no runs at all, losing the typed text.
  const text = "[](https://example.com)";
  const runs = inlineToRuns(text);
  assertEqual(runs.length, 1, "empty-label link is one run");
  assertEqual(runs[0].text, text, "empty-label link text is preserved");
  assert(!runs[0].href, "empty-label link is not a link");
});

test("markdown fuzz: bracket-dense text parses as literal text", async () => {
  const text = "[".repeat(4000);
  const runs = inlineToRuns(text);
  assertEqual(runs.length, 1, "unmatched brackets are one run");
  assertEqual(runs[0].text, text, "unmatched brackets are preserved");
});

test("markdown fuzz: a source caret on a picture maps back to the picture", async () => {
  const image = {
    id: "image-map",
    type: "image",
    mode: "block",
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    alt: "",
    width: 10,
    height: 10,
    displayWidth: null,
    radius: null,
  };
  const blocks = [createBlock("p", [{ text: "before" }]), image, createBlock("p", [{ text: "after" }])];
  const conversion = richToSource(blocks);
  const sourceImage = conversion.blocks.findIndex((block) => block.type === "image");
  assert(sourceImage >= 0, "the image is a source block");
  assertEqual(conversion.imageTargets[sourceImage], 1, "imageTargets points at the rich image");
  const caret = mapSourceCaretToRich(conversion, { block: sourceImage, offset: 0 });
  assertEqual(caret.block, 1, "caret maps back to the rich image block");
  assertEqual(caret.offset, 0, "caret offset on the picture");
});
