// Editor tests: layout honesty, caret placement, pointer selection, and typing.
//
// These run inside test/harness.html in a real browser. The layout engine
// measures text with Canvas while the view paints the same text as DOM spans,
// so every assertion here compares the model's idea of a position with the
// pixels the browser actually painted. That is what catches "the caret is in
// the wrong place" bugs that pure model tests cannot see.

import { DocEditor } from "/assets/doc/input.js";
import { transformImage } from "/assets/doc/image.js";
import { buildPdf, roundedRectPath } from "/assets/doc/pdf.js";
import {
  blockEntry,
  cacheImageSize,
  caretPoint,
  ensureFonts,
  fragmentTextWidth,
  pointToOffset,
} from "/assets/doc/layout.js";
import {
  blockLength,
  blockText,
  imageRadius,
  parseDocument,
  serializeDocument,
} from "/assets/doc/model.js";

const root = document.getElementById("editor");
const textarea = document.getElementById("docInput");
const column = document.getElementById("editorColumn");

const tests = [];
const notes = [];
const uncaughtErrors = [];

window.addEventListener("error", (event) => {
  if (event.message) {
    uncaughtErrors.push(event.message);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  uncaughtErrors.push(String(event.reason));
});

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message}: expected ${expected} ± ${tolerance}, got ${Number.isFinite(actual) ? actual.toFixed(2) : actual}`,
    );
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

function raf() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle() {
  await raf();
  await raf();
}

let editor = null;

async function createEditor() {
  editor = new DocEditor({
    root,
    textarea,
    onChange: null,
    onSelection: null,
    onImageSelect: null,
    onImageDragStart: null,
    onSave: null,
    onLink: null,
    onPasteImages: null,
  });
  editor.bind();
  await ensureFonts("Harbour morning light 0123");
  await settle();
}

async function load(html, width) {
  if (width) {
    column.style.width = width + "px";
    await settle();
  }
  editor.setDocument(parseDocument(html));
  await settle();
  return editor;
}

function layout() {
  return editor.layout;
}

function entry(index) {
  return blockEntry(editor.layout, index);
}

function rootRect() {
  return root.getBoundingClientRect();
}

function blockElement(index) {
  return root.querySelectorAll(".doc-content > .doc-block")[index] || null;
}

function lineElement(index, lineIndex) {
  const block = blockElement(index);
  return block ? block.querySelectorAll(":scope > .doc-line")[lineIndex] || null : null;
}

function lineElements(index) {
  const block = blockElement(index);
  return block ? Array.from(block.querySelectorAll(":scope > .doc-line")) : [];
}

function textSpans(index, lineIndex) {
  const line = lineElement(index, lineIndex);
  return line ? Array.from(line.querySelectorAll(".doc-text")) : [];
}

// All painted text of one block, with one line per painted line.
function paintedText(index) {
  return lineElements(index)
    .map((line) => line.textContent)
    .join("\n");
}

function paintedDocumentText() {
  return editor.getDocument().map((block, index) => paintedText(index)).join("\n");
}

function spanTextNode(span) {
  return span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE ? span.firstChild : null;
}

function boundaryForNode(node, cut) {
  const rect = rootRect();
  if (!node) {
    return { x: 0, y: 0 };
  }
  const length = node.length;
  const range = document.createRange();
  const at = Math.max(0, Math.min(length, cut));
  if (at === 0 && length > 0) {
    const first = firstClusterLength(node.data);
    range.setStart(node, 0);
    range.setEnd(node, Math.min(first, length));
    const box = range.getBoundingClientRect();
    return { x: box.left - rect.left, y: box.top - rect.top };
  }
  if (at >= length) {
    range.setStart(node, 0);
    range.setEnd(node, length);
    const box = range.getBoundingClientRect();
    return { x: box.right - rect.left, y: box.top - rect.top };
  }
  range.setStart(node, 0);
  range.setEnd(node, at);
  const box = range.getBoundingClientRect();
  return { x: box.right - rect.left, y: box.top - rect.top };
}

// Where the browser paints the boundary before `cut` UTF-16 units of a span,
// in document coordinates. Range rects are the ground truth: they are what the
// reader sees, independent of Canvas measurement.
function paintedBoundary(span, cut) {
  return boundaryForNode(spanTextNode(span), cut);
}

function firstClusterLength(text) {
  if (window.Intl && Intl.Segmenter) {
    for (const part of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
      return part.segment.length;
    }
  }
  const code = text.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdbff && text.length > 1) {
    return 2;
  }
  return 1;
}

// Which painted span holds a logical block offset, and where inside its text.
function locateOffset(index, offset) {
  const block = entry(index);
  if (!block || block.block.type === "image") {
    return null;
  }
  for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
    const line = block.lines[lineIndex];
    if (!line.fragments.length) {
      continue;
    }
    const first = line.fragments[0];
    const last = line.fragments[line.fragments.length - 1];
    if (offset < first.start || offset > last.end) {
      continue;
    }
    const spans = textSpans(index, lineIndex);
    const codeLine = line.code ? lineElement(index, lineIndex) : null;
    const codeNode = codeLine ? spanTextNode(codeLine) : null;
    for (let fragmentIndex = 0; fragmentIndex < line.fragments.length; fragmentIndex += 1) {
      const fragment = line.fragments[fragmentIndex];
      if (offset <= fragment.end) {
        const cut = Math.max(0, Math.min(fragment.text.length, offset - fragment.start));
        return {
          lineIndex,
          fragmentIndex,
          fragment,
          span: spans[fragmentIndex] || null,
          codeNode: line.code ? codeNode : null,
          cut,
        };
      }
    }
  }
  return null;
}

// The browser's x for a logical offset, or null when the offset has no glyph
// (a hard break or an empty line).
function paintedOffsetX(index, offset) {
  const located = locateOffset(index, offset);
  if (!located) {
    return null;
  }
  if (located.span) {
    return paintedBoundary(located.span, located.cut).x;
  }
  if (located.codeNode) {
    return boundaryForNode(located.codeNode, located.cut).x;
  }
  return null;
}

function pointerOptions(x, y, extra) {
  return Object.assign(
    {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    },
    extra || {},
  );
}

function pointerDown(x, y, extra) {
  const rect = rootRect();
  const target = document.elementFromPoint(rect.left + x, rect.top + y) || root;
  target.dispatchEvent(
    new PointerEvent("pointerdown", pointerOptions(rect.left + x, rect.top + y, extra)),
  );
}

function pointerMove(x, y, extra) {
  const rect = rootRect();
  window.dispatchEvent(
    new PointerEvent("pointermove", pointerOptions(rect.left + x, rect.top + y, extra)),
  );
}

function pointerMoveWithButtons(x, y, buttons) {
  const rect = rootRect();
  window.dispatchEvent(
    new PointerEvent("pointermove", pointerOptions(rect.left + x, rect.top + y, { buttons })),
  );
}

function pointerUp(x, y) {
  const rect = rootRect();
  window.dispatchEvent(
    new PointerEvent("pointerup", pointerOptions(rect.left + (x || 0), rect.top + (y || 0), { buttons: 0 })),
  );
}

function clickAt(x, y) {
  pointerDown(x, y);
  pointerUp(x, y);
}

function dragFromTo(fromX, fromY, toX, toY) {
  pointerDown(fromX, fromY);
  pointerMove(toX, toY);
  pointerUp(toX, toY);
}

function key(name, options) {
  const event = new KeyboardEvent(
    "keydown",
    Object.assign({ key: name, bubbles: true, cancelable: true }, options || {}),
  );
  textarea.dispatchEvent(event);
  return event;
}

function typeInput(text) {
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeText(text) {
  for (const character of Array.from(text)) {
    typeInput(character);
  }
}

function caretLineIndex(index) {
  const point = editor.caretGeometry();
  const block = entry(index);
  return point && block ? block.lines.indexOf(point.line) : -1;
}

/* --------------------------------------------------------------------------
   Layout honesty: every painted fragment must start where layout says it does.
   -------------------------------------------------------------------------- */

function fragmentDrift(index) {
  const block = entry(index);
  const problems = [];
  let worst = 0;
  for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
    const line = block.lines[lineIndex];
    if (!line.fragments.length) {
      continue;
    }
    const rect = rootRect();
    if (line.code) {
      const element = lineElement(index, lineIndex);
      const fragment = line.fragments[0];
      const box = element.getBoundingClientRect();
      const paintedX = box.left - rect.left;
      const leftDrift = paintedX - fragment.x;
      const rightDrift = box.right - rect.left - (fragment.x + fragment.width);
      worst = Math.max(worst, Math.abs(leftDrift), Math.abs(rightDrift));
      if (Math.abs(leftDrift) > 1 || Math.abs(rightDrift) > 1) {
        problems.push(
          `line ${lineIndex} code ${JSON.stringify(fragment.text.slice(0, 24))}: ` +
            `layout ${formatNumber(fragment.x)}..${formatNumber(fragment.x + fragment.width)}, ` +
            `painted ${formatNumber(paintedX)}..${formatNumber(box.right - rect.left)}`,
        );
      }
      continue;
    }
    const spans = textSpans(index, lineIndex);
    for (let fragmentIndex = 0; fragmentIndex < line.fragments.length; fragmentIndex += 1) {
      const fragment = line.fragments[fragmentIndex];
      const span = spans[fragmentIndex];
      if (!span) {
        problems.push(`line ${lineIndex} fragment ${fragmentIndex}: no painted span`);
        continue;
      }
      const box = span.getBoundingClientRect();
      const paintedX = box.left - rect.left;
      const drift = paintedX - fragment.x;
      worst = Math.max(worst, Math.abs(drift));
      if (Math.abs(drift) > 1) {
        problems.push(
          `line ${lineIndex} fragment ${fragmentIndex} (${JSON.stringify(fragment.text.slice(0, 24))}): ` +
            `layout x ${formatNumber(fragment.x)}, painted x ${formatNumber(paintedX)}, drift ${formatNumber(drift)}`,
        );
      }
      const lineRight = line.fragments[line.fragments.length - 1];
      if (fragmentIndex === line.fragments.length - 1) {
        const paintedRight = box.right - rect.left;
        const layoutRight = lineRight.x + fragmentWidth(lineRight);
        const rightDrift = paintedRight - layoutRight;
        worst = Math.max(worst, Math.abs(rightDrift));
        if (Math.abs(rightDrift) > 1) {
          problems.push(
            `line ${lineIndex} end: layout ${formatNumber(layoutRight)}, painted ${formatNumber(paintedRight)}, drift ${formatNumber(rightDrift)}`,
          );
        }
      }
    }
  }
  return { worst, problems };
}

function fragmentWidth(fragment) {
  // Mirrors layout.fragmentTextWidth for the whole fragment text.
  let spaces = 0;
  for (let index = 0; index < fragment.text.length; index += 1) {
    if (fragment.text[index] === " ") {
      spaces += 1;
    }
  }
  return fragment.width + (fragment.spaceExtra || 0) * spaces;
}

/* --------------------------------------------------------------------------
   Tests
   -------------------------------------------------------------------------- */

test("layout: painted fragments match measured positions", async () => {
  await load(
    "<p>The harbour lights came on one by one, and the water held them.</p>" +
      "<h1>A long heading that carries a good number of letters</h1>" +
      "<h2>A second heading of a similar length for measurement</h2>" +
      "<h3>A third heading of a similar length for measurement</h3>" +
      "<h4>A fourth heading of a similar length for measurement</h4>" +
      "<h1>Heading with <b>bold</b> and <i>italic</i> and <code>code</code> bits</h1>" +
      "<p>Before <b>bold words</b> and <i>italic words</i> and <code>some_code()</code> after.</p>" +
      "<blockquote>A quoted line of prose that is long enough to wrap once.</blockquote>" +
      "<ul><li>A list item that keeps going for long enough to wrap around.</li></ul>" +
      "<pre>const value = measure(text, font);\n  return value + 1;</pre>",
  );

  const failures = [];
  const report = [];
  for (let index = 0; index < editor.getDocument().length; index += 1) {
    const block = editor.getDocument()[index];
    if (block.type === "image") {
      continue;
    }
    const drift = fragmentDrift(index);
    report.push(`${block.type}: max drift ${formatNumber(drift.worst)} px`);
    if (drift.problems.length) {
      failures.push(...drift.problems.map((problem) => `${block.type} ${problem}`));
    }
  }
  notes.push(...report);
  assert(!failures.length, failures.slice(0, 12).join("\n"));
});

test("caret: every offset sits on the painted glyph edge", async () => {
  await load(
    "<p>Harbour light, twenty-one boats.</p>" +
      "<h1>A heading with letter spacing</h1>" +
      "<h1>Heading with <b>bold</b> and <i>italic</i> and <code>code</code> bits</h1>" +
      "<p>Mixed <b>bold text</b> and <i>italic text</i> and <code>code_span</code>.</p>" +
      "<blockquote>A quoted sentence that wraps over two lines when the paper is narrow enough to wrap it.</blockquote>",
  );

  const failures = [];
  for (let index = 0; index < editor.getDocument().length; index += 1) {
    const block = editor.getDocument()[index];
    if (block.type === "image") {
      continue;
    }
    const length = blockLength(block);
    const text = blockText(block);
    for (let offset = 0; offset <= length; offset += 1) {
      if (text[offset - 1] === "\n" || text[offset] === "\n") {
        continue;
      }
      const point = caretPoint(entry(index), offset);
      const painted = paintedOffsetX(index, offset);
      if (!point || painted === null) {
        continue;
      }
      if (Math.abs(point.x - painted) > 1.5) {
        failures.push(
          `${block.type} offset ${offset} ` +
            `(${JSON.stringify(text.slice(Math.max(0, offset - 8), offset + 8))}): ` +
            `caret x ${formatNumber(point.x)}, painted x ${formatNumber(painted)}, ` +
            `drift ${formatNumber(point.x - painted)}`,
        );
      }
    }
  }
  assert(!failures.length, failures.slice(0, 15).join("\n"));
});

test("pointer: clicking a painted letter boundary puts the caret there", async () => {
  const html =
    "<p>alpha beta gamma delta epsilon</p>" +
    "<h1>Heading boundaries are painted glyph boundaries</h1>" +
    "<h2>Another heading with many letters to measure</h2>" +
    "<p>Before <b>bold words</b> after them.</p>" +
    "<ul><li>A list item with several words to click.</li></ul>" +
    "<blockquote>A quoted line with several words.</blockquote>";
  await load(html);

  const failures = [];
  for (let index = 0; index < editor.getDocument().length; index += 1) {
    const block = editor.getDocument()[index];
    if (block.type === "image") {
      continue;
    }
    const text = blockText(block);
    for (let offset = 1; offset < text.length; offset += 1) {
      if (text[offset] === "\n" || text[offset - 1] === "\n") {
        continue;
      }
      // Only probe word starts, where a caret boundary is unambiguous.
      if (!/[A-Za-z]/.test(text[offset]) || /[A-Za-z0-9]/.test(text[offset - 1] || "")) {
        continue;
      }
      const painted = paintedOffsetX(index, offset);
      const point = caretPoint(entry(index), offset);
      if (painted === null || !point) {
        continue;
      }
      clickAt(painted + 0.4, point.y + point.height / 2);
      const selection = editor.getSelection();
      if (selection.focus.block !== index || selection.focus.offset !== offset) {
        failures.push(
          `${block.type} click at x ${formatNumber(painted + 0.4)} y ${formatNumber(point.y + point.height / 2)} ` +
            `for offset ${offset} (${JSON.stringify(text.slice(Math.max(0, offset - 12), offset + 12))}) ` +
            `selected ${selection.focus.block}:${selection.focus.offset}`,
        );
      }
    }
  }
  assert(!failures.length, failures.slice(0, 12).join("\n"));
});

test("selection: dragging over a word selects exactly that word", async () => {
  await load("<p>one two three four five six seven eight nine ten eleven twelve</p>");

  const text = blockText(editor.getDocument()[0]);
  const failures = [];
  for (const word of ["two", "four", "six", "eight", "ten", "twelve"]) {
    const start = text.indexOf(word);
    const end = start + word.length;
    const from = paintedOffsetX(0, start);
    const to = paintedOffsetX(0, end);
    const fromPoint = caretPoint(entry(0), start);
    const toPoint = caretPoint(entry(0), end);
    if (from === null || to === null || !fromPoint || !toPoint) {
      failures.push(`no painted position for ${word}`);
      continue;
    }
    dragFromTo(from + 0.5, fromPoint.y + fromPoint.height / 2, to - 0.5, toPoint.y + toPoint.height / 2);
    const selection = editor.getSelection();
    if (editor.selectionText() !== word) {
      failures.push(
        `drag over ${JSON.stringify(word)} selected ${JSON.stringify(editor.selectionText())} ` +
          `(${selection.anchor.block}:${selection.anchor.offset}→${selection.focus.block}:${selection.focus.offset})`,
      );
    }
  }
  assert(!failures.length, failures.join("\n"));
});

test("writing: every typed character, including repeated spaces, is painted", async () => {
  await load("<p></p>");
  typeText("one  two   three \ttab");
  const text = blockText(editor.getDocument()[0]);
  assertEqual(text, "one  two   three \ttab", "model text after typing");
  const painted = paintedText(0);
  assertEqual(painted, text, "painted text after typing");
});

test("writing: a typed space advances the caret", async () => {
  await load("<p></p>");
  typeText("hello");
  const before = editor.caretGeometry();
  typeText(" ");
  const after = editor.caretGeometry();
  assert(before && after, "caret geometry exists while typing");
  const advanced = after.x - before.x;
  assert(
    advanced > 3 && advanced < 20,
    `space should advance the caret by a space width, advanced ${formatNumber(advanced)} px`,
  );
  assertEqual(blockText(editor.getDocument()[0]), "hello ", "model text");
  assertEqual(paintedText(0), "hello ", "painted text");
});

test("writing: tabs keep their painted advance and caret position", async () => {
  await load("<p></p>");
  editor.insertText("a\tb");
  assertEqual(blockText(editor.getDocument()[0]), "a\tb", "model keeps the tab");
  assertEqual(paintedText(0), "a\tb", "painted text keeps the tab");

  const tabEnd = "a\t".length;
  const point = caretPoint(entry(0), tabEnd);
  const painted = paintedOffsetX(0, tabEnd);
  assert(painted !== null, "tab boundary is painted");
  assertClose(point.x, painted, 1.5, "caret after a tab matches the painted tab stop");

  clickAt(painted + 0.5, point.y + point.height / 2);
  assertEqual(editor.getSelection().focus.offset, tabEnd, "clicking after the tab maps to its offset");
});

test("writing: code blocks keep tab indentation and caret positions", async () => {
  await load("<pre>if (a) {\n\treturn b;\n}</pre>");
  const block = entry(0);
  assertEqual(block.lines.length, 3, "three code lines");
  const line = block.lines[1];
  assertEqual(line.text, "\treturn b;", "the tab is painted");
  const offsets = [line.offsetStart, line.offsetStart + 1, line.offsetStart + 7];
  for (const offset of offsets) {
    const point = caretPoint(block, offset);
    const painted = paintedOffsetX(0, offset);
    assert(point && painted !== null, `caret and paint exist at code offset ${offset}`);
    assertClose(point.x, painted, 1.5, `caret at code offset ${offset}`);
  }
});

test("writing: emoji and combining marks are one caret step", async () => {
  await load("<p></p>");
  typeText("hi \u{1f600} there");
  const text = blockText(editor.getDocument()[0]);
  assertEqual(text, "hi \u{1f600} there", "model keeps the emoji");
  assertEqual(paintedText(0), text, "painted text keeps the emoji");

  const emojiStart = "hi ".length;
  const emojiEnd = emojiStart + 2;
  const before = caretPoint(entry(0), emojiStart);
  const after = caretPoint(entry(0), emojiEnd);
  const paintedAfter = paintedOffsetX(0, emojiEnd);
  assert(after.x > before.x, "the emoji advances the caret");
  assertClose(after.x, paintedAfter, 2, "caret after the emoji matches its painted edge");

  editor.collapseTo({ block: 0, offset: emojiEnd });
  editor.sync();
  editor.backspace();
  assertEqual(blockText(editor.getDocument()[0]), "hi  there", "backspace removes the whole emoji");

  await load("<p></p>");
  typeText("cafe\u0301 au lait");
  const composed = blockText(editor.getDocument()[0]);
  assertEqual(composed, "cafe\u0301 au lait", "model keeps the combining mark");
  assertEqual(paintedText(0), composed, "painted text keeps the combining mark");
  const markEnd = "cafe\u0301".length;
  const markPoint = caretPoint(entry(0), markEnd);
  const markPainted = paintedOffsetX(0, markEnd);
  assertClose(markPoint.x, markPainted, 2, "caret after a combining cluster");
  editor.collapseTo({ block: 0, offset: markEnd });
  editor.sync();
  editor.backspace();
  assertEqual(blockText(editor.getDocument()[0]), "caf au lait", "backspace removes the whole cluster");
});

test("alignment: carets and clicks follow centered, right, and justified text", async () => {
  const html =
    '<p data-align="center">Centered words in a line that is long enough to wrap around the paper width.</p>' +
    '<p data-align="right">Right aligned words in a line that is long enough to wrap around the paper width.</p>' +
    '<p data-align="justify">Justified words in a paragraph that has enough words to fill several wrapped lines and stretch the spaces between them until the right edge is reached.</p>' +
    '<p data-align="justify" data-indent="2">An indented justified paragraph with enough words to wrap at least once across the page width.</p>';
  await load(html);
  for (let index = 0; index < editor.getDocument().length; index += 1) {
    const block = entry(index);
    const text = blockText(block.block);
    for (let offset = 1; offset < text.length; offset += 1) {
      if (!/[A-Za-z]/.test(text[offset]) || /[A-Za-z0-9]/.test(text[offset - 1] || "")) {
        continue;
      }
      const painted = paintedOffsetX(index, offset);
      const point = caretPoint(block, offset);
      if (painted === null || !point) {
        continue;
      }
      if (painted >= rootRect().width - 1) {
        // A hanging trailing space is painted past the paper edge; the browser
        // cannot click there.
        continue;
      }
      const clickX = painted + 0.4;
      const clickY = point.y + point.height / 2;
      clickAt(clickX, clickY);
      const selection = editor.getSelection();
      if (selection.focus.offset !== offset) {
        const line = point.line;
        const lineIndex = block.lines.indexOf(line);
        const details = block.lines
          .map(
            (entryLine, entryIndex) =>
              `line ${entryIndex} y=${formatNumber(entryLine.y)} x=${formatNumber(entryLine.x)} ` +
              `content=${formatNumber(entryLine.contentWidth)} offsets=${entryLine.offsetStart}..${entryLine.offsetEnd} ` +
              `frags=${entryLine.fragments
                .map(
                  (fragment) =>
                    `${JSON.stringify(fragment.text.slice(0, 12))}@${formatNumber(fragment.x)}+${formatNumber(fragment.width)}s${formatNumber(fragment.spaceExtra || 0)}`,
                )
                .join("|")}`,
          )
          .join("\n");
        throw new Error(
          `block ${index} (${block.block.align}) click at painted ${formatNumber(painted)} y ${formatNumber(point.y)} ` +
            `for offset ${offset} landed on ${selection.focus.offset} in line ${lineIndex}\n` +
            `fragment start/end ${line.fragments[0].start}..${line.fragments[0].end} ` +
            `textLength ${line.fragments[0].text.length} ` +
            `caretX ${formatNumber(caretPoint(block, offset).x)} ` +
            `paintedX ${formatNumber(paintedOffsetX(index, offset))} ` +
            `direct ${pointToOffset(block, painted + 0.4, point.y + 1)}\n${details}`,
        );
      }
    }
  }
});

test("pointer: releasing outside the window does not leave a drag active", async () => {
  await load("<p>alpha beta gamma delta</p>");
  const text = blockText(editor.getDocument()[0]);
  const start = text.indexOf("beta");
  const end = start + "beta".length;
  const from = paintedOffsetX(0, start);
  const to = paintedOffsetX(0, end);
  const a = caretPoint(entry(0), start);
  const b = caretPoint(entry(0), end);
  pointerDown(from + 0.5, a.y + a.height / 2);
  pointerMove(to - 0.5, b.y + b.height / 2);
  pointerMoveWithButtons(to + 60, b.y + b.height / 2, 0);
  const afterRelease = editor.selectionText();
  pointerMove(from + 0.5, a.y + a.height / 2);
  assertEqual(editor.selectionText(), afterRelease, "further moves do not extend the finished drag");
  assertEqual(afterRelease, "beta", "the drag selected the word");
});

test("pointer: selection can cross wrapped lines and paragraphs", async () => {
  await load(
    "<p>First paragraph with enough words to wrap across the paper width when the line is measured.</p>" +
      "<p></p>" +
      "<p>Second paragraph that also runs long enough to wrap somewhere in the middle of its text.</p>",
  );
  const first = entry(0);
  assert(first.lines.length >= 2, "first paragraph wraps");
  const last = entry(2);
  const start = first.lines[0].fragments[0].start + 6;
  const end = last.lines[last.lines.length - 1].offsetEnd;
  const from = paintedOffsetX(0, start);
  const to = paintedOffsetX(2, end);
  const a = caretPoint(first, start);
  const b = caretPoint(last, end);
  dragFromTo(from + 0.5, a.y + a.height / 2, to - 0.5, b.y + b.height / 2);
  const selection = editor.getSelection();
  assertEqual(selection.anchor.block, 0, "anchor block");
  assertEqual(selection.focus.block, 2, "focus block");
  const selected = editor.selectionText();
  assert(
    selected.startsWith("paragraph"),
    `selection starts at the drag anchor, got ${JSON.stringify(selected.slice(0, 40))}`,
  );
  assert(selected.includes("Second paragraph"), "selection reaches the second paragraph");
  const rects = root.querySelectorAll(".doc-selection");
  assert(rects.length >= 3, "selection paints every selected line and paragraph");
});

test("pointer: double-click selects the word under the pointer", async () => {
  await load("<p>Punctuation, attached to words; don't split them.</p>");
  const text = blockText(editor.getDocument()[0]);
  const word = "attached";
  const start = text.indexOf(word);
  const at = paintedOffsetX(0, start + 2);
  const point = caretPoint(entry(0), start + 2);
  const target = document.elementFromPoint(
    rootRect().left + at,
    rootRect().top + point.y + point.height / 2,
  );
  target.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      clientX: rootRect().left + at,
      clientY: rootRect().top + point.y + point.height / 2,
    }),
  );
  assertEqual(editor.selectionText(), word, "double-click selects the whole word");
});

test("undo: typing over a selection is one undo step", async () => {
  await load("<p>hello world</p>");
  const text = blockText(editor.getDocument()[0]);
  const start = text.indexOf("world");
  editor.setSelection({ block: 0, offset: start }, { block: 0, offset: text.length });
  editor.sync();
  typeText("there");
  assertEqual(blockText(editor.getDocument()[0]), "hello there", "selection replaced by typing");
  editor.undo();
  assertEqual(blockText(editor.getDocument()[0]), "hello world", "one undo restores the replaced text");
  editor.redo();
  assertEqual(blockText(editor.getDocument()[0]), "hello there", "redo brings the replacement back");
});

test("undo: Enter over a selection is one undo step", async () => {
  await load("<p>hello world</p>");
  const text = blockText(editor.getDocument()[0]);
  editor.setSelection({ block: 0, offset: 6 }, { block: 0, offset: text.length });
  editor.sync();
  key("Enter");
  assertEqual(editor.getDocument().length, 2, "Enter splits the paragraph");
  assertEqual(blockText(editor.getDocument()[0]), "hello ", "text before the break");
  editor.undo();
  assertEqual(editor.getDocument().length, 1, "one undo restores one paragraph");
  assertEqual(blockText(editor.getDocument()[0]), "hello world", "one undo restores the text");
});

test("caret: scrolling keeps the caret in the viewport", async () => {
  const paragraphs = [];
  for (let index = 0; index < 40; index += 1) {
    paragraphs.push(`<p>Paragraph number ${index} with a line of ordinary words in it.</p>`);
  }
  await load(paragraphs.join(""));
  window.scrollTo(0, 0);
  editor.focusEditor();
  const lastIndex = editor.getDocument().length - 1;
  editor.collapseTo({ block: lastIndex, offset: 0 });
  editor.sync();
  editor.insertText("x");
  const point = editor.caretGeometry();
  const rect = rootRect();
  const viewportTop = rect.top + point.y;
  assert(
    window.scrollY > 0,
    `typing at the end scrolls the page (scrollY ${window.scrollY}, ` +
      `scrollHeight ${document.scrollingElement.scrollHeight}, innerHeight ${window.innerHeight}, ` +
      `layout height ${formatNumber(layout().height)}, viewport caret ${formatNumber(viewportTop)}, ` +
      `focused ${editor.focused}, view caret ${Boolean(editor.view.caretPoint)}, ` +
      `activeElement ${document.activeElement && document.activeElement.id})`,
  );
  assert(
    viewportTop >= 0 && viewportTop + point.height <= window.innerHeight,
    `caret stays inside the viewport: ${formatNumber(viewportTop)}..${formatNumber(viewportTop + point.height)} of ${window.innerHeight}`,
  );
  window.scrollTo(0, 0);
  await settle();
});

test("keyboard: Page Up and Page Down move the caret a screen at a time", async () => {
  const paragraphs = [];
  for (let index = 0; index < 60; index += 1) {
    paragraphs.push(`<p>Paragraph number ${index} with a line of ordinary words.</p>`);
  }
  await load(paragraphs.join(""));
  // The page's smooth scrolling would make every measurement below read a
  // position that is still animating towards its destination.
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  scrollToTop();
  editor.focusEditor();
  editor.moveToDocumentEdge(true);
  await settle();

  const before = editor.caretGeometry();
  const viewportBefore = rootRect().top + before.y;
  const pageDown = key("PageDown");
  await settle();
  assert(pageDown.defaultPrevented, "PageDown does not fall through to the browser");
  assert(window.scrollY > 0, "PageDown scrolls the page");
  assert(editor.getSelection().focus.block > 0, "PageDown moves the caret down the document");
  const after = editor.caretGeometry();
  assertClose(rootRect().top + after.y, viewportBefore, 1, "the caret keeps its place on screen");

  scrollToTop();
  await settle();
  editor.moveToDocumentEdge(true);
  await settle();
  key("PageDown", { shiftKey: true });
  await settle();
  const selection = editor.getSelection();
  assert(!selection.collapsed, "Shift+PageDown extends the selection");
  assertEqual(selection.anchor.block, 0, "the selection starts where it was");
  assert(selection.focus.block > 0, "the selection reaches down the page");

  scrollToTop();
  await settle();
  editor.moveToDocumentEdge(true);
  await settle();
  key("PageDown");
  await settle();
  const pageUp = key("PageUp");
  await settle();
  assert(pageUp.defaultPrevented, "PageUp is handled by the editor");
  assertEqual(editor.getSelection().focus.block, 0, "PageUp returns to the start");
  assertEqual(window.scrollY, 0, "PageUp scrolls back to the top");

  scrollToTop();
  await settle();
});

test("keyboard: Page Down steps over pictures and tall blocks", async () => {
  const dot =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const parts = [];
  for (let index = 0; index < 20; index += 1) {
    parts.push(`<p>Above paragraph ${index} with a line of ordinary words.</p>`);
  }
  parts.push(`<img src="${dot}" width="80" height="60" alt="Dot">`);
  parts.push("<pre>" + Array.from({ length: 8 }, (_, line) => "code line " + line).join("\n") + "</pre>");
  for (let index = 0; index < 20; index += 1) {
    parts.push(`<p>Below paragraph ${index} with a line of ordinary words.</p>`);
  }
  await load(parts.join(""));
  window.scrollTo({ top: 0, behavior: "instant" });
  editor.focusEditor();
  editor.moveToDocumentEdge(true);
  await settle();

  let previous = 0;
  for (let press = 0; press < 8; press += 1) {
    key("PageDown");
    await settle();
    const focus = editor.getSelection().focus;
    assert(editor.getDocument()[focus.block].type !== "image", "PageDown never lands on a picture");
    assert(editor.caretGeometry(), "the caret has a painted position after every page");
    assert(focus.block >= previous, "PageDown never goes back up the document");
    previous = focus.block;
  }
  assert(previous > 20, "pages reach the text below the picture");

  window.scrollTo({ top: 0, behavior: "instant" });
  await settle();
});

test("keyboard: Page Down and Page Up stop at the very ends of the text", async () => {
  await load("<p>first paragraph</p><p>second paragraph</p><p>last paragraph</p>");
  window.scrollTo({ top: 0, behavior: "instant" });
  editor.focusEditor();
  editor.moveToDocumentEdge(true);
  await settle();

  key("PageDown");
  await settle();
  let focus = editor.getSelection().focus;
  assertEqual(focus.block, 2, "Page Down reaches the last paragraph");
  assertEqual(focus.offset, "last paragraph".length, "Page Down lands after the last character");

  key("PageUp");
  await settle();
  focus = editor.getSelection().focus;
  assertEqual(focus.block, 0, "Page Up reaches the first paragraph");
  assertEqual(focus.offset, 0, "Page Up lands before the first character");

  editor.collapseTo({ block: 1, offset: 7 });
  editor.sync();
  key("End", { ctrlKey: true, shiftKey: true });
  await settle();
  assert(!editor.isCollapsed(), "Ctrl+Shift+End extends the selection");
  assertEqual(editor.getSelection().focus.block, 2, "Ctrl+Shift+End reaches the last block");
  assertEqual(
    editor.getSelection().focus.offset,
    "last paragraph".length,
    "Ctrl+Shift+End reaches the end of the text",
  );

  key("Home", { ctrlKey: true, shiftKey: true });
  await settle();
  assertEqual(editor.getSelection().focus.block, 0, "Ctrl+Shift+Home reaches the first block");
  assertEqual(editor.getSelection().focus.offset, 0, "Ctrl+Shift+Home reaches the beginning");

  window.scrollTo({ top: 0, behavior: "instant" });
  await settle();
});

test("caret: vertical geometry matches every painted line", async () => {
  await load(
    "<h1>A heading line</h1><p>An ordinary paragraph of prose.</p>" +
      '<blockquote data-align="center">A centered quote line.</blockquote>' +
      '<p data-align="right">A right aligned paragraph line.</p>' +
      '<ul><li data-indent="1">An indented list item.</li></ul>' +
      "<pre>const code = true;</pre>",
  );
  for (let index = 0; index < editor.getDocument().length; index += 1) {
    const block = entry(index);
    if (block.block.type === "image") {
      continue;
    }
    for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
      const line = block.lines[lineIndex];
      const point = caretPoint(block, line.offsetStart, line);
      assert(point, `caret exists at ${index}:${lineIndex}`);
      assertClose(point.y, line.y, 0.01, `caret y at ${index}:${lineIndex}`);
      assertClose(point.height, line.height, 0.01, `caret height at ${index}:${lineIndex}`);
      const element = lineElement(index, lineIndex);
      const box = element.getBoundingClientRect();
      const rect = rootRect();
      assertClose(box.top - rect.top, line.y, 0.5, `painted line top at ${index}:${lineIndex}`);
      assertClose(box.height, line.height, 0.5, `painted line height at ${index}:${lineIndex}`);
    }
  }
});

test("keyboard: Home and End work inside a wrapped line", async () => {
  await load(
    "<p>Wrapping prose puts several words on the first painted line and several more on the second.</p>",
  );
  const block = entry(0);
  assert(block.lines.length >= 2, "paragraph wraps");
  const second = block.lines[1];
  const offset = second.offsetStart + 4;
  editor.collapseTo({ block: 0, offset });
  editor.sync();
  key("Home");
  assertEqual(editor.getSelection().focus.offset, second.offsetStart, "Home goes to the wrapped line start");
  const point = editor.caretGeometry();
  assert(point && point.line === second, "caret stays on the wrapped line after Home");
  key("End");
  assertEqual(editor.getSelection().focus.offset, second.offsetEnd, "End goes to the wrapped line end");
  const endPoint = editor.caretGeometry();
  assert(endPoint && endPoint.line === second, "caret stays on the wrapped line after End");
  key("ArrowUp");
  key("Home");
  assertEqual(editor.getSelection().focus.block, 0, "still in the paragraph");
});

test("keyboard: Home and End keep the offset of an empty hard-break line", async () => {
  await load("<p>first\nsecond\n\nfourth</p>");
  editor.collapseTo({ block: 0, offset: "first\nsecond\n".length });
  editor.sync();
  key("Home");
  assertEqual(editor.getSelection().focus.offset, "first\nsecond\n".length, "Home stays on the empty line");
  key("End");
  assertEqual(editor.getSelection().focus.offset, "first\nsecond\n".length, "End stays on the empty line");
  const point = editor.caretGeometry();
  assert(point && point.line === entry(0).lines[2], "the caret remains on the empty line");
});

test("keyboard: backspace joins paragraphs, Delete joins forward", async () => {
  await load("<p>alpha</p><p>beta</p>");
  editor.collapseTo({ block: 1, offset: 0 });
  editor.sync();
  editor.backspace();
  assertEqual(editor.getDocument().length, 1, "backspace merges the second paragraph");
  assertEqual(blockText(editor.getDocument()[0]), "alphabeta", "text joined");
  assertEqual(editor.getSelection().focus.offset, "alpha".length, "caret between the joined words");
  const point = editor.caretGeometry();
  assert(point && point.line === entry(0).lines[0], "caret is painted on the joined line");

  editor.undo();
  assertEqual(editor.getDocument().length, 2, "undo restores both paragraphs");

  editor.collapseTo({ block: 0, offset: "alpha".length });
  editor.sync();
  editor.deleteForward();
  assertEqual(editor.getDocument().length, 1, "Delete merges the next paragraph");
  assertEqual(blockText(editor.getDocument()[0]), "alphabeta", "text joined forward");
  assertEqual(editor.getSelection().focus.offset, "alpha".length, "caret stays at the join");
  editor.undo();
  assertEqual(editor.getDocument().length, 2, "undo restores the forward join");
});

test("keyboard: arrows move between blocks and skip images", async () => {
  await load(
    '<p>First block line.</p><img width="80" height="60" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="><p>Third block line.</p>',
  );
  editor.collapseTo({ block: 0, offset: 0 });
  editor.sync();
  key("ArrowDown");
  assertEqual(editor.getSelection().focus.block, 2, "ArrowDown skips the image block");
  key("ArrowUp");
  assertEqual(editor.getSelection().focus.block, 0, "ArrowUp skips the image block");
});

test("writing: multiline paste stays inside one code block", async () => {
  await load("<pre>start</pre>");
  editor.collapseTo({ block: 0, offset: "start".length });
  editor.sync();
  editor.insertText("\nconst x = 1;\nconst y = 2;");
  assertEqual(editor.getDocument().length, 1, "one code block after pasting lines");
  assertEqual(
    blockText(editor.getDocument()[0]),
    "start\nconst x = 1;\nconst y = 2;",
    "the newlines stay in the code block",
  );
  assertEqual(
    paintedText(0),
    "start\nconst x = 1;\nconst y = 2;",
    "all pasted code lines are painted",
  );
});

test("formatting: marks apply to the exact selection and typing keeps a pending mark", async () => {
  await load("<p>plain words here</p>");
  const start = "plain ".length;
  editor.setSelection({ block: 0, offset: start }, { block: 0, offset: start + "words".length });
  editor.sync();
  key("b", { ctrlKey: true });
  let runs = editor.getDocument()[0].runs;
  const boldRun = runs.find((run) => run.b);
  assert(boldRun && boldRun.text === "words", `bold run covers exactly the selection: ${JSON.stringify(runs)}`);
  assertEqual(blockText(editor.getDocument()[0]), "plain words here", "text unchanged");

  editor.collapseTo({ block: 0, offset: 0 });
  editor.sync();
  key("i", { ctrlKey: true });
  typeText("very ");
  runs = editor.getDocument()[0].runs;
  assert(runs[0].i && runs[0].text === "very ", `pending italic applies to typing: ${JSON.stringify(runs)}`);
  key("i", { ctrlKey: true });
  typeText("plain");
  const runsAfter = editor.getDocument()[0].runs;
  assert(
    runsAfter.some((run) => run.text.includes("plain") && !run.i),
    `toggling italic off stops the mark: ${JSON.stringify(runsAfter)}`,
  );
  assertEqual(
    blockText(editor.getDocument()[0]),
    "very plainplain words here",
    "the typed words and the original text are all present",
  );
});

test("images: dragging and resizing the selected image can be undone", async () => {
  const src =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  cacheImageSize(src, { width: 200, height: 150 });
  await load("<p>text</p>");
  editor.insertImage({
    type: "image",
    mode: "block",
    src,
    alt: "Dot",
    width: 200,
    height: 150,
  });
  const index = editor.getDocument().findIndex((block) => block.type === "image");
  let imageEntry = editor.entryFor(index);
  clickAt(imageEntry.image.x + 20, imageEntry.image.y + 20);
  assertEqual(editor.getSelection().focus.block, index, "image selected for dragging");

  const start = { ...imageEntry.image };
  pointerDown(start.x + 30, start.y + 30);
  pointerMove(start.x + 80, start.y + 70);
  pointerUp(start.x + 80, start.y + 70);
  imageEntry = editor.entryFor(index);
  assertEqual(imageEntry.block.mode, "free", "dragging turns the image free");
  assertClose(imageEntry.image.x, start.x + 50, 1, "dragged x");
  assertClose(imageEntry.image.y, start.y + 40, 1, "dragged y");
  editor.undo();
  assertEqual(editor.getDocument()[index].mode, "block", "undo restores the block mode");
  assertClose(editor.entryFor(index).image.x, start.x, 1, "undo restores the position");

  imageEntry = editor.entryFor(index);
  assertEqual(editor.getSelection().focus.block, index, "the image is still selected after undo");
  const handle = root.querySelector('.doc-resize-handle[data-corner="se"]');
  assert(handle, "the selected image shows resize handles");
  const delta = 60;
  const pointerX = imageEntry.image.x + imageEntry.image.width + delta;
  const pointerY = imageEntry.image.y + imageEntry.image.height + delta;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: rootRect().left + imageEntry.image.x + imageEntry.image.width,
      clientY: rootRect().top + imageEntry.image.y + imageEntry.image.height,
      button: 0,
      buttons: 1,
      pointerId: 2,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  pointerMove(pointerX, pointerY);
  pointerUp(pointerX, pointerY);
  imageEntry = editor.entryFor(index);
  assertClose(imageEntry.block.displayWidth, start.width + delta, 2, "resized width stored");
  assertEqual(imageEntry.block.mode, "free", "resizing turns the image free");
  editor.undo();
  assertEqual(
    editor.getDocument()[index].displayWidth,
    undefined,
    "undo removes the stored display width",
  );
});

test("images: holding Shift while dragging locks the move to one axis", async () => {
  const src =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  cacheImageSize(src, { width: 200, height: 150 });
  await load("<p>text</p>");
  editor.insertImage({
    type: "image",
    mode: "block",
    src,
    alt: "Dot",
    width: 200,
    height: 150,
  });
  const index = editor.getDocument().findIndex((block) => block.type === "image");
  let imageEntry = editor.entryFor(index);
  const start = { ...imageEntry.image };

  // Shift on the press: the pointer set off sideways, so the image follows it
  // horizontally and keeps its top.
  pointerDown(start.x + 30, start.y + 30, { shiftKey: true });
  pointerMove(start.x + 110, start.y + 60, { shiftKey: true });
  pointerUp(start.x + 110, start.y + 60);
  imageEntry = editor.entryFor(index);
  assertEqual(imageEntry.block.mode, "free", "the Shift drag still turns the image free");
  assertClose(imageEntry.image.x, start.x + 80, 1, "horizontal Shift drag follows x");
  assertClose(imageEntry.image.y, start.y, 1, "horizontal Shift drag keeps y");

  // The same gesture the other way locks to the vertical axis.
  const second = { ...imageEntry.image };
  pointerDown(second.x + 30, second.y + 30, { shiftKey: true });
  pointerMove(second.x + 40, second.y + 110, { shiftKey: true });
  pointerUp(second.x + 40, second.y + 110);
  imageEntry = editor.entryFor(index);
  assertClose(imageEntry.image.x, second.x, 1, "vertical Shift drag keeps x");
  assertClose(imageEntry.image.y, second.y + 80, 1, "vertical Shift drag follows y");

  // Releasing Shift lets the image drift on both axes again.
  const third = { ...imageEntry.image };
  pointerDown(third.x + 30, third.y + 30, { shiftKey: true });
  pointerMove(third.x + 70, third.y + 35, { shiftKey: true });
  pointerMove(third.x + 75, third.y + 65);
  pointerUp(third.x + 75, third.y + 65);
  imageEntry = editor.entryFor(index);
  assertClose(imageEntry.image.x, third.x + 45, 1, "released Shift frees x");
  assertClose(imageEntry.image.y, third.y + 35, 1, "released Shift frees y");

  // Shift without movement is still the extend-selection click it used to be.
  const textIndex = editor.getDocument().findIndex((block) => block.type !== "image");
  editor.collapseTo({ block: textIndex, offset: 1 });
  imageEntry = editor.entryFor(index);
  pointerDown(imageEntry.image.x + 20, imageEntry.image.y + 20, { shiftKey: true });
  pointerUp(imageEntry.image.x + 20, imageEntry.image.y + 20);
  const selection = editor.getSelection();
  assertEqual(selection.anchor.block, textIndex, "Shift-click keeps the original anchor");
  assertEqual(selection.anchor.offset, 1, "Shift-click keeps the original caret");
  assertEqual(selection.focus.block, index, "Shift-click moves the focus to the image");
  assertEqual(selection.collapsed, false, "Shift-click extends the selection");
});

/* --------------------------------------------------------------------------
   Image transforms
   -------------------------------------------------------------------------- */

const QUADRANT_COLORS = {
  red: [224, 36, 36],
  green: [26, 163, 84],
  blue: [31, 79, 216],
  white: [242, 242, 242],
};

// A 40x20 picture with a different colour in each quadrant, so a turn or a flip
// can be checked by looking at which corner went where.
function quadrantImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 20;
  const context = canvas.getContext("2d");
  const quadrants = [
    ["red", 0, 0],
    ["green", 20, 0],
    ["blue", 0, 10],
    ["white", 20, 10],
  ];
  for (const [name, x, y] of quadrants) {
    context.fillStyle = `rgb(${QUADRANT_COLORS[name].join(",")})`;
    context.fillRect(x, y, 20, 10);
  }
  return canvas.toDataURL("image/png");
}

function loadImageSource(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the test image could not be decoded"));
    image.src = src;
  });
}

async function cornersOf(src) {
  const image = await loadImageSource(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  const nameAt = (x, y) => {
    const [r, g, b] = context.getImageData(x, y, 1, 1).data;
    let closest = "white";
    let distance = Infinity;
    for (const [name, [rr, gg, bb]] of Object.entries(QUADRANT_COLORS)) {
      const candidate = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
      if (candidate < distance) {
        distance = candidate;
        closest = name;
      }
    }
    return closest;
  };

  const x = Math.floor(canvas.width / 4);
  const y = Math.floor(canvas.height / 4);
  return {
    width: canvas.width,
    height: canvas.height,
    tl: nameAt(x, y),
    tr: nameAt(canvas.width - 1 - x, y),
    bl: nameAt(x, canvas.height - 1 - y),
    br: nameAt(canvas.width - 1 - x, canvas.height - 1 - y),
  };
}

test("images: turning and flipping rewrite the pixels, not just the layout", async () => {
  const source = quadrantImage();
  assertEqual((await cornersOf(source)).tl, "red", "the test picture starts red in its top-left");

  const turned = await transformImage(source, "rotate-90-clockwise");
  assertEqual(turned.turned, true, "a turn reports that it swapped the picture's sides");
  assertEqual(turned.width, 20, "a turn swaps the natural width");
  assertEqual(turned.height, 40, "a turn swaps the natural height");
  const afterTurn = await cornersOf(turned.src);
  assertEqual(afterTurn.tl, "blue", "the old bottom-left corner is the new top-left");
  assertEqual(afterTurn.tr, "red", "the old top-left corner is the new top-right");
  assertEqual(afterTurn.br, "green", "the old top-right corner is the new bottom-right");
  assertEqual(afterTurn.bl, "white", "the old bottom-right corner is the new bottom-left");

  const mirrored = await transformImage(source, "flip-horizontal");
  assertEqual(mirrored.turned, false, "a flip reports that it left the sides alone");
  assertEqual(mirrored.width, 40, "a horizontal flip keeps the width");
  assertEqual(mirrored.height, 20, "a horizontal flip keeps the height");
  const afterMirror = await cornersOf(mirrored.src);
  assertEqual(afterMirror.tl, "green", "a horizontal flip moves the top-right to the top-left");
  assertEqual(afterMirror.tr, "red", "a horizontal flip moves the top-left to the top-right");
  assertEqual(afterMirror.bl, "white", "the bottom row mirrors too");
  assertEqual(afterMirror.br, "blue", "the bottom row mirrors too");

  const upsideDown = await transformImage(source, "flip-vertical");
  const afterUpsideDown = await cornersOf(upsideDown.src);
  assertEqual(afterUpsideDown.tl, "blue", "a vertical flip moves the bottom-left to the top-left");
  assertEqual(afterUpsideDown.tr, "white", "a vertical flip moves the bottom-right up");
  assertEqual(afterUpsideDown.bl, "red", "the top row moves down");
  assertEqual(afterUpsideDown.br, "green", "the top row moves down");

  let four = source;
  for (let turn = 0; turn < 4; turn += 1) {
    four = (await transformImage(four, "rotate-90-clockwise")).src;
  }
  const fullCircle = await cornersOf(four);
  assertEqual(fullCircle.width, 40, "four turns come back to the original width");
  assertEqual(fullCircle.tl, "red", "four turns come back to the original top-left");
  assertEqual(fullCircle.br, "white", "four turns come back to the original bottom-right");
});

test("images: a transform refuses what it cannot read", async () => {
  let unreadable = "";
  try {
    await transformImage("data:image/png;base64,AAAA", "rotate-90-clockwise");
  } catch (error) {
    unreadable = error.message;
  }
  assert(unreadable.length > 0, "a broken data URL reports a reason");

  let unknown = "";
  try {
    await transformImage(quadrantImage(), "spin-around");
  } catch (error) {
    unknown = error.message;
  }
  assert(unknown.length > 0, "an unknown action reports a reason");
});

test("images: a turned image takes its new sides in the layout", async () => {
  const source = quadrantImage();
  cacheImageSize(source, { width: 40, height: 20 });
  await load(
    `<p>before</p><img width="40" height="20" data-width="300" src="${source}"><p>after</p>`,
    640,
  );

  const before = entry(1);
  assertClose(before.image.width, 300, 1, "the stored display width is used");
  assertClose(before.image.height, 150, 1, "the natural aspect gives the height");

  const turned = await transformImage(source, "rotate-90-clockwise");
  // The page calls loadMissingImages after each commit; the harness caches the
  // new natural size the same way.
  cacheImageSize(turned.src, { width: turned.width, height: turned.height });
  editor.updateImageBlock(1, {
    src: turned.src,
    width: turned.width,
    height: turned.height,
    displayWidth: Math.round(before.image.height),
  });

  const after = entry(1);
  assertClose(after.image.width, 150, 1, "the turn keeps the size the picture was scaled to");
  assertClose(after.image.height, 300, 1, "the image box swaps its sides");
  assertEqual(editor.getDocument()[1].width, 20, "the new natural width is stored");
  assertEqual(editor.getDocument()[1].height, 40, "the new natural height is stored");

  editor.undo();
  assertEqual(editor.getDocument()[1].src, source, "undo restores the picture");
  assertClose(entry(1).image.width, 300, 1, "undo restores the box");
});

/* --------------------------------------------------------------------------
   Corner radius
   -------------------------------------------------------------------------- */

test("images: the corner radius round-trips and stays bounded", async () => {
  const dot =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await load(
    '<p>Before</p><img width="200" height="120" data-radius="24" src="' + dot + '">' +
      '<img width="200" height="120" data-radius="999" src="' + dot + '">' +
      '<img width="200" height="120" src="' + dot + '">',
  );

  const blocks = editor.getDocument();
  assertEqual(blocks[1].radius, 24, "the stored radius is read");
  assertEqual(blocks[2].radius, 200, "a radius past the limit is clamped");
  assertEqual(blocks[3].radius, null, "an image without a radius keeps none");
  assertEqual(imageRadius(blocks[3]), 0, "an image without a radius is square");

  const html = serializeDocument(blocks);
  assert(html.includes('data-radius="24"'), "the radius is written back");
  assert(html.includes('data-radius="200"'), "the clamped radius is written back");
  assert(!html.includes('data-radius="999"'), "the out-of-range value does not survive");
});

test("images: the painted image carries its corner radius", async () => {
  const dot =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await load('<p>x</p><img width="80" height="60" data-radius="18" src="' + dot + '">');
  assertEqual(
    root.querySelector(".doc-image").style.borderRadius,
    "18px",
    "the stored radius is painted",
  );

  await load('<p>x</p><img width="80" height="60" data-radius="0" src="' + dot + '">');
  assertEqual(
    root.querySelector(".doc-image").style.borderRadius,
    "0px",
    "square corners are painted",
  );

  await load('<p>x</p><img width="80" height="60" src="' + dot + '">');
  assertEqual(
    root.querySelector(".doc-image").style.borderRadius,
    "0px",
    "an image without a radius is painted square",
  );
});

/* --------------------------------------------------------------------------
   Image placement
   -------------------------------------------------------------------------- */

test("images: a centred image keeps the width it had", async () => {
  const source = quadrantImage();
  cacheImageSize(source, { width: 800, height: 400 });
  await load(
    '<p>Before</p><img class="wrap-left" width="800" height="400" src="' + source + '">',
    640,
  );

  const wrapped = entry(1).image.width;
  assertClose(wrapped, editor.width * 0.42, 2, "a wrapped image takes 42% of the column");

  // What the middle button of the placement row does: an own-line image with
  // the width it already had, so the move does not resize it.
  editor.updateImageBlock(1, { mode: "block", displayWidth: Math.round(wrapped) });

  const centred = entry(1).image;
  assertEqual(centred.width, Math.round(wrapped), "the picture keeps its width");
  assertClose(centred.x, (editor.width - centred.width) / 2, 1, "and moves to the middle");
});

test("pdf: a rounded image clips to four corner curves", () => {
  const path = roundedRectPath(0, 0, 100, 60, 20);
  const curves = path.split("\n").filter((line) => line.endsWith(" c"));
  assertEqual(curves.length, 4, "each corner is one curve");
  assertEqual(path.split("\n")[0], "20 0 m", "the path starts after the bottom-left corner");
  assertEqual(path.split("\n")[1], "80 0 l", "the bottom edge stops before the corner");
  assertEqual(path.split("\n").at(-1), "h", "the path closes");
  assertEqual(
    roundedRectPath(10, 20, 100, 40, 90).split("\n")[0],
    "30 20 m",
    "the radius stops at half the shorter side",
  );
  assertEqual(roundedRectPath(0, 0, 10, 10, 0), "0 0 10 10 re", "a zero radius is a rectangle");
});

test("pdf: a rounded image is clipped before it is drawn", async () => {
  const source = quadrantImage();
  cacheImageSize(source, { width: 40, height: 20 });

  await load(`<img width="40" height="20" data-radius="18" src="${source}">`);
  const rounded = lastPdfStream(await buildPdf(editor.getDocument(), "Rounded"));
  const draw = rounded.indexOf("/Im1 Do");
  assert(draw > 0, "the image is drawn");
  const before = rounded.slice(0, draw);
  assertEqual(
    before.split("\n").filter((line) => line.endsWith(" c")).length,
    4,
    "four corner curves clip the image",
  );
  assert(before.includes("h\nW n"), "the rounded path is applied as a clip");

  await load(`<img width="40" height="20" data-radius="0" src="${source}">`);
  const square = lastPdfStream(await buildPdf(editor.getDocument(), "Square"));
  const squareDraw = square.indexOf("/Im1 Do");
  assert(squareDraw > 0, "the square image is drawn");
  const squareBefore = square.slice(0, squareDraw);
  assert(
    !squareBefore.split("\n").some((line) => line.endsWith(" c")),
    "a zero radius needs no corner curve",
  );
  assert(!squareBefore.includes("h\nW n"), "a zero radius applies no rounded clip");
});

function lastPdfStream(pdf) {
  const text = new TextDecoder("latin1").decode(pdf);
  const end = text.lastIndexOf("\nendstream");
  const start = text.lastIndexOf("stream\n", end);
  return text.slice(start + "stream\n".length, end);
}

test("selection: painted rectangles match the browser's painted text", async () => {
  await load(
    "<p>Select a phrase that is long enough to wrap across two painted lines and then verify every painted highlight rectangle against the browser.</p>",
  );
  const block = entry(0);
  assert(block.lines.length >= 2, "paragraph wraps");
  const start = 8;
  const end = block.lines[1].offsetStart + 12;
  const from = caretPoint(block, start);
  const to = caretPoint(block, end);
  dragFromTo(
    paintedOffsetX(0, start) + 0.5,
    from.y + from.height / 2,
    paintedOffsetX(0, end) - 0.5,
    to.y + to.height / 2,
  );
  const selection = editor.getSelection();
  assertEqual(selection.focus.offset, end, "drag reaches the end offset");
  assertEqual(editor.selectionText(), blockText(editor.getDocument()[0]).slice(start, end), "selected text");

  const rects = Array.from(root.querySelectorAll(".doc-selection")).map((element) => {
    const box = element.getBoundingClientRect();
    const rect = rootRect();
    return { x: box.left - rect.left, y: box.top - rect.top, width: box.width };
  });
  assertEqual(rects.length, 2, "one highlight per painted line");

  const expected = [
    { x: paintedOffsetX(0, start), width: paintedOffsetX(0, block.lines[0].offsetEnd) - paintedOffsetX(0, start) },
    { x: block.lines[1].fragments[0].x, width: paintedOffsetX(0, end) - block.lines[1].fragments[0].x },
  ];
  for (let index = 0; index < 2; index += 1) {
    assertClose(rects[index].x, expected[index].x, 1, `highlight ${index} x`);
    assertClose(rects[index].width, expected[index].width, 1.5, `highlight ${index} width`);
  }
});

test("layout: text beside a wrapped image keeps its caret and click geometry", async () => {
  await load(
    '<p>Words before the image block on the page.</p>' +
      '<img class="wrap-left" width="160" height="120" data-width="160" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">' +
      "<p>Text that runs beside the wrapped image for several lines of prose, so the narrowed band and the cleared band both hold real characters.</p>",
  );
  const imageEntry = entry(1);
  assert(imageEntry && imageEntry.image, "image has geometry");
  assert(imageEntry.image.width > 0 && imageEntry.image.height > 0, "image size was measured");
  const block = entry(2);
  assert(block.lines.length >= 2, "text beside the image wraps");
  for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
    const line = block.lines[lineIndex];
    const fragment = line.fragments[0];
    if (!fragment) {
      continue;
    }
    const painted = paintedOffsetX(2, fragment.start);
    const point = caretPoint(block, fragment.start);
    assert(painted !== null && point, `geometry exists on line ${lineIndex}`);
    assertClose(point.x, painted, 1.5, `caret at line ${lineIndex} start`);
    if (point.x < imageEntry.image.x + imageEntry.image.width && line.y < imageEntry.image.y + imageEntry.image.height) {
      // A line beside the image must not be painted under it.
      const lineRight = fragment.x + fragmentTextWidth(line.fragments[line.fragments.length - 1], line.fragments[line.fragments.length - 1].text);
      assert(
        lineRight <= imageEntry.image.x + 0.5 || fragment.x >= imageEntry.image.x + imageEntry.image.width - 0.5,
        `line ${lineIndex} avoids painting under the image`,
      );
    }
  }
});

test("layout: resizing the paper keeps carets and clicks aligned", async () => {
  const html =
    "<p>Paper width changes rewrap every line, so the caret and the painted glyphs have to move together.</p>";
  await load(html, 720);
  const wideClicked = clickWordAt(0, "every");
  assertEqual(wideClicked, wordOffset(0, "every"), "click before resizing");

  column.style.width = "520px";
  await settle();
  editor.sync();
  const block = entry(0);
  assert(block.lines.length >= 2, "narrow paper wraps the paragraph");
  const narrowClicked = clickWordAt(0, "painted");
  assertEqual(narrowClicked, wordOffset(0, "painted"), "click after narrowing");

  column.style.width = "900px";
  await settle();
  editor.sync();
  assertEqual(clickWordAt(0, "caret"), wordOffset(0, "caret"), "click after widening");
});

function wordOffset(index, word) {
  return blockText(editor.getDocument()[index]).indexOf(word);
}

function clickWordAt(index, word) {
  const offset = wordOffset(index, word);
  const painted = paintedOffsetX(index, offset);
  const point = caretPoint(entry(index), offset);
  const x = Math.min(painted + 0.4, rootRect().width - 0.6);
  clickAt(x, point.y + point.height / 2);
  return editor.getSelection().focus.offset;
}

test("writing: an empty document accepts the first keystroke", async () => {
  editor.setDocument([]);
  await settle();
  assertEqual(editor.getDocument().length, 1, "one empty paragraph");
  assertEqual(entry(0).lines.length, 1, "one painted empty line");
  typeText("Hello");
  assertEqual(blockText(editor.getDocument()[0]), "Hello", "text typed into the empty document");
  assertEqual(paintedText(0), "Hello", "painted text");
});

test("caret: trailing spaces keep a usable caret and click boundary", async () => {
  await load("<p></p>");
  editor.insertText("word   ");
  const block = entry(0);
  const length = blockText(editor.getDocument()[0]).length;
  const point = caretPoint(block, length);
  const painted = paintedOffsetX(0, length);
  assert(point && painted !== null, "the end of trailing spaces has geometry");
  assertClose(point.x, painted, 1.5, "the caret sits after the last space");
  clickAt(painted - 0.5, point.y + point.height / 2);
  assertEqual(editor.getSelection().focus.offset, length, "clicking the space end keeps its offset");
});

test("hard breaks: backspace and Delete remove the break, not a letter", async () => {
  await load("<p>ab<br>cd</p>");
  assertEqual(blockText(editor.getDocument()[0]), "ab\ncd", "hard break is in the model");
  assertEqual(paintedText(0), "ab\ncd", "hard break paints two lines");

  editor.collapseTo({ block: 0, offset: "ab\n".length });
  editor.sync();
  editor.backspace();
  assertEqual(blockText(editor.getDocument()[0]), "abcd", "backspace deletes the line feed");
  assertEqual(paintedText(0), "abcd", "the painted lines join");
  assertEqual(editor.getSelection().focus.offset, 2, "caret sits where the break was");
  editor.undo();
  assertEqual(paintedText(0), "ab\ncd", "undo restores the break");

  editor.collapseTo({ block: 0, offset: 2 });
  editor.sync();
  editor.deleteForward();
  assertEqual(blockText(editor.getDocument()[0]), "abcd", "Delete removes the line feed forward");
  assertEqual(editor.getSelection().focus.offset, 2, "caret stays before the joined text");

  await load("<p>ab<br></p>");
  assertEqual(blockText(editor.getDocument()[0]), "ab\n", "trailing hard break is stored");
  assertEqual(entry(0).lines.length, 1, "a trailing break opens no extra line");
  editor.collapseTo({ block: 0, offset: 3 });
  editor.sync();
  const point = editor.caretGeometry();
  const line = entry(0).lines[0];
  assert(point && point.line === line, "caret at the end of a trailing break sits on the line");
  typeText("c");
  assertEqual(blockText(editor.getDocument()[0]), "ab\nc", "typing after a trailing break opens a line");
  assertEqual(paintedText(0), "ab\nc", "the new line is painted");
});

test("writing: a long unbroken word wraps inside the paper", async () => {
  await load("<p></p>");
  const token = "x".repeat(140);
  editor.insertText("before " + token + " after");
  const block = entry(0);
  assert(block.lines.length >= 2, "the long word uses more than one line");
  for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
    const line = block.lines[lineIndex];
    let right = line.x;
    for (const fragment of line.fragments) {
      right = fragment.x + fragmentTextWidth(fragment, fragment.text);
    }
    assert(
      right <= line.x + line.width + 1,
      `line ${lineIndex} stays inside its available width: ${formatNumber(right)} > ${formatNumber(line.x + line.width)}`,
    );
  }
  assertEqual(paintedText(0).split("\n").join(""), "before " + token + " after", "every character is painted");
});

test("keyboard: Tab indents inside a code block", async () => {
  await load("<pre>if (true) {\nreturn 1;\n}</pre>");
  editor.collapseTo({ block: 0, offset: "if (true) {\n".length });
  editor.sync();
  key("Tab");
  assertEqual(blockText(editor.getDocument()[0]), "if (true) {\n\treturn 1;\n}", "Tab inserts indentation");
  assertEqual(editor.getSelection().focus.offset, "if (true) {\n\t".length, "caret moves past the tab");
  assertEqual(paintedText(0), "if (true) {\n\treturn 1;\n}", "indentation is painted");
});

test("pointer: Shift-click extends the selection instead of collapsing it", async () => {
  await load("<p>one two three four five</p>");
  const text = blockText(editor.getDocument()[0]);
  const start = text.indexOf("two");
  const end = text.indexOf("four") + "four".length;
  const a = caretPoint(entry(0), start);
  const b = caretPoint(entry(0), end);
  clickAt(paintedOffsetX(0, start) + 0.5, a.y + a.height / 2);
  assertEqual(editor.getSelection().focus.offset, start, "first click places the anchor");
  const rect = rootRect();
  const target = document.elementFromPoint(
    rect.left + paintedOffsetX(0, end) - 0.5,
    rect.top + b.y + b.height / 2,
  );
  target.dispatchEvent(
    new PointerEvent("pointerdown", pointerOptions(rect.left + paintedOffsetX(0, end) - 0.5, rect.top + b.y + b.height / 2, { shiftKey: true })),
  );
  pointerUp();
  assertEqual(editor.selectionText(), "two three four", "Shift-click extends from the original anchor");
});

test("lists: Enter, Tab, and markers follow the list structure", async () => {
  await load("<p>first item</p>");
  editor.collapseTo({ block: 0, offset: 10 });
  editor.sync();
  key("Enter");
  typeText("second item");
  editor.setSelection({ block: 0, offset: 0 }, { block: 1, offset: 11 });
  editor.sync();
  editor.toggleList(false);

  const blocks = editor.getDocument();
  assertEqual(blocks[0].type, "list", "first paragraph became a list item");
  assert(blocks[0].ordered === false, "Ctrl+U chose a bullet list");
  assertEqual(blockText(blocks[0]), "first item", "first item text");
  assertEqual(blocks[1].type, "list", "second paragraph became a list item");
  assertEqual(blockText(blocks[1]), "second item", "second item text");
  const markers = Array.from(root.querySelectorAll(".doc-marker")).map((element) => element.textContent);
  assertEqual(markers.length, 2, "one marker per list item");
  assert(markers.every((marker) => marker === "\u2022"), "bullet markers painted");

  editor.collapseTo({ block: 1, offset: 0 });
  editor.sync();
  key("Tab");
  assertEqual(editor.getDocument()[1].depth, 1, "Tab nests a list item");
  key("Tab", { shiftKey: true });
  assertEqual(editor.getDocument()[1].depth, 0, "Shift+Tab unnests it");

  editor.collapseTo({ block: 1, offset: "second item".length });
  editor.sync();
  key("Enter");
  assertEqual(editor.getDocument().length, 3, "Enter adds another item");
  key("Enter");
  assertEqual(editor.getDocument()[2].type, "p", "Enter on an empty item leaves the list");
});

test("lists: ordered markers number consecutive items", async () => {
  await load("<p>alpha</p><p>beta</p><p>gamma</p>");
  editor.setSelection({ block: 0, offset: 0 }, { block: 2, offset: 5 });
  editor.sync();
  editor.toggleList(true);
  const markers = Array.from(root.querySelectorAll(".doc-marker")).map((element) => element.textContent);
  assertEqual(markers.join(","), "1.,2.,3.", "ordered markers number items in order");
});

test("lists: nested lists do not restart their parent's numbering", async () => {
  await load("<ol><li>one</li><li>two<ol><li>child</li></ol></li><li>three</li></ol>");
  const markers = Array.from(root.querySelectorAll(".doc-marker")).map((element) => element.textContent);
  assertEqual(markers.join(","), "1.,2.,1.,3.", "the third parent item follows its siblings past the nested list");
});

test("links: linked text keeps its range and can be removed", async () => {
  await load("<p>Link this phrase or that phrase.</p>");
  const start = 5;
  const end = 16;
  editor.setSelection({ block: 0, offset: start }, { block: 0, offset: end });
  editor.sync();
  editor.setLink("https://example.com/");
  const block = editor.getDocument()[0];
  const runs = block.runs.filter((run) => run.href);
  assertEqual(runs.map((run) => run.text).join(""), "this phrase", "only the selected text is linked");
  assertEqual(editor.linkAtCaret()?.href, "https://example.com/", "link at the caret");
  const links = root.querySelectorAll(".m-link");
  assert(links.length >= 1, "the link is painted with its class");
  assertEqual(links[0].textContent, "this phrase", "the painted link text matches");

  editor.collapseTo({ block: 0, offset: start + 2 });
  editor.sync();
  editor.removeLinkAtCaret();
  assertEqual(editor.getDocument()[0].runs.filter((run) => run.href).length, 0, "the link was removed");
  assertEqual(blockText(editor.getDocument()[0]), "Link this phrase or that phrase.", "text unchanged");
});

test("images: inserting, selecting, and deleting an image keeps the text intact", async () => {
  await load("<p>before after</p>");
  editor.collapseTo({ block: 0, offset: "before ".length });
  editor.sync();
  editor.insertImage({
    type: "image",
    mode: "block",
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    alt: "Dot",
    width: 80,
    height: 60,
  });
  const blocks = editor.getDocument();
  assertEqual(blocks.length, 3, "text before, image, text after");
  assertEqual(blocks[1].type, "image", "image block inserted");
  assertEqual(blockText(blocks[0]), "before ", "head text kept");
  assertEqual(blockText(blocks[2]), "after", "tail text kept");
  assertEqual(editor.getSelection().focus.block, 2, "caret lands in the tail");
  const imageEntry = editor.entryFor(1);
  assert(imageEntry && imageEntry.image.width > 0, "image has painted geometry");

  clickAt(imageEntry.image.x + imageEntry.image.width / 2, imageEntry.image.y + imageEntry.image.height / 2);
  assertEqual(editor.getSelection().focus.block, 1, "clicking the image selects its block");
  assertEqual(editor.selectionText(), "", "an image selection has no text");
  const ring = root.querySelector(".doc-image-selection");
  assert(ring, "the image selection ring is painted");

  editor.backspace();
  assertEqual(editor.getDocument().length, 2, "backspace removes the selected image");
  editor.undo();
  assertEqual(editor.getDocument().length, 3, "undo restores the image");
});

test("model: special characters and literal tags round-trip as text", async () => {
  await load("<p></p>");
  const typed = "a < b & c > d \"quoted\" 'single'";
  typeText(typed);
  assertEqual(blockText(editor.getDocument()[0]), typed, "model keeps the characters");
  assertEqual(paintedText(0), typed, "painted text keeps the characters");
  const stored = serializeDocument(editor.getDocument());
  assert(stored.includes("&lt;"), "the less-than sign is escaped on save");
  assert(!stored.includes("<b"), "typed text never becomes markup");
  const reloaded = parseDocument(stored);
  assertEqual(blockText(reloaded[0]), typed, "the characters survive the round trip");
  editor.setDocument(reloaded);
  await settle();
  assertEqual(paintedText(0), typed, "the reloaded text paints the same characters");

  await load("<p></p>");
  typeText("<br>");
  const literal = blockText(editor.getDocument()[0]);
  assertEqual(literal, "<br>", "a literal tag is text");
  const literalHtml = serializeDocument(editor.getDocument());
  assertEqual(literalHtml, "<p>&lt;br&gt;</p>", "a literal tag is escaped, not written as a break");
  assertEqual(blockText(parseDocument(literalHtml)[0]), "<br>", "the literal tag reloads as text");
});

test("model: quotes and code blocks keep their breaks and escaped text", async () => {
  const html =
    "<blockquote><p>first line<br>second line</p></blockquote>" +
    '<pre>if (a &lt; b) {\n\treturn "x &amp; y";\n}</pre>';
  const blocks = parseDocument(html);
  assertEqual(blocks[0].type, "quote", "quote parsed");
  assertEqual(blockText(blocks[0]), "first line\nsecond line", "quote keeps its break");
  assertEqual(blocks[1].type, "code", "code parsed");
  assertEqual(blockText(blocks[1]), 'if (a < b) {\n\treturn "x & y";\n}', "code keeps its breaks and characters");
  const stored = serializeDocument(blocks);
  assert(stored.includes("first line<br>second line"), "quote break serialized as a tag");
  assert(stored.includes("&lt;"), "code text is escaped");
  const reloaded = parseDocument(stored);
  assertEqual(blockText(reloaded[0]), blockText(blocks[0]), "quote text round-trips");
  assertEqual(blockText(reloaded[1]), blockText(blocks[1]), "code text round-trips");
  assertEqual(serializeDocument(reloaded), stored, "stored HTML is stable");
});

test("composition: IME text is inserted once, at the caret", async () => {
  await load("<p></p>");
  editor.focusEditor();
  textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  textarea.value = "\u306b\u307b";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  assertEqual(blockText(editor.getDocument()[0]), "", "input while composing does not insert yet");
  textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u306b\u307b" }));
  assert(root.querySelector(".doc-composition"), "the composition text is shown while typing");
  textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\u306b\u307b\u3093" }));
  assertEqual(blockText(editor.getDocument()[0]), "\u306b\u307b\u3093", "the composed text is inserted once");
  assertEqual(paintedText(0), "\u306b\u307b\u3093", "the composed text is painted once");
  assert(!root.querySelector(".doc-composition"), "the composition overlay is removed");
  const point = editor.caretGeometry();
  assert(point && point.x > 0, "the caret follows the composed text");
});

test("images: typing over a selected image replaces it and undo restores it", async () => {
  await load("<p></p>");
  editor.insertImage({
    type: "image",
    mode: "block",
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    alt: "Dot",
    width: 60,
    height: 40,
  });
  const imageIndex = editor.getDocument().findIndex((block) => block.type === "image");
  const imageEntry = editor.entryFor(imageIndex);
  clickAt(imageEntry.image.x + 10, imageEntry.image.y + 10);
  assertEqual(editor.getSelection().focus.block, imageIndex, "image selected");
  typeText("text");
  assert(!editor.getDocument().some((block) => block.type === "image"), "typing removes the image");
  const textIndex = editor.getDocument().findIndex((block) => blockText(block) === "text");
  assert(textIndex >= 0, "the typed text replaced it");
  editor.undo();
  assert(editor.getDocument().some((block) => block.type === "image"), "one undo restores the image");
});

test("selection: deleting a range of images removes all of them", async () => {
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await load(
    `<img width="40" height="30" src="${pixel}"><p>middle</p><img width="40" height="30" src="${pixel}">`,
  );
  assertEqual(editor.getDocument().length, 3, "two images and a paragraph");
  editor.setSelection({ block: 0, offset: 0 }, { block: 2, offset: 0 });
  editor.sync();
  editor.backspace();
  assertEqual(editor.getDocument().length, 1, "the selection collapses to one block");
  assert(!editor.getDocument().some((block) => block.type === "image"), "both images are gone");
  editor.undo();
  assertEqual(editor.getDocument().length, 3, "undo restores both images");
});

test("undo: clicking elsewhere ends the typing undo group", async () => {
  await load("<p></p>");
  typeText("hello");
  const point = caretPoint(entry(0), 0);
  clickAt(2, point.y + point.height / 2);
  assertEqual(editor.getSelection().focus.offset, 0, "the click moves the caret to the start");
  typeText("x");
  assertEqual(blockText(editor.getDocument()[0]), "xhello", "typing at the new caret");
  editor.undo();
  assertEqual(blockText(editor.getDocument()[0]), "hello", "undo removes only the text from the new caret");
});

test("undo: a new edit clears the redo stack", async () => {
  await load("<p></p>");
  typeText("first");
  editor.undo();
  assertEqual(blockText(editor.getDocument()[0]), "", "undo removes the typing");
  typeText("second");
  assertEqual(blockText(editor.getDocument()[0]), "second", "new typing after undo");
  key("y", { ctrlKey: true });
  assertEqual(blockText(editor.getDocument()[0]), "second", "redo does nothing after a new edit");
  key("z", { ctrlKey: true, shiftKey: true });
  assertEqual(blockText(editor.getDocument()[0]), "second", "redo shortcut stays empty");
});

test("keyboard: word movement and word delete use word boundaries", async () => {
  await load("<p>alpha beta gamma</p>");
  editor.collapseTo({ block: 0, offset: blockText(editor.getDocument()[0]).length });
  editor.sync();
  key("ArrowLeft", { ctrlKey: true });
  assertEqual(editor.getSelection().focus.offset, "alpha beta ".length, "Ctrl+Left lands on the last word");
  key("ArrowLeft", { ctrlKey: true });
  assertEqual(editor.getSelection().focus.offset, "alpha ".length, "Ctrl+Left again");
  key("ArrowRight", { ctrlKey: true });
  assertEqual(editor.getSelection().focus.offset, "alpha beta ".length, "Ctrl+Right returns");
  key("Backspace", { ctrlKey: true });
  assertEqual(blockText(editor.getDocument()[0]), "alpha gamma", "Ctrl+Backspace deletes the word behind");
  assertEqual(editor.getSelection().focus.offset, "alpha ".length, "caret at the deletion point");
});

test("model: pretty-printed HTML does not grow phantom paragraphs", async () => {
  const pretty =
    "<p>one</p>\n  <p>two</p>\n  <p></p>\n  <h1>head</h1>\n  <ul>\n    <li>a</li>\n    <li>b</li>\n  </ul>\n";
  const blocks = parseDocument(pretty);
  assertEqual(blocks.length, 6, "no whitespace-only block between the tags");
  assertEqual(blocks.map((block) => blockText(block)).join("|"), "one|two||head|a|b", "block text");
  assertEqual(blocks[2].type, "p", "the empty paragraph is still a paragraph");
  const spaces = parseDocument("<p>  two  spaces </p>");
  assertEqual(blockText(spaces[0]), "  two  spaces ", "space inside a paragraph is content");
  const inline = parseDocument("<div>Hello <b>world</b> and <i>friends</i></div>");
  assertEqual(blockText(inline[0]), "Hello world and friends", "spaces between inline spans survive");
  const wrapped = parseDocument("<div>\n  <p>a</p>\n  <p>b</p>\n</div>");
  assertEqual(wrapped.length, 2, "a div with block children does not grow a whitespace paragraph");
});

test("invariant: typing a long paragraph keeps paint and caret in step", async () => {
  await load("<p></p>");
  const text =
    "The quick brown fox jumps over the lazy dog while the harbour lights come on one by one " +
    "and the water below the window keeps every one of them until morning. ";
  const typed = text + text;
  for (let index = 0; index < typed.length; index += 1) {
    typeInput(typed[index]);
    if (index % 7 === 0 || index === typed.length - 1) {
      const blocks = editor.getDocument();
      assertEqual(
        paintedText(0).split("\n").join(""),
        blockText(blocks[0]).replace(/\n/g, ""),
        `painted text after ${index + 1} characters`,
      );
      const offset = editor.getSelection().focus.offset;
      const point = editor.caretGeometry();
      const painted = paintedOffsetX(0, offset);
      assert(point, `caret exists after ${index + 1} characters`);
      if (painted !== null) {
        assertClose(point.x, painted, 2, `caret sits on the painted glyph edge after ${index + 1} characters`);
      }
    }
  }
  assertEqual(blockText(editor.getDocument()[0]), typed, "all typed characters are in the model");
  assert(entry(0).lines.length >= 4, "the paragraph wrapped several times");
});

test("fuzz: a deterministic editing session keeps every invariant", async () => {
  let seed = 0x13198a2e;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items) => items[Math.floor(random() * items.length) % items.length];
  const integer = (max) => Math.floor(random() * max);
  const words = ["alpha", "beta", "gamma", "delta", " ", "  ", "\t", "\n", "\u{1f600}", "&", "<", "don't"];
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  await load("<p>start</p>");

  for (let step = 0; step < 150; step += 1) {
    const label = `step ${step}`;
    const blocks = editor.getDocument();
    const blockIndex = integer(blocks.length);
    const blockLengthNow = blockLength(blocks[blockIndex]);
    const offset = integer(blockLengthNow + 1);
    const action = integer(24);

    switch (action) {
      case 0:
      case 1:
      case 2:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        typeText(pick(words));
        break;
      case 3:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.insertText(pick(words) + pick(words));
        break;
      case 4:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.backspace();
        break;
      case 5:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.deleteForward();
        break;
      case 6:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("Enter", { shiftKey: random() < 0.5 });
        break;
      case 7: {
        const other = integer(blocks.length);
        const from = { block: Math.min(blockIndex, other), offset: integer(blockLength(blocks[Math.min(blockIndex, other)]) + 1) };
        const toBlock = Math.max(blockIndex, other);
        const to = { block: toBlock, offset: integer(blockLength(blocks[toBlock]) + 1) };
        editor.setSelection(from, to);
        editor.sync();
        if (random() < 0.5) {
          editor.backspace();
        } else {
          typeText(pick(words));
        }
        break;
      }
      case 8:
        editor.setSelection(
          { block: blockIndex, offset: 0 },
          { block: blockIndex, offset: blockLengthNow },
        );
        editor.sync();
        editor.toggleMark(pick(["b", "i", "u", "s"]));
        break;
      case 9:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.toggleMark(pick(["b", "i", "u"]));
        break;
      case 10:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("Tab", { shiftKey: random() < 0.5 });
        break;
      case 11:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.toggleList(random() < 0.5);
        break;
      case 12:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.setBlockType(pick(["p", "h1", "h2", "quote", "code"]));
        break;
      case 13:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.setAlignment(pick(["left", "center", "right", "justify"]));
        break;
      case 14:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.changeIndent(pick([-1, 1]));
        break;
      case 15:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        editor.insertImage({
          type: "image",
          mode: pick(["block", "left", "right", "free"]),
          src: pixel,
          alt: "Dot",
          width: 40,
          height: 30,
        });
        break;
      case 16:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        clickAt(integer(Math.max(1, Math.floor(rootRect().width - 2))), integer(Math.max(20, Math.floor(Math.min(layout().height, 700)))));
        break;
      case 17:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("z", { ctrlKey: true, shiftKey: false });
        break;
      case 18:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("y", { ctrlKey: true });
        break;
      case 19:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("ArrowDown", { shiftKey: random() < 0.5 });
        break;
      case 20:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("ArrowUp", { shiftKey: random() < 0.5 });
        break;
      case 21:
        editor.collapseTo({ block: blockIndex, offset });
        editor.sync();
        key("ArrowRight", { ctrlKey: true, shiftKey: random() < 0.5 });
        break;
      case 22:
        editor.setSelection({ block: 0, offset: 0 }, { block: blocks.length - 1, offset: blockLength(blocks[blocks.length - 1]) });
        editor.sync();
        break;
      case 23:
        editor.deleteBlockAt(blockIndex);
        break;
      default:
        break;
    }

    const current = editor.getDocument();
    assert(current.length >= 1, `${label}: at least one block`);
    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      assert(
        ["p", "h1", "h2", "h3", "h4", "quote", "list", "code", "image"].includes(item.type),
        `${label}: block ${index} type ${item.type}`,
      );
      if (item.type === "image") {
        assert(typeof item.src === "string" && item.src.startsWith("data:image/"), `${label}: image source`);
      } else {
        assert(Array.isArray(item.runs), `${label}: block ${index} runs`);
        assertEqual(blockLength(item), blockText(item).length, `${label}: block ${index} length`);
      }
      if (item.type === "list") {
        assert(item.depth >= 0 && item.depth <= 5, `${label}: list depth ${item.depth}`);
      }
    }
    const selection = editor.getSelection();
    assert(selection.anchor.block < current.length && selection.focus.block < current.length, `${label}: selection block`);
    for (const position of [selection.anchor, selection.focus]) {
      assert(position.offset >= 0 && position.offset <= blockLength(current[position.block]), `${label}: selection offset`);
    }
    assertDocumentInvariant(label);
  }

  const stored = serializeDocument(editor.getDocument());
  const reloaded = parseDocument(stored);
  const originalBlocks = editor.getDocument();
  assertEqual(reloaded.length, originalBlocks.length, "serialized block count");
  for (let index = 0; index < originalBlocks.length; index += 1) {
    assertEqual(blockText(reloaded[index]), blockText(originalBlocks[index]), `serialized block ${index} text`);
    assertEqual(reloaded[index].type, originalBlocks[index].type, `serialized block ${index} type`);
  }
  assertEqual(serializeDocument(reloaded), stored, "the fuzzed document serializes stably");
});

test("export: PDF builds from an edited document", async () => {
  await load(
    "<h1>A heading</h1><p>One paragraph with <b>bold</b> text and a<br>hard break.</p>" +
      "<ul><li>a list item</li></ul><pre>const x = 1;\n\treturn x;</pre>",
  );
  const pdf = await buildPdf(editor.getDocument(), "Exported title");
  assert(pdf instanceof Uint8Array && pdf.length > 2000, "a PDF document with content is produced");
  const text = new TextDecoder("latin1").decode(pdf);
  assert(text.startsWith("%PDF"), "the PDF header is present");
  assert(text.includes("Exported title"), "the title appears in the PDF text");
  assert(text.includes("hard break"), "the body appears in the PDF text");
});

test("model: an edited document round-trips through stored HTML", async () => {
  await load("<p>First paragraph.</p>");
  editor.collapseTo({ block: 0, offset: "First paragraph.".length });
  editor.sync();
  key("Enter");
  key("Enter");
  typeText("A second paragraph with  two  spaces and a ");
  key("b", { ctrlKey: true });
  typeText("bold");
  key("b", { ctrlKey: true });
  typeText(" word.\n");
  editor.insertText("Line two of the same paragraph.");
  key("Enter");
  typeText("A list item");
  editor.toggleList(false);
  key("Enter");
  typeText("Another item");

  const blocks = editor.getDocument();
  const stored = serializeDocument(blocks);
  const reloaded = parseDocument(stored);
  assertEqual(reloaded.length, blocks.length, "block count survives the round trip");
  for (let index = 0; index < blocks.length; index += 1) {
    assertEqual(blockText(reloaded[index]), blockText(blocks[index]), `block ${index} text`);
    assertEqual(reloaded[index].type, blocks[index].type, `block ${index} type`);
  }
  assertEqual(serializeDocument(reloaded), stored, "stored HTML is stable");
  const bold = reloaded
    .flatMap((block) => block.runs || [])
    .find((run) => run.b);
  assertEqual(bold?.text, "bold", "bold run survives the round trip");
});

/* --------------------------------------------------------------------------
   Invariant checks after real editing operations
   -------------------------------------------------------------------------- */

function assertDocumentInvariant(label) {
  const blocks = editor.getDocument();
  assert(blocks.length >= 1, `${label}: at least one block`);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const painted = paintedText(index).split("\n").join("");
    const model = blockText(block).replace(/\n/g, "");
    assertEqual(painted, model, `${label}: painted text of block ${index}`);
  }
  const selection = editor.getSelection();
  if (selection.collapsed && blocks[selection.focus.block] && blocks[selection.focus.block].type !== "image") {
    const point = editor.caretGeometry();
    assert(
      point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.height > 0,
      `${label}: a collapsed selection has a finite caret`,
    );
  }
}

test("invariant: painting follows the model through a long editing session", async () => {
  await load("<p></p>");
  assertDocumentInvariant("empty");

  typeText("Hello world");
  assertDocumentInvariant("typed words");
  key("Enter");
  typeText("Second paragraph");
  assertDocumentInvariant("second paragraph");
  key("Enter", { shiftKey: true });
  typeText("same block");
  assertDocumentInvariant("hard break");
  key("b", { ctrlKey: true });
  typeText("bold");
  key("b", { ctrlKey: true });
  typeText("plain");
  assertDocumentInvariant("marks");
  key("z", { ctrlKey: true });
  assertDocumentInvariant("undo marks");
  key("z", { ctrlKey: true, shiftKey: true });
  assertDocumentInvariant("redo marks");

  const text = blockText(editor.getDocument()[1]);
  editor.setSelection({ block: 1, offset: 0 }, { block: 1, offset: Math.min(6, text.length) });
  editor.sync();
  key("i", { ctrlKey: true });
  assertDocumentInvariant("italic selection");
  editor.collapseTo({ block: 1, offset: 3 });
  editor.sync();
  editor.backspace();
  assertDocumentInvariant("backspace");
  editor.deleteForward();
  assertDocumentInvariant("delete forward");
  editor.undo();
  assertDocumentInvariant("undo delete");
  editor.redo();
  assertDocumentInvariant("redo delete");

  editor.setSelection({ block: 0, offset: 0 }, { block: 1, offset: blockText(editor.getDocument()[1]).length });
  editor.sync();
  editor.toggleList(false);
  assertDocumentInvariant("list");
  editor.toggleList(false);
  assertDocumentInvariant("back to paragraphs");

  editor.collapseTo({ block: 0, offset: 2 });
  editor.sync();
  clickAt(120, entry(1).lines[0].y + 8);
  assertDocumentInvariant("click");

  editor.setBlockType("code");
  assertDocumentInvariant("code block");
  editor.setBlockType("p");
  assertDocumentInvariant("paragraph again");

  editor.insertImage({
    type: "image",
    mode: "block",
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    alt: "Dot",
    width: 40,
    height: 30,
  });
  assertDocumentInvariant("image inserted");
  editor.undo();
  assertDocumentInvariant("undo image");
});

test("clipboard: copy and cut use the selected model text", async () => {
  await load("<p>alpha beta gamma</p>");
  editor.setSelection({ block: 0, offset: 6 }, { block: 0, offset: 10 });
  editor.sync();
  const clipboard = new DataTransfer();
  let prevented = false;
  editor.handleCopy(
    {
      preventDefault() {
        prevented = true;
      },
      clipboardData: clipboard,
    },
    false,
  );
  assert(prevented, "copy handles the event");
  assertEqual(clipboard.getData("text/plain"), "beta", "copied text");
  assertEqual(blockText(editor.getDocument()[0]), "alpha beta gamma", "copy leaves the text");

  const cutClipboard = new DataTransfer();
  editor.handleCopy(
    {
      preventDefault() {},
      clipboardData: cutClipboard,
    },
    true,
  );
  assertEqual(cutClipboard.getData("text/plain"), "beta", "cut copies the text");
  assertEqual(blockText(editor.getDocument()[0]), "alpha  gamma", "cut deletes it");
  editor.undo();
  assertEqual(blockText(editor.getDocument()[0]), "alpha beta gamma", "undo restores a cut");
});

test("selection: deleting across paragraphs and an image keeps the outer text", async () => {
  await load(
    '<p>alpha</p><img width="60" height="40" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="><p>beta</p>',
  );
  editor.setSelection({ block: 0, offset: 2 }, { block: 2, offset: 2 });
  editor.sync();
  editor.backspace();
  assertEqual(editor.getDocument().length, 1, "one merged block remains");
  assertEqual(blockText(editor.getDocument()[0]), "alta", "head and tail text joined, image dropped");
  editor.undo();
  assertEqual(editor.getDocument().length, 3, "undo restores the image and paragraphs");
});

test("writing: carets and clicks survive a word broken across lines", async () => {
  await load("<p></p>");
  const token = "abcdefghij".repeat(12);
  editor.insertText(token);
  const block = entry(0);
  assert(block.lines.length >= 2, "long word breaks across lines");
  for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
    const line = block.lines[lineIndex];
    for (const fragment of line.fragments) {
      for (const offset of [fragment.start, fragment.start + 1, fragment.end - 1, fragment.end]) {
        if (offset < 0 || offset > token.length) {
          continue;
        }
        const point = caretPoint(block, offset);
        const painted = paintedOffsetX(0, offset);
        if (painted === null || !point) {
          continue;
        }
        assertClose(point.x, painted, 2, `caret at broken-word offset ${offset}`);
      }
    }
  }
  const point = caretPoint(block, 7);
  const painted = paintedOffsetX(0, 7);
  clickAt(painted + 0.5, point.y + point.height / 2);
  assertEqual(editor.getSelection().focus.offset, 7, "click inside the broken word");
});

test("pointer: double-click selects words without trailing punctuation", async () => {
  await load("<p>Punctuation, attached to words; don't split them.</p>");
  const text = blockText(editor.getDocument()[0]);
  for (const [word, probe] of [
    ["attached", "attached"],
    ["words", "words"],
    ["don't", "don't"],
  ]) {
    const start = text.indexOf(word);
    const at = paintedOffsetX(0, start + 1);
    const point = caretPoint(entry(0), start + 1);
    const rect = rootRect();
    const target = document.elementFromPoint(rect.left + at, rect.top + point.y + point.height / 2);
    target.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + at,
        clientY: rect.top + point.y + point.height / 2,
      }),
    );
    assertEqual(editor.selectionText(), probe, `double-click on ${probe}`);
  }
});

test("keyboard: paragraph indent moves painted lines and clicks with them", async () => {
  await load("<p>An indented paragraph line.</p>");
  key("Tab");
  assertEqual(editor.getDocument()[0].indent, 1, "Tab indents the paragraph");
  assertClose(entry(0).lines[0].x, 24, 0.01, "painted line shifts by one step");
  const offset = 3;
  const painted = paintedOffsetX(0, offset);
  const point = caretPoint(entry(0), offset);
  clickAt(painted + 0.5, point.y + point.height / 2);
  assertEqual(editor.getSelection().focus.offset, offset, "click matches the indented line");
  key("Tab", { shiftKey: true });
  assertEqual(editor.getDocument()[0].indent, undefined, "Shift+Tab removes the indent");
});

test("lists: ordered markers renumber after deleting an item", async () => {
  await load("<ol><li>one</li><li>two</li><li>three</li></ol>");
  const markersBefore = Array.from(root.querySelectorAll(".doc-marker")).map((element) => element.textContent);
  assertEqual(markersBefore.join(","), "1.,2.,3.", "initial numbering");
  editor.deleteBlockAt(0);
  const markersAfter = Array.from(root.querySelectorAll(".doc-marker")).map((element) => element.textContent);
  assertEqual(markersAfter.join(","), "1.,2.", "renumbered after deletion");
});

test("lists: saving keeps items whose depth skips a level", async () => {
  await load("<ul><li>a</li><li>b</li><li>c</li></ul>");
  editor.collapseTo({ block: 2, offset: 0 });
  editor.sync();
  key("Tab");
  key("Tab");
  assertEqual(editor.getDocument()[2].depth, 2, "third item is two levels deep with no level-one item");
  const stored = serializeDocument(editor.getDocument());
  const reloaded = parseDocument(stored);
  assertEqual(reloaded.map((block) => blockText(block)).join("|"), "a|b|c", "no list item is lost");
  assertEqual(reloaded[2].depth, 1, "the skipped level is normalized into a real parent level");
  assertEqual(serializeDocument(reloaded), stored, "the normalized list serializes stably");

  editor.deleteBlockAt(1);
  assertEqual(editor.getDocument().length, 2, "the middle item is gone");
  assertEqual(editor.getDocument()[1].depth, 2, "the child's raw depth is left as it was");
  const afterDelete = serializeDocument(editor.getDocument());
  const reparsed = parseDocument(afterDelete);
  assertEqual(reparsed.map((block) => blockText(block)).join("|"), "a|c", "the child survives the parent's deletion");
  assertEqual(serializeDocument(reparsed), afterDelete, "serialization is stable after the deletion");
});

test("lists: saving an indented first item keeps its text", async () => {
  await load("<ul><li>only item</li></ul>");
  editor.collapseTo({ block: 0, offset: 0 });
  editor.sync();
  key("Tab");
  assertEqual(editor.getDocument()[0].depth, 1, "the first item can be indented on its own");
  const stored = serializeDocument(editor.getDocument());
  const reloaded = parseDocument(stored);
  assertEqual(reloaded.length, 1, "the item survives");
  assertEqual(blockText(reloaded[0]), "only item", "its text survives");
  assertEqual(reloaded[0].depth, 0, "an orphan indent becomes a top-level item");
});

test("keyboard: shift-arrows select, Escape collapses, select-all replaces in one undo", async () => {
  await load("<p>abcdef ghij</p>");
  editor.collapseTo({ block: 0, offset: 0 });
  editor.sync();
  for (let index = 0; index < 3; index += 1) {
    key("ArrowRight", { shiftKey: true });
  }
  assertEqual(editor.selectionText(), "abc", "shift-arrow selection");
  assertEqual(root.querySelectorAll(".doc-selection").length, 1, "keyboard selection is painted");
  key("Escape");
  assertEqual(editor.getSelection().collapsed, true, "Escape collapses the selection");
  assertEqual(editor.getSelection().focus.offset, 3, "Escape keeps the focus end");

  key("a", { ctrlKey: true });
  assertEqual(editor.selectionText(), "abcdef ghij", "select all");
  typeText("replacement");
  assertEqual(blockText(editor.getDocument()[0]), "replacement", "typing replaces the document");
  assertEqual(editor.getDocument().length, 1, "one block remains");
  editor.undo();
  assertEqual(blockText(editor.getDocument()[0]), "abcdef ghij", "one undo restores everything");
});

test("keyboard: shift-left paints the backwards selection", async () => {
  await load("<p>abcdef</p>");
  editor.collapseTo({ block: 0, offset: 5 });
  editor.sync();
  key("ArrowLeft", { shiftKey: true });
  key("ArrowLeft", { shiftKey: true });
  const selection = editor.getSelection();
  assertEqual(selection.anchor.offset, 5, "the anchor stays put");
  assertEqual(selection.focus.offset, 3, "the focus moves left");
  assertEqual(editor.selectionText(), "de", "shift-left selects the text to the left");

  const rects = Array.from(root.querySelectorAll(".doc-selection")).map((element) => {
    const box = element.getBoundingClientRect();
    const rect = rootRect();
    return { x: box.left - rect.left, width: box.width };
  });
  assertEqual(rects.length, 1, "a backwards selection is painted");
  const expected = { x: paintedOffsetX(0, 3), width: paintedOffsetX(0, 5) - paintedOffsetX(0, 3) };
  assertClose(rects[0].x, expected.x, 1.5, "the backwards highlight starts at the focus");
  assertClose(rects[0].width, expected.width, 1.5, "the backwards highlight spans the selected text");
});

test("writing: trailing spaces at a wrapped line edge stay visible", async () => {
  await load("<p></p>");
  const text =
    "The quick brown fox jumps over the lazy dog and then keeps running past the riverbank";
  typeText(text);
  for (let index = 0; index < 8; index += 1) {
    key(" ");
    typeInput(" ");
  }
  assertEqual(blockText(editor.getDocument()[0]), text + "        ", "model keeps trailing spaces");
  const painted = paintedText(0);
  assertEqual(painted.split("\n").join(""), text + "        ", "painted text keeps every space");
  assert(painted.endsWith("        "), "trailing spaces are painted at the end of the last line");
});

test("hard break: a second Shift+Enter puts the caret on the empty line", async () => {
  await load("<p></p>");
  typeText("first");
  key("Enter", { shiftKey: true });
  typeText("second");
  key("Enter", { shiftKey: true });
  key("Enter", { shiftKey: true });

  assertEqual(blockText(editor.getDocument()[0]), "first\nsecond\n\n", "model text before the fourth word");
  assertEqual(paintedText(0), "first\nsecond\n", "painted lines before the fourth word");
  const block = entry(0);
  assertEqual(block.lines.length, 3, "painted line count");
  assertEqual(caretLineIndex(0), 2, "caret waits on the empty middle line");
  const point = editor.caretGeometry();
  const line = block.lines[2];
  assert(point && point.line === line, "caret geometry uses the empty line");
  assertClose(point.y, line.y, 0.01, "caret y");

  typeText("fourth");
  assertEqual(blockText(editor.getDocument()[0]), "first\nsecond\n\nfourth", "model text after typing");
  assertEqual(paintedText(0), "first\nsecond\n\nfourth", "painted lines after typing");
  assertEqual(caretLineIndex(0), 3, "caret moves to the typed line");
});

test("arrow keys: moving down from a hard-break line stays inside the block", async () => {
  await load("<p>first\nsecond\n\nfourth</p>");
  editor.collapseTo({ block: 0, offset: "first\nsecond".length });
  editor.sync();
  key("ArrowDown");
  assertEqual(editor.getSelection().focus.block, 0, "stays in the block");
  assertEqual(editor.getSelection().focus.offset, "first\nsecond\n".length, "moves to the empty line");
  key("ArrowDown");
  assertEqual(editor.getSelection().focus.offset, "first\nsecond\n\n".length, "moves to the fourth line start");
});

test("arrow keys: up and down keep the column across wrapped lines", async () => {
  await load(
    "<p>Wrapping prose keeps a column while the arrow keys move between its painted lines, " +
      "so pressing down twice should land on the same x position as far as the words allow.</p>",
  );
  const block = entry(0);
  assert(block.lines.length >= 2, "test text wraps");

  // Start part-way through the first line, on a word boundary, then move down.
  const first = block.lines[0];
  const target = first.fragments.find((fragment) => fragment.x > 160) || first.fragments[0];
  const start = target.start;
  editor.collapseTo({ block: 0, offset: start });
  editor.sync();
  const before = editor.caretGeometry();
  assert(before && before.line === first, "caret starts on the first line");

  key("ArrowDown");
  const after = editor.caretGeometry();
  const selection = editor.getSelection();
  assert(after, "caret exists after ArrowDown");
  const lower = block.lines.indexOf(after.line);
  assert(lower > 0, `ArrowDown should move to a later line, stayed on ${lower}`);
  assertEqual(selection.focus.block, 0, "stays in the block");
  assertClose(after.x, before.x, 12, "column kept within a word width");

  key("ArrowUp");
  const back = editor.caretGeometry();
  assert(back && back.line === first, "ArrowUp returns to the first line");
  assertClose(back.x, before.x, 12, "column kept on the way up");
});

test("caret: typing a space at a soft wrap stays on the written line", async () => {
  await load(
    "<p>Wrapping prose keeps a column while the caret moves and the words reflow around it as the writer types more.</p>",
  );
  let block = entry(0);
  assert(block.lines.length >= 2, "paragraph wraps");
  const firstLine = block.lines[0];
  editor.collapseTo({ block: 0, offset: firstLine.offsetEnd });
  editor.sync();
  editor.insertText(" ");
  block = entry(0);
  const point = editor.caretGeometry();
  assert(point, "caret exists after the space");
  assert(
    point.line === block.lines[0] || point.line === block.lines[1],
    "the caret stays on a painted line",
  );
  assertEqual(
    paintedText(0).split("\n").join(""),
    blockText(editor.getDocument()[0]).replace(/\n/g, ""),
    "the extra space is painted",
  );
});

test("pointer: clicking at a soft wrap puts the caret on the clicked line", async () => {
  await load(
    "<p>Wrapping prose puts the offset at a soft wrap on both lines, so a click near the " +
      "beginning of the second painted line has to grow a caret on that second line.</p>",
  );
  const block = entry(0);
  assert(block.lines.length >= 2, "test text wraps");
  const second = block.lines[1];
  clickAt(second.x + 3, second.y + second.height / 2);
  const point = editor.caretGeometry();
  const selection = editor.getSelection();
  assert(point, "caret exists after the click");
  assert(point.line === second, "caret is painted on the clicked line");
  assertEqual(selection.focus.block, 0, "clicked block");
  assertEqual(selection.focus.offset, second.offsetStart, "clicked offset");

  // The same offset reached without a click hint stays at the end of the
  // earlier line, where the last character the writer typed actually lives.
  editor.lineHint = null;
  editor.collapseTo({ block: 0, offset: second.offsetStart });
  editor.sync();
  const plain = editor.caretGeometry();
  assert(plain && plain.line === block.lines[0], "without a hint the caret stays above the wrap");
});

test("code blocks: caret, clicks, and selection follow the code text", async () => {
  await load("<pre>alpha beta\nsecond line\n\nfourth</pre>");
  const block = entry(0);
  assertEqual(block.lines.length, 4, "four painted code lines");
  assertEqual(block.lines[0].offsetStart, 0, "first line starts at zero");
  assertEqual(block.lines[0].offsetEnd, 10, "first line ends before its newline");
  assertEqual(block.lines[1].offsetStart, 11, "second line starts after the newline");
  assertEqual(block.lines[1].offsetEnd, 22, "second line ends before its newline");
  assertEqual(block.lines[2].offsetStart, 23, "the empty line owns its offset");
  assertEqual(block.lines[3].offsetStart, 24, "last line starts after both newlines");

  const offset = 14;
  const point = caretPoint(block, offset);
  assert(point && point.line === block.lines[1], "caret geometry lands on the second code line");
  const painted = paintedOffsetX(0, offset);
  assert(painted !== null, "painted code boundary exists");
  assertClose(point.x, painted, 1.5, "caret sits on the painted code glyph edge");

  clickAt(painted + 0.4, point.y + point.height / 2);
  assertEqual(editor.getSelection().focus.offset, offset, "click maps to the code offset");

  const from = paintedOffsetX(0, 11);
  const to = paintedOffsetX(0, 22);
  const startPoint = caretPoint(block, 11);
  const endPoint = caretPoint(block, 22);
  dragFromTo(from + 0.5, startPoint.y + startPoint.height / 2, to - 0.5, endPoint.y + endPoint.height / 2);
  assertEqual(editor.selectionText(), "second line", "dragging selects code text");

  const empty = block.lines[2];
  clickAt(empty.x + 20, empty.y + empty.height / 2);
  const emptySelection = editor.getSelection();
  const emptyPoint = editor.caretGeometry();
  assertEqual(emptySelection.focus.offset, empty.offsetStart, "clicking the empty code line selects its offset");
  assert(emptyPoint && emptyPoint.line === empty, "caret sits on the empty code line");
});

test("hard breaks: typing a break, saving it, and reloading keeps the break", async () => {
  await load("<p></p>");
  typeText("first");
  key("Enter", { shiftKey: true });
  typeText("second");
  const blocks = editor.getDocument();
  assertEqual(blockText(blocks[0]), "first\nsecond", "the break is a line feed in the model");
  const stored = serializeDocument(blocks);
  assertEqual(stored, "<p>first<br>second</p>", "the break is stored as a br tag");
  const reloaded = parseDocument(stored);
  assertEqual(blockText(reloaded[0]), "first\nsecond", "the reloaded document still has its break");
  editor.setDocument(reloaded);
  await settle();
  assertEqual(paintedText(0), "first\nsecond", "the reloaded break paints two lines");
});

test("code blocks: a wrapped code line keeps the caret on the clicked line", async () => {
  await load("<pre>const message = one two three four five six seven eight nine ten eleven twelve thirteen fourteen;</pre>");
  const block = entry(0);
  assert(block.lines.length >= 2, "the long code line wraps");
  const second = block.lines[1];
  assert(second.softWrapped, "the second line is a soft continuation");
  assertEqual(block.lines[0].offsetEnd, second.offsetStart, "the wrapped lines share their boundary offset");

  const hintPoint = caretPoint(block, second.offsetStart, second);
  assert(hintPoint && hintPoint.line === second, "a line hint shows the caret at the continuation start");
  const plain = caretPoint(block, second.offsetStart);
  assert(plain && plain.line === block.lines[0], "without a hint the caret stays at the earlier line's end");

  clickAt(second.x + 2, second.y + second.height / 2);
  const selection = editor.getSelection();
  assertEqual(selection.focus.offset, second.offsetStart, "clicking the continuation start");
  const point = editor.caretGeometry();
  assert(point && point.line === second, "the caret is painted on the clicked code line");
});

test("alignment: right, center, and justified lines align their visible glyphs", async () => {
  const longText =
    "Right aligned words in a paragraph that has enough words to fill several wrapped lines " +
    "and still leave a small ragged edge at the end of each one of those lines.";
  await load(`<p data-align="right">${longText}</p>`);
  let block = entry(0);
  assert(block.lines.length >= 2, "right-aligned paragraph wraps");
  for (let lineIndex = 0; lineIndex < block.lines.length - 1; lineIndex += 1) {
    const line = block.lines[lineIndex];
    const last = line.fragments[line.fragments.length - 1];
    const visible = last.text.replace(/\s+$/, "");
    if (!visible) {
      continue;
    }
    const boundary = paintedOffsetX(0, last.start + visible.length);
    assertClose(
      boundary,
      line.boxRight,
      1.5,
      `right-aligned line ${lineIndex} ends at the right edge`,
    );
  }

  await load(`<p data-align="center">${longText}</p>`);
  block = entry(0);
  for (let lineIndex = 0; lineIndex < block.lines.length - 1; lineIndex += 1) {
    const line = block.lines[lineIndex];
    if (!line.fragments.length) {
      continue;
    }
    const first = line.fragments[0];
    const last = line.fragments[line.fragments.length - 1];
    const visible = last.text.replace(/\s+$/, "");
    if (!visible) {
      continue;
    }
    const left = paintedOffsetX(0, first.start);
    const right = paintedOffsetX(0, last.start + visible.length);
    assertClose(
      left - line.boxX,
      line.boxRight - right,
      1.5,
      `centered line ${lineIndex} keeps equal margins`,
    );
  }

  await load(`<p data-align="justify">${longText}</p>`);
  block = entry(0);
  for (let lineIndex = 0; lineIndex < block.lines.length - 1; lineIndex += 1) {
    const line = block.lines[lineIndex];
    const last = line.fragments[line.fragments.length - 1];
    const visible = last.text.replace(/\s+$/, "");
    if (!visible) {
      continue;
    }
    const boundary = paintedOffsetX(0, last.start + visible.length);
    assertClose(
      boundary,
      line.boxRight,
      1.5,
      `justified line ${lineIndex} ends at the right edge`,
    );
  }
});

test("code blocks: a very long code token wraps inside the box", async () => {
  await load("<pre></pre>");
  const token = "z".repeat(220);
  editor.insertText(token);
  const block = entry(0);
  assert(block.lines.length >= 2, "the long token uses more than one line");
  for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex += 1) {
    const line = block.lines[lineIndex];
    const fragment = line.fragments[0];
    assert(
      fragment.width <= line.width + 1,
      `code line ${lineIndex} stays inside its width: ${formatNumber(fragment.width)} > ${formatNumber(line.width)}`,
    );
  }
  assertEqual(paintedText(0).split("\n").join(""), token, "the token is painted in full");
});

test("code blocks: Enter at the end saves a trailing code line break", async () => {
  await load("<pre>a</pre>");
  editor.collapseTo({ block: 0, offset: 1 });
  editor.sync();
  key("Enter");
  assertEqual(blockText(editor.getDocument()[0]), "a\n", "the newline is in the code block");
  assertEqual(entry(0).lines.length, 1, "a trailing line feed does not open an extra line by itself");
  typeText("b");
  assertEqual(blockText(editor.getDocument()[0]), "a\nb", "typing continues on the new line");
  assertEqual(paintedText(0), "a\nb", "both code lines paint");
  const stored = serializeDocument(editor.getDocument());
  const reloaded = parseDocument(stored);
  assertEqual(blockText(reloaded[0]), "a\nb", "the code block round-trips");
  assertEqual(reloaded[0].type, "code", "it stays a code block");
});

test("pointer: clicking an empty paragraph places a caret at its start", async () => {
  await load("<p>Some text above the empty paragraph.</p><p></p><p>Some text below.</p>");
  const empty = entry(1);
  const line = empty.lines[0];
  clickAt(line.x + 40, line.y + line.height / 2);
  const selection = editor.getSelection();
  assertEqual(selection.focus.block, 1, "clicked block");
  assertEqual(selection.focus.offset, 0, "clicked offset");
  const point = editor.caretGeometry();
  assert(point && Math.abs(point.y - line.y) < 0.01, "caret sits on the empty line");
});

test("pointer: selection rectangles cover the selected painted text", async () => {
  await load("<p>Select these five words and nothing more.</p>");
  const text = blockText(editor.getDocument()[0]);
  const start = text.indexOf("these");
  const end = text.indexOf(" and");
  const from = paintedOffsetX(0, start);
  const to = paintedOffsetX(0, end);
  const a = caretPoint(entry(0), start);
  const b = caretPoint(entry(0), end);
  dragFromTo(from + 0.5, a.y + a.height / 2, to - 0.5, b.y + b.height / 2);
  assertEqual(editor.selectionText(), "these five words", "selected text");

  const rects = Array.from(root.querySelectorAll(".doc-selection")).map((element) => {
    const box = element.getBoundingClientRect();
    const rect = rootRect();
    return {
      x: box.left - rect.left,
      y: box.top - rect.top,
      width: box.width,
      height: box.height,
    };
  });
  assert(rects.length >= 1, "selection painted");
  const firstLine = entry(0).lines[0];
  const painted = rects.reduce((sum, rect) => sum + rect.width, 0);
  assert(
    painted > 40,
    `selection rectangles should cover a visible span, covered ${formatNumber(painted)} px`,
  );
  assertClose(rects[0].y, firstLine.y, 0.5, "first selection rect y");
});

test("alignment: trailing spaces hang on the final line too", async () => {
  await load('<p data-align="right">abc </p><p data-align="center">abc </p>');
  const right = entry(0);
  const rightEnd = paintedOffsetX(0, 3);
  assertClose(rightEnd, right.lines[0].boxRight, 1.5, "right-aligned final glyph is flush right");

  const center = entry(1);
  const first = paintedOffsetX(1, 0);
  const last = paintedOffsetX(1, 3);
  assertClose(
    first - center.lines[0].boxX,
    center.lines[0].boxRight - last,
    1.5,
    "centered final glyph keeps equal margins",
  );
});

test("selection: justified highlights match the painted text", async () => {
  await load(
    '<p data-align="justify">Selecting justified prose has to paint the same stretched spaces that are on the screen, ' +
      "across a line break, without drifting away from the glyphs at either end of the selection.</p>",
  );
  const block = entry(0);
  assert(block.lines.length >= 2, "justified paragraph wraps");
  const start = 12;
  const end = block.lines[1].offsetStart + 14;
  const from = caretPoint(block, start);
  const to = caretPoint(block, end);
  dragFromTo(
    paintedOffsetX(0, start) + 0.5,
    from.y + from.height / 2,
    paintedOffsetX(0, end) - 0.5,
    to.y + to.height / 2,
  );
  assertEqual(editor.selectionText(), blockText(editor.getDocument()[0]).slice(start, end), "selected text");
  const rects = Array.from(root.querySelectorAll(".doc-selection")).map((element) => {
    const box = element.getBoundingClientRect();
    const rect = rootRect();
    return { x: box.left - rect.left, width: box.width };
  });
  assertEqual(rects.length, 2, "one highlight per selected painted line");
  const firstEnd = block.lines[0].offsetEnd;
  const expected = [
    { x: paintedOffsetX(0, start), width: paintedOffsetX(0, firstEnd) - paintedOffsetX(0, start) },
    {
      x: block.lines[1].fragments[0].x,
      width: paintedOffsetX(0, end) - block.lines[1].fragments[0].x,
    },
  ];
  for (let index = 0; index < 2; index += 1) {
    assertClose(rects[index].x, expected[index].x, 1.5, `justified highlight ${index} x`);
    assertClose(rects[index].width, expected[index].width, 2, `justified highlight ${index} width`);
  }
});

test("model: parse and serialize round-trip preserves writing", async () => {
  const html =
    "<h1>A heading</h1>" +
    "<p>Plain <b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <code>code</code> " +
    '<a href="https://example.com/">link</a> and a hard<br>break.</p>' +
    '<blockquote data-align="center">A quote</blockquote>' +
    "<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>" +
    "<ol><li>First</li></ol>" +
    "<pre>let x = 1;\nlet y = 2;</pre>" +
    '<p data-align="right" data-indent="2">Aligned</p>' +
    '<img class="free" data-x="20" data-y="40" data-width="120" width="400" height="300" alt="Picture" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">';
  const blocks = parseDocument(html);
  assertEqual(blocks.length, 10, "block count");
  const serialized = serializeDocument(blocks);
  const reparsed = parseDocument(serialized);
  assertEqual(serializeDocument(reparsed), serialized, "serialization is stable");

  const text = "A hard break, three spaces, and a tab: x   y\tz";
  const blocks2 = parseDocument("<p>" + text.replace(/\t/g, "&#9;") + "</p>");
  assertEqual(blockText(blocks2[0]), text, "multiple spaces and tabs survive parsing");
  assertEqual(serializeDocument(blocks2), "<p>" + text + "</p>", "spaces serialized");

  const breaks = parseDocument("<p>one<br><br>two</p>");
  assertEqual(blockText(breaks[0]), "one\n\ntwo", "hard breaks parse as line feeds");
  const breaksHtml = serializeDocument(breaks);
  assertEqual(breaksHtml, "<p>one<br><br>two</p>", "hard breaks serialize as real tags");
  assert(!breaksHtml.includes("&lt;br"), "line feeds never become escaped tag text");
  assertEqual(blockText(parseDocument(breaksHtml)[0]), "one\n\ntwo", "hard breaks round-trip");
});

test("model: empty paragraphs survive a save and reload", async () => {
  await load("<p>above</p>");
  editor.collapseTo({ block: 0, offset: "above".length });
  editor.sync();
  key("Enter");
  key("Enter");
  typeText("below");
  const blocks = editor.getDocument();
  assertEqual(blocks.length, 3, "three paragraphs while editing");
  assertEqual(blockText(blocks[1]), "", "middle paragraph is empty");

  const stored = serializeDocument(blocks);
  const reloaded = parseDocument(stored);
  assertEqual(reloaded.length, 3, "three paragraphs after parsing the stored HTML");
  assertEqual(blockText(reloaded[0]), "above", "first paragraph");
  assertEqual(blockText(reloaded[1]), "", "empty paragraph kept");
  assertEqual(blockText(reloaded[2]), "below", "last paragraph");
  assertEqual(serializeDocument(reloaded), stored, "round-trips unchanged");
});

test("model: editing operations keep text and caret consistent", async () => {
  await load("<p>hello world</p>");
  editor.collapseTo({ block: 0, offset: 5 });
  editor.sync();
  editor.insertText(" there");
  assertEqual(blockText(editor.getDocument()[0]), "hello there world", "insert in the middle");
  assertEqual(editor.getSelection().focus.offset, "hello there".length, "caret after insert");

  editor.backspace();
  assertEqual(blockText(editor.getDocument()[0]), "hello ther world", "backspace deletes one char");

  editor.undo();
  assertEqual(blockText(editor.getDocument()[0]), "hello there world", "undo restores typing");
  editor.redo();
  assertEqual(blockText(editor.getDocument()[0]), "hello ther world", "redo restores deletion");
});

/* --------------------------------------------------------------------------
   Runner
   -------------------------------------------------------------------------- */

async function run() {
  const results = { tests: [], notes };
  try {
    await createEditor();
  } catch (error) {
    results.setupError = error && error.stack ? error.stack : String(error);
    window.__results = results;
    return;
  }

  for (const item of tests) {
    const started = performance.now();
    try {
      await item.fn();
      results.tests.push({
        name: item.name,
        ok: true,
        duration: Math.round(performance.now() - started),
      });
    } catch (error) {
      results.tests.push({
        name: item.name,
        ok: false,
        duration: Math.round(performance.now() - started),
        detail: error && error.stack ? error.stack : String(error),
      });
    }
  }

  if (uncaughtErrors.length) {
    results.tests.push({
      name: "no uncaught errors in the page",
      ok: false,
      detail: uncaughtErrors.slice(0, 8).join("\n"),
    });
  }
  window.__results = results;
}

run();
