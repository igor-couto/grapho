// Tests for the Markdown mode conversion layer (assets/doc/markdown.js).
//
// editor.test.js owns the harness runner: it collects window.__extraTests,
// runs them after its own tests, and reports failures the same way. This file
// only registers tests, so it does not need its own runner or DOM setup.
//
// The tests are deliberately model-shaped: they compare runs and serialized
// HTML instead of pixels, because the conversion layer is pure.

import {
  blockToLines,
  inlineToRuns,
  lineToBlocks,
  mapRichCaretToSource,
  mapSourceCaretToRich,
  readLine,
  richToSource,
  runsToInline,
  sourceLineInfo,
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

window.__extraTests = window.__extraTests || [];

function test(name, fn) {
  window.__extraTests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function deepEqual(actual, expected) {
  if (actual === expected) {
    return true;
  }
  if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) {
    return false;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    return false;
  }
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) {
    return false;
  }
  return actualKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(expected, key) && deepEqual(actual[key], expected[key]),
  );
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function assertDeepEqual(actual, expected, message) {
  if (!deepEqual(actual, expected)) {
    throw new Error(message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

function sourceBlock(text) {
  const block = createBlock("p", text ? [{ text }] : []);
  block.source = true;
  return block;
}

function sourceBlocks(lines) {
  return lines.map(sourceBlock);
}

function listBlock(text, ordered, depth) {
  const block = createBlock("list", text ? [{ text }] : []);
  block.ordered = ordered;
  block.depth = depth;
  return block;
}

function sourceTexts(blocks) {
  return blocks.map((block) => (block.type === "image" ? "[image]" : blockText(block)));
}

function sourceOf(html) {
  return sourceTexts(richToSource(parseDocument(html)).blocks);
}

function assertLossless(html, message) {
  const blocks = parseDocument(html);
  const first = richToSource(blocks);
  const back = sourceToRich(first.blocks);
  assertEqual(
    serializeDocument(back.blocks),
    serializeDocument(blocks),
    (message || html) + " round-trips through Markdown source",
  );

  // Converting the result again must produce exactly the same source lines, so
  // entering and leaving the mode is stable rather than just reversible once.
  const second = richToSource(back.blocks);
  assertDeepEqual(sourceTexts(second.blocks), sourceTexts(first.blocks), (message || html) + " source lines are stable");
}

function assertLosslessBlocks(blocks, message) {
  const first = richToSource(blocks);
  const back = sourceToRich(first.blocks);
  assertEqual(
    serializeDocument(back.blocks),
    serializeDocument(blocks),
    (message || "hand-built document") + " round-trips through Markdown source",
  );
}

/* --------------------------------------------------------------------------
   Emitter: exact source lines
   -------------------------------------------------------------------------- */

test("markdown emitter: headings, quotes, and plain paragraphs", async () => {
  assertDeepEqual(sourceOf("<h1>A</h1><h2>B</h2><h3>C</h3>"), ["# A", "## B", "### C"], "headings");
  assertDeepEqual(sourceOf("<blockquote>quoted</blockquote>"), ["> quoted"], "quote");
  assertDeepEqual(sourceOf("<p>plain</p>"), ["plain"], "paragraph");
  assertDeepEqual(sourceOf("<p>one</p><p>two</p>"), ["one", "two"], "two paragraphs, no cosmetic blank line");
  assertDeepEqual(sourceOf("<h2></h2>"), ["## "], "empty heading keeps its marker");
  assertDeepEqual(sourceOf("<blockquote></blockquote>"), ["> "], "empty quote keeps its marker");
});

test("markdown emitter: placeholder document is one empty source line", async () => {
  const empty = parseDocument("<p></p>");
  const conversion = richToSource(empty);
  assertEqual(conversion.blocks.length, 1, "one source line");
  assertEqual(conversion.blocks[0].type, "p", "source block is a paragraph");
  assertEqual(conversion.blocks[0].source, true, "source block is marked as source");
  assertEqual(blockText(conversion.blocks[0]), "", "source line is empty");
  assertEqual(conversion.lineMap.length, 1, "lineMap matches");
  assertEqual(conversion.richLines.length, 1, "richLines matches");
  assertEqual(sourceToRich(conversion.blocks).blocks.length, 1, "parses back to one paragraph");
});

test("markdown emitter: empty paragraphs are blank source lines", async () => {
  assertDeepEqual(sourceOf("<p>a</p><p></p><p>b</p>"), ["a", "", "b"], "middle empty paragraph");
  assertDeepEqual(sourceOf("<p></p><p>a</p>"), ["", "a"], "leading empty paragraph");
  assertDeepEqual(sourceOf("<p>a</p><p></p>"), ["a", ""], "trailing empty paragraph");
  assertDeepEqual(sourceOf("<p></p><p></p>"), ["", ""], "two empty paragraphs");
});

test("markdown emitter: inline marks", async () => {
  const html =
    "<p>a <b>bold</b> <i>italic</i> <s>strike</s> <u>under</u> <code>code</code> " +
    '<a href="https://example.com/">link</a></p>';
  assertDeepEqual(
    sourceOf(html),
    ["a **bold** *italic* ~~strike~~ <u>under</u> `code` [link](https://example.com/)"],
    "every inline mark",
  );
  assertDeepEqual(sourceOf("<p><b><i>both</i></b></p>"), ["***both***"], "bold+italic");
  assertDeepEqual(
    sourceOf("<p><b><u>bold under</u></b></p>"),
    ["**<u>bold under</u>**"],
    "bold+underline",
  );
  assertDeepEqual(sourceOf("<p>one<br>two</p>"), ["one<br>two"], "hard break stays on one line");
  assertDeepEqual(
    sourceOf("<p><b>a<br>b</b></p>"),
    ["**a<br>b**"],
    "hard break inside a mark",
  );
});

test("markdown emitter: lists, nesting, and ordered numbering", async () => {
  assertDeepEqual(sourceOf("<ul><li>a</li><li>b</li></ul>"), ["- a", "- b"], "unordered list");
  assertDeepEqual(sourceOf("<ol><li>one</li><li>two</li></ol>"), ["1. one", "2. two"], "ordered list numbers");
  assertDeepEqual(
    sourceOf("<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>"),
    ["- a", "- b", "  - c"],
    "nested unordered list",
  );
  assertDeepEqual(
    sourceOf("<ol><li>a<ol><li>b</li></ol></li></ol>"),
    ["1. a", "  1. b"],
    "nested ordered list",
  );
  assertDeepEqual(sourceOf("<ul><li></li></ul>"), ["- "], "empty list item");

  const handBuilt = [listBlock("a", false, 0), listBlock("b", false, 1), listBlock("c", false, 2)];
  assertDeepEqual(sourceTexts(richToSource(handBuilt).blocks), ["- a", "  - b", "    - c"], "depth indentation");
});

test("markdown emitter: fenced code blocks", async () => {
  assertDeepEqual(sourceOf("<pre>a\nb</pre>"), ["```", "a", "b", "```"], "plain code");
  assertDeepEqual(sourceOf("<pre></pre>"), ["```", "", "```"], "empty code has one empty line");
  assertDeepEqual(sourceOf("<pre>a\n</pre>"), ["```", "a", "", "```"], "trailing newline is an empty line");
  assertDeepEqual(sourceOf("<pre>a\n\nb</pre>"), ["```", "a", "", "b", "```"], "blank line inside code");
  assertDeepEqual(sourceOf("<pre>a ``` b</pre>"), ["````", "a ``` b", "````"], "fence grows past backticks");
  assertDeepEqual(sourceOf("<pre>````</pre>"), ["`````", "````", "`````"], "fence beats the longest run");
});

test("markdown emitter: rich-only attributes use the HTML escape hatch", async () => {
  assertDeepEqual(sourceOf('<p data-align="center">x</p>'), ['<p data-align="center">x</p>'], "aligned paragraph");
  assertDeepEqual(sourceOf('<h2 data-indent="2">T</h2>'), ['<h2 data-indent="2">T</h2>'], "indented heading");
  assertDeepEqual(
    sourceOf('<p data-align="right" data-indent="3">x</p>'),
    ['<p data-align="right" data-indent="3">x</p>'],
    "aligned and indented paragraph",
  );
  assertDeepEqual(
    sourceOf('<blockquote data-align="center">q</blockquote>'),
    ['<blockquote><p data-align="center">q</p></blockquote>'],
    "quote alignment rides on the inner paragraph",
  );
  assertDeepEqual(
    sourceOf('<ul><li data-align="center">x</li></ul>'),
    ['<ul data-depth="0" data-ordered="0"><li data-align="center">x</li></ul>'],
    "list item attributes carry explicit depth",
  );
  assertDeepEqual(
    sourceOf('<ol><li data-indent="2">x</li></ol>'),
    ['<ol data-depth="0" data-ordered="1"><li data-indent="2">x</li></ol>'],
    "ordered list item with indent",
  );
  assertDeepEqual(
    sourceOf('<ul><li>plain</li><li data-align="center">aligned</li></ul>'),
    ["- plain", '<ul data-depth="0" data-ordered="0"><li data-align="center">aligned</li></ul>'],
    "attribute-carried item next to a Markdown one",
  );
});

test("markdown emitter: escaping keeps text literal", async () => {
  const block = createBlock("p", [{ text: "a*b_c~d`e[f]g<h\\i" }]);
  assertDeepEqual(blockToLines(block), ["a\\*b\\_c\\~d\\`e\\[f\\]g\\<h\\\\i"], "inline punctuation");

  assertDeepEqual(blockToLines(createBlock("p", [{ text: "# not a heading" }])), ["\\# not a heading"], "hash");
  assertDeepEqual(blockToLines(createBlock("p", [{ text: "> not a quote" }])), ["\\> not a quote"], "angle");
  assertDeepEqual(blockToLines(createBlock("p", [{ text: "- not a list" }])), ["\\- not a list"], "dash");
  assertDeepEqual(blockToLines(createBlock("p", [{ text: "+ not a list" }])), ["\\+ not a list"], "plus");
  assertDeepEqual(blockToLines(createBlock("p", [{ text: "1. not a list" }])), ["1\\. not a list"], "number");
  assertDeepEqual(blockToLines(createBlock("p", [{ text: "2024. a year" }])), ["2024\\. a year"], "long number");
  assertDeepEqual(blockToLines(createBlock("p", [{ text: "not # structural" }])), ["not # structural"], "mid-line characters stay");

  const literal = createBlock("p", [{ text: "\\<b>literal\\</b>" }]);
  assertEqual(serializeDocument(sourceToRich(richToSource([literal]).blocks).blocks), serializeDocument([literal]), "escaped text round-trips");
});

test("markdown emitter: images pass through and split the text", async () => {
  const html =
    "<p>a</p>" +
    '<img class="free" data-x="10" data-y="20" data-width="50" width="100" height="60" alt="pic" ' +
    'src="data:image/png;base64,AAAA">' +
    "<p>b</p>";
  const blocks = parseDocument(html);
  const conversion = richToSource(blocks);
  assertDeepEqual(
    conversion.blocks.map((block) => block.type),
    ["p", "image", "p"],
    "source block types",
  );
  assertDeepEqual(sourceTexts(conversion.blocks), ["a", "[image]", "b"], "images split the text");
  assert(conversion.blocks[1] === blocks[1], "the image block is passed through by identity");
  assertEqual(conversion.blocks[1].mode, "free", "image mode is preserved");
  assertEqual(conversion.blocks[1].x, 10, "image x is preserved");
  assertEqual(conversion.lineMap[1], null, "image has no line map entry");
  assertEqual(conversion.richLines[1], null, "image has no rich line entry");

  const back = sourceToRich(conversion.blocks);
  assertEqual(back.blocks.length, 3, "image keeps its place between text");
  assert(back.blocks[1] === blocks[1], "image passes through sourceToRich unchanged");
  assertEqual(serializeDocument(back.blocks), serializeDocument(blocks), "image document round-trips");
});

/* --------------------------------------------------------------------------
   Lossless round trip over the corpus
   -------------------------------------------------------------------------- */

const CORPUS = [
  "<h1>Heading one</h1>",
  '<h2 data-align="center">Centered heading</h2>',
  '<h3 data-indent="2">Indented heading</h3>',
  "<h1></h1>",
  "<p>Plain paragraph with <b>bold</b>, <i>italic</i>, <s>strike</s>, <u>underline</u> and <code>inline code</code>.</p>",
  "<p><b><i>both</i></b> and <b>bold <i>nested</i> after</b></p>",
  "<p><b><u>bold underline</u></b> and <i><s>italic strike</s></i></p>",
  '<p><a href="https://example.com/path?q=1&amp;r=2">a link</a> and <a href="mailto:hi@example.com">mail</a></p>',
  "<p>hard<br>break and another<br><br>double break</p>",
  "<p><b>a<br>b</b></p>",
  '<p data-align="center">Centered</p>',
  '<p data-align="right" data-indent="3">Right and indented</p>',
  '<p data-align="justify">Justified text that is long enough to matter.</p>',
  "<blockquote>A quote</blockquote>",
  '<blockquote data-align="center">Aligned quote</blockquote>',
  '<blockquote data-indent="2">Indented quote</blockquote>',
  "<blockquote><p>text<br>break</p></blockquote>",
  "<blockquote></blockquote>",
  "<ul><li>one</li><li>two</li></ul>",
  "<ol><li>first</li><li>second</li></ol>",
  "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>",
  "<ul><li></li><li><b>marked</b></li></ul>",
  '<ul><li data-align="center">aligned item</li></ul>',
  "<pre>code line one\ncode line two</pre>",
  "<pre></pre>",
  "<pre>a\n\nb</pre>",
  "<pre>backtick ``` here</pre>",
  "<pre>trailing\n</pre>",
  "<pre>````</pre>",
  "<p></p>",
  "<p>leading</p><p></p><p>middle</p><p></p>",
  "<p><code>`tick`</code> and <code>a``b</code></p>",
  "<p><code>a<br>b</code></p>",
  "<p><u><b>bold underline</b></u></p>",
  "<p>a *not bold* and a literal \\ backslash</p>",
  '<p data-align="center"></p>',
  "<ul><li>one</li></ul><ol><li>two</li></ol>",
  '<img class="wrap-left" alt="wrap" width="40" height="30" src="data:image/png;base64,AAAA">',
  '<p>before</p><img class="free" data-x="-5" data-y="12" data-width="30" data-radius="8" alt="free" ' +
    'width="40" height="30" src="data:image/gif;base64,BBBB"><p>after</p>',
  '<img alt="block" width="20" height="10" src="data:image/jpeg;base64,CCCC">',
];

test("markdown lossless: every construct round-trips through source", async () => {
  for (const html of CORPUS) {
    assertLossless(html);
  }
});

test("markdown lossless: hand-built block combinations round-trip", async () => {
  const marked = createBlock("p", [
    { text: "bold", b: true },
    { text: " and ", },
    { text: "bold italic", b: true, i: true },
    { text: " plus " },
    { text: "a*b", b: true, i: true, u: true, s: true, code: true },
    { text: " linked", href: "https://example.com/x" },
  ]);
  assertLosslessBlocks([marked], "combined marks");

  const aligned = createBlock("quote", [{ text: "quote", b: true }]);
  aligned.align = "right";
  aligned.indent = 2;
  assertLosslessBlocks([aligned], "aligned quote");

  const deep = [listBlock("a", true, 0), listBlock("b", true, 0), listBlock("c", true, 1), listBlock("d", false, 0)];
  assertLosslessBlocks(deep, "list mix");

  const codeAcrossBreak = createBlock("p", [{ text: "a\nb", code: true }]);
  assertLosslessBlocks([codeAcrossBreak], "code across a hard break uses HTML");

  const longHref = createBlock("p", [{ text: "wiki", href: "https://example.com/wiki/Foo_(bar)" }]);
  assertLosslessBlocks([longHref], "href with balanced parentheses");
});

test("markdown lossless: toggling a document that changes nothing keeps its bytes", async () => {
  const html = "<h2>Title</h2><p>Some <b>bold</b> text.</p><ul><li>one</li></ul><pre>x()`</pre>";
  const blocks = parseDocument(html);
  const stored = serializeDocument(blocks);
  const source = richToSource(blocks);
  const back = sourceToRich(source.blocks);
  assertEqual(serializeDocument(back.blocks), stored, "stored HTML is byte-identical");
});

/* --------------------------------------------------------------------------
   Parser: user-typed Markdown
   -------------------------------------------------------------------------- */

test("markdown parser: every block form", async () => {
  const lines = ["# H1", "## H2", "### H3", "> quoted", "- item", "  * nested", "1. ordered", "    3. deep", "plain"];
  const blocks = sourceToRich(sourceBlocks(lines)).blocks;
  assertDeepEqual(
    blocks.map((block) => block.type),
    ["h1", "h2", "h3", "quote", "list", "list", "list", "list", "p"],
    "block types",
  );
  assertDeepEqual(
    blocks.map((block) => blockText(block)),
    ["H1", "H2", "H3", "quoted", "item", "nested", "ordered", "deep", "plain"],
    "block text",
  );
  assertEqual(blocks[4].ordered, false, "dash item is unordered");
  assertEqual(blocks[4].depth, 0, "dash item is at depth 0");
  assertEqual(blocks[5].ordered, false, "star item is unordered");
  assertEqual(blocks[5].depth, 1, "two spaces nest one level");
  assertEqual(blocks[6].ordered, true, "number item is ordered");
  assertEqual(blocks[6].depth, 0, "ordered item at depth 0");
  assertEqual(blocks[7].ordered, true, "deep ordered item");
  assertEqual(blocks[7].depth, 2, "four spaces nest two levels");
});

test("markdown parser: blank lines become empty paragraphs", async () => {
  const blocks = sourceToRich(sourceBlocks(["a", "", "   ", "", "b"])).blocks;
  assertEqual(blocks.length, 5, "every blank line keeps its paragraph");
  assertDeepEqual(blocks.map((block) => blockText(block)), ["a", "", "", "", "b"], "text");
  assertEqual(blocks[1].type, "p", "blank line paragraph type");
  assertEqual(blockLength(blocks[1]), 0, "blank line paragraph is empty");
  assertEqual(sourceToRich([]).blocks.length, 1, "empty input still gives a paragraph");
  assertEqual(sourceToRich([]).blocks[0].type, "p", "empty input paragraph type");
  assertEqual(blockLength(sourceToRich([]).blocks[0]), 0, "empty input paragraph is empty");
});

test("markdown parser: fences, blank content, and a missing close", async () => {
  const content = (lines) => {
    const blocks = sourceToRich(sourceBlocks(lines)).blocks;
    assertEqual(blocks.length, 1, "one fenced block: " + JSON.stringify(lines));
    assertEqual(blocks[0].type, "code", "code type: " + JSON.stringify(lines));
    return blockText(blocks[0]);
  };
  assertEqual(content(["```", "a", "b", "```"]), "a\nb", "two content lines");
  assertEqual(content(["```", "a", "", "b", "```"]), "a\n\nb", "blank line is content inside a fence");
  assertEqual(content(["```", "", "x", "```"]), "\nx", "leading blank content line");
  assertEqual(content(["```", "a", "b"]), "a\nb", "unclosed fence runs to the end");
  assertEqual(content(["````", "a ``` b", "````"]), "a ``` b", "longer fence holds backticks");
  assertEqual(content(["```", "a", "``", "b", "```"]), "a\n``\nb", "shorter backtick line stays content");
  assertEqual(content(["```", "```"]), "", "empty fence");
});

test("markdown parser: inline forms", async () => {
  assertDeepEqual(inlineToRuns("**bold**"), [{ text: "bold", b: true }], "asterisk bold");
  assertDeepEqual(inlineToRuns("__bold__"), [{ text: "bold", b: true }], "underscore bold");
  assertDeepEqual(inlineToRuns("*italic*"), [{ text: "italic", i: true }], "asterisk italic");
  assertDeepEqual(inlineToRuns("_italic_"), [{ text: "italic", i: true }], "underscore italic");
  assertDeepEqual(inlineToRuns("***both***"), [{ text: "both", b: true, i: true }], "bold and italic");
  assertDeepEqual(inlineToRuns("~~struck~~"), [{ text: "struck", s: true }], "strike");
  assertDeepEqual(inlineToRuns("`code`"), [{ text: "code", code: true }], "inline code");
  assertDeepEqual(inlineToRuns("``a`b``"), [{ text: "a`b", code: true }], "code with backticks");
  assertDeepEqual(inlineToRuns("[label](https://example.com)"), [{ text: "label", href: "https://example.com" }], "link");
  assertDeepEqual(inlineToRuns("[mail](mailto:a@b.c)"), [{ text: "mail", href: "mailto:a@b.c" }], "mailto link");
  assertDeepEqual(inlineToRuns("<u>under</u>"), [{ text: "under", u: true }], "underline");
  assertDeepEqual(inlineToRuns("one<br>two"), [{ text: "one\ntwo" }], "hard break");
  assertDeepEqual(inlineToRuns("\\*not italic\\*"), [{ text: "*not italic*" }], "escaped markers");

  assertDeepEqual(
    inlineToRuns("**a *b* c**"),
    [{ text: "a ", b: true }, { text: "b", b: true, i: true }, { text: " c", b: true }],
    "nested markers",
  );
  assertDeepEqual(
    inlineToRuns("***<u>~~`x`~~</u>***"),
    [{ text: "x", b: true, i: true, u: true, s: true, code: true }],
    "combined marks",
  );
  assertDeepEqual(
    inlineToRuns("[**bold** and *italic*](https://example.com)"),
    [
      { text: "bold", b: true, href: "https://example.com" },
      { text: " and ", href: "https://example.com" },
      { text: "italic", i: true, href: "https://example.com" },
    ],
    "link around marked text",
  );
});

test("markdown parser: unknown or unmatched markers stay literal", async () => {
  assertDeepEqual(inlineToRuns("*unclosed"), [{ text: "*unclosed" }], "unclosed italic");
  assertDeepEqual(inlineToRuns("**unclosed"), [{ text: "**unclosed" }], "unclosed bold");
  assertDeepEqual(inlineToRuns("~~unclosed"), [{ text: "~~unclosed" }], "unclosed strike");
  assertDeepEqual(inlineToRuns("`unclosed"), [{ text: "`unclosed" }], "unclosed code");
  assertDeepEqual(inlineToRuns("[not a link]"), [{ text: "[not a link]" }], "brackets without a url");
  assertDeepEqual(inlineToRuns("[x](ftp://example.com)"), [{ text: "[x](ftp://example.com)" }], "unsupported scheme");
  assertDeepEqual(inlineToRuns("[x](javascript:alert(1))"), [{ text: "[x](javascript:alert(1))" }], "script link");
  assertDeepEqual(inlineToRuns("![alt](https://example.com/x.png)"), [{ text: "![alt](https://example.com/x.png)" }], "image syntax");
  assertDeepEqual(inlineToRuns("****x****"), [{ text: "****x****" }], "overlong marker run");
  assertDeepEqual(inlineToRuns("<3 and 1 > 0"), [{ text: "<3 and 1 > 0" }], "stray angle brackets");
});

/* --------------------------------------------------------------------------
   Parser: HTML escape hatch and attacks
   -------------------------------------------------------------------------- */

test("markdown parser: accepted HTML lines use the normal block parser", async () => {
  const paragraph = lineToBlocks('<p data-align="center"><b>x</b></p>')[0];
  assertEqual(paragraph.type, "p", "paragraph type");
  assertEqual(paragraph.align, "center", "alignment");
  assertDeepEqual(paragraph.runs, [{ text: "x", b: true }], "inline marks");

  const heading = lineToBlocks('<h2 data-indent="2">T</h2>')[0];
  assertEqual(heading.type, "h2", "heading type");
  assertEqual(heading.indent, 2, "legacy indent");

  const quote = lineToBlocks('<blockquote><p data-align="right">q<br>r</p></blockquote>')[0];
  assertEqual(quote.type, "quote", "quote type");
  assertEqual(quote.align, "right", "quote alignment read from the inner paragraph");
  assertEqual(blockText(quote), "q\nr", "quote hard break");

  const item = lineToBlocks('<ul data-depth="2" data-ordered="0"><li data-align="center">x</li></ul>')[0];
  assertEqual(item.type, "list", "list type");
  assertEqual(item.depth, 2, "explicit list depth");
  assertEqual(item.ordered, false, "ordered flag");
  assertEqual(item.align, "center", "item alignment");

  const ordered = lineToBlocks('<ol data-depth="1" data-ordered="1"><li></li></ol>')[0];
  assertEqual(ordered.ordered, true, "ordered list item");
  assertEqual(ordered.depth, 1, "ordered depth");
  assertEqual(blockLength(ordered), 0, "empty list item");

  const empty = lineToBlocks("<p></p>")[0];
  assertEqual(empty.type, "p", "empty paragraph type");
  assertEqual(blockLength(empty), 0, "empty paragraph is empty");
});

test("markdown parser: malicious or malformed HTML lines stay literal text", async () => {
  const attacks = [
    '<img src="http://example.com/x.png">',
    '<img src="data:image/png;base64,AAAA">',
    "<script>alert(1)</script>",
    '<p onclick="steal()">x</p>',
    '<p style="color:red">x</p>',
    '<p><img src="data:image/png;base64,AAAA"></p>',
    '<p><a href="javascript:alert(1)">x</a></p>',
    '<p data-align="evil">x</p>',
    '<p data-indent="0">x</p>',
    '<h4 data-align="center">x</h4>',
    '<div data-align="center">x</div>',
    "<span>x</span>",
    '<ul data-depth="9" data-ordered="0"><li>x</li></ul>',
    '<ul data-depth="1" data-ordered="1"><li>x</li></ul>',
    '<blockquote><div>x</div></blockquote>',
    "<p>unterminated",
  ];
  for (const line of attacks) {
    const blocks = lineToBlocks(line);
    assertEqual(blocks.length, 1, "one literal block for " + line);
    assertEqual(blocks[0].type, "p", "literal block is a paragraph for " + line);
    assertEqual(blockText(blocks[0]), line, "attack stays literal text: " + line);
    assertEqual(serializeDocument(blocks).includes("<img"), false, "no image block from " + line);
  }

  // The same lines never turn into images through a whole conversion either.
  const converted = sourceToRich(sourceBlocks(attacks)).blocks;
  for (const block of converted) {
    assertEqual(block.type, "p", "converted attack is a paragraph");
  }
});

/* --------------------------------------------------------------------------
   Caret maps
   -------------------------------------------------------------------------- */

test("caret maps: paragraphs round-trip and clamp", async () => {
  const blocks = parseDocument("<p>one</p><p>two</p>");
  const conversion = richToSource(blocks);
  assertEqual(conversion.richLines.length, 2, "rich line entries");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 0, offset: 2 }), { block: 0, offset: 2 }, "rich to source");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 0 }), { block: 1, offset: 0 }, "second block");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 0, offset: 99 }), { block: 0, offset: 3 }, "rich offset clamps");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: -4, offset: -2 }), { block: 0, offset: 0 }, "negative clamps");

  const back = sourceToRich(conversion.blocks);
  for (let block = 0; block < blocks.length; block += 1) {
    for (let offset = 0; offset <= blockLength(blocks[block]); offset += 1) {
      const sourceCaret = mapRichCaretToSource(conversion, { block, offset });
      assertDeepEqual(mapSourceCaretToRich(back, sourceCaret), { block, offset }, "caret round-trips");
    }
  }

  assertDeepEqual(mapSourceCaretToRich(back, { block: 1, offset: 0 }), { block: 1, offset: 0 }, "source to rich");
  assertDeepEqual(mapSourceCaretToRich(back, { block: 0, offset: 99 }), { block: 0, offset: 3 }, "source offset clamps");
  assertDeepEqual(mapSourceCaretToRich(back, { block: 99, offset: 0 }), { block: 1, offset: 0 }, "source block clamps");
});

test("caret maps: fenced code lines map to the right content offset", async () => {
  const blocks = parseDocument("<p>x</p><pre>ab\ncd</pre><p>y</p>");
  const conversion = richToSource(blocks);
  assertEqual(conversion.richLines[1].code, true, "code rich line entry");
  // Source blocks: 0 "x", 1 fence, 2 "ab", 3 "cd", 4 fence, 5 "y".
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 0 }), { block: 2, offset: 0 }, "code start");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 2 }), { block: 2, offset: 2 }, "end of first code line");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 3 }), { block: 3, offset: 0 }, "start of second code line");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 5 }), { block: 3, offset: 2 }, "code end");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 99 }), { block: 3, offset: 2 }, "code offset clamps");

  const back = sourceToRich(conversion.blocks);
  assertDeepEqual(mapSourceCaretToRich(back, { block: 1, offset: 99 }), { block: 1, offset: 0 }, "fence open clamps to code start");
  assertDeepEqual(mapSourceCaretToRich(back, { block: 2, offset: 1 }), { block: 1, offset: 1 }, "first code line");
  assertDeepEqual(mapSourceCaretToRich(back, { block: 3, offset: 0 }), { block: 1, offset: 3 }, "second code line");
  assertDeepEqual(mapSourceCaretToRich(back, { block: 4, offset: 99 }), { block: 1, offset: 5 }, "fence close maps to code end");
});

test("caret maps: images and blank lines map to their blocks", async () => {
  const html = '<p>a</p><img alt="x" width="1" height="1" src="data:image/png;base64,AAAA"><p>b</p>';
  const blocks = parseDocument(html);
  const conversion = richToSource(blocks);
  assertEqual(conversion.richLines[1], null, "image rich line entry");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 1, offset: 0 }), { block: 1, offset: 0 }, "rich image maps to its source image");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 0, offset: 1 }), { block: 0, offset: 1 }, "text before the image");

  const back = sourceToRich(conversion.blocks);
  assertDeepEqual(mapSourceCaretToRich(back, { block: 1, offset: 0 }), { block: 1, offset: 0 }, "source image maps to its rich image");
  assertEqual(back.imageTargets[1], 1, "image targets name the rich image block");

  const withBlank = sourceToRich(sourceBlocks(["", "hello"])).lineMap;
  assertEqual(withBlank[0].richIndex, 0, "blank line maps to the empty paragraph it becomes");
  assertDeepEqual(
    mapSourceCaretToRich({ lineMap: withBlank }, { block: 0, offset: 0 }),
    { block: 0, offset: 0 },
    "caret on a blank line stays on its empty paragraph",
  );

  const allImages = richToSource(parseDocument('<img alt="x" width="1" height="1" src="data:image/png;base64,AAAA">'));
  assertDeepEqual(mapRichCaretToSource(allImages, { block: 0, offset: 0 }), { block: 0, offset: 0 }, "single image document");
  assertDeepEqual(
    mapSourceCaretToRich(sourceToRich(allImages.blocks), { block: 0, offset: 0 }),
    { block: 0, offset: 0 },
    "single image document, source to rich",
  );
});

test("caret maps: never return out-of-range positions", async () => {
  const blocks = parseDocument("<h2>title</h2><p>text<br>break</p><pre>a\nb</pre><ul><li>i</li></ul>");
  const conversion = richToSource(blocks);
  const back = sourceToRich(conversion.blocks);
  for (const block of [-2, -1, 0, 1, 2, 3, 4, 5, 99]) {
    for (const offset of [-3, -1, 0, 1, 2, 7, 99]) {
      const richCaret = mapSourceCaretToRich(back, { block, offset });
      assert(
        Number.isInteger(richCaret.block) && richCaret.block >= 0 && richCaret.block < back.blocks.length,
        "rich block in range: " + JSON.stringify({ block, offset, richCaret }),
      );
      assert(
        richCaret.offset >= 0 && richCaret.offset <= blockLength(back.blocks[richCaret.block]),
        "rich offset in range: " + JSON.stringify({ block, offset, richCaret }),
      );

      const sourceCaret = mapRichCaretToSource(conversion, { block, offset });
      assert(
        Number.isInteger(sourceCaret.block) &&
          sourceCaret.block >= 0 &&
          sourceCaret.block < conversion.blocks.length,
        "source block in range: " + JSON.stringify({ block, offset, sourceCaret }),
      );
      const sourceText = blockText(conversion.blocks[sourceCaret.block]);
      assert(
        sourceCaret.offset >= 0 && sourceCaret.offset <= sourceText.length,
        "source offset in range: " + JSON.stringify({ block, offset, sourceCaret, sourceText }),
      );
    }
  }
});

test("caret maps: HTML-carried lines map to the line start", async () => {
  const blocks = parseDocument('<p data-align="center">hello</p>');
  const conversion = richToSource(blocks);
  assertEqual(conversion.richLines[0].html, true, "rich line is carried as HTML");
  assertDeepEqual(mapRichCaretToSource(conversion, { block: 0, offset: 3 }), { block: 0, offset: 0 }, "rich to HTML line start");
  const back = sourceToRich(conversion.blocks);
  assertEqual(back.lineMap[0].html, true, "source line is carried as HTML");
  assertDeepEqual(mapSourceCaretToRich(back, { block: 0, offset: 4 }), { block: 0, offset: 4 }, "source offset clamps to the rich text length");
});

/* --------------------------------------------------------------------------
   Line helpers
   -------------------------------------------------------------------------- */

test("line helpers: readLine classifies every form", async () => {
  assertDeepEqual(readLine(""), { kind: "blank" }, "empty line");
  assertDeepEqual(readLine("   "), { kind: "blank" }, "spaces line");
  assertDeepEqual(readLine("# h"), { kind: "h1", body: "h" }, "h1");
  assertDeepEqual(readLine("### h"), { kind: "h3", body: "h" }, "h3");
  assertDeepEqual(readLine("#### h"), { kind: "p", body: "#### h" }, "four hashes are text");
  assertDeepEqual(readLine("> q"), { kind: "quote", body: "q" }, "quote");
  assertDeepEqual(readLine(">q"), { kind: "quote", body: "q" }, "quote without a space");
  assertDeepEqual(readLine("- item"), { kind: "list", ordered: false, indent: 0, depth: 0, body: "item" }, "dash item");
  assertDeepEqual(readLine("* item"), { kind: "list", ordered: false, indent: 0, depth: 0, body: "item" }, "star item");
  assertDeepEqual(readLine("  - item"), { kind: "list", ordered: false, indent: 2, depth: 1, body: "item" }, "nested item");
  assertDeepEqual(readLine("\t1. item"), { kind: "list", ordered: true, indent: 4, depth: 2, body: "item", number: 1 }, "tab indent");
  assertDeepEqual(readLine("12. item"), { kind: "list", ordered: true, indent: 0, depth: 0, body: "item", number: 12 }, "multi digit marker");
  assertDeepEqual(readLine("- "), { kind: "list", ordered: false, indent: 0, depth: 0, body: "" }, "empty item");
  assertDeepEqual(readLine("```"), { kind: "fence" }, "fence");
  assertDeepEqual(readLine("  ````  "), { kind: "fence" }, "indented longer fence");
  assertDeepEqual(readLine("<p></p>"), { kind: "html", text: "<p></p>" }, "HTML escape line");
  assertDeepEqual(readLine("<div>x</div>"), { kind: "p", body: "<div>x</div>" }, "rejected HTML is a paragraph");
  assertDeepEqual(readLine("plain text"), { kind: "p", body: "plain text" }, "paragraph");
});

test("line helpers: writeLine is the inverse for canonical lines", async () => {
  const canonical = ["# h", "### h", "> q", "> ", "- item", "  - item", "1. item", "  3. item", "plain", "<p></p>", "```"];
  for (const line of canonical) {
    assertEqual(writeLine(readLine(line)), line, "writeLine(readLine(" + JSON.stringify(line) + "))");
  }
  assertEqual(writeLine({ kind: "blank" }), "", "blank line");
  assertEqual(writeLine({ kind: "h2", body: "x" }), "## x", "heading body replaces");
  assertEqual(writeLine({ kind: "p", body: "x" }), "x", "paragraph body replaces");
});

test("line helpers: sourceLineInfo tracks fences", async () => {
  const blocks = sourceBlocks(["- a", "```", "code", "", "```", "after"]);
  blocks.push({ type: "image", src: "data:image/png;base64,AAAA" });
  const info = sourceLineInfo(blocks);
  assertDeepEqual(
    info.map((entry) => entry.kind),
    ["list", "fenceOpen", "codeContent", "codeContent", "fenceClose", "p", "image"],
    "fence-aware kinds",
  );
  assertEqual(info[0].ordered, false, "list info carries ordered");
  assertEqual(info[1].fenceLength, 3, "open fence length");
  assertEqual(info[4].fenceLength, 3, "close fence length");
  assertEqual(info[5].body, "after", "paragraph body");
  assertEqual(sourceLineInfo(sourceBlocks(["```"]))[0].kind, "fenceOpen", "unclosed fence still opens");
});

test("line helpers: blockToLines and lineToBlocks agree", async () => {
  assertDeepEqual(blockToLines({ type: "image", src: "data:image/png;base64,AAAA" }), [], "image has no text lines");
  assertDeepEqual(lineToBlocks(""), [], "blank line produces nothing");
  assertDeepEqual(lineToBlocks("   "), [], "whitespace line produces nothing");
  assertDeepEqual(lineToBlocks("```"), [], "fence line produces nothing");
  assertEqual(lineToBlocks("# heading")[0].type, "h1", "heading line");
  assertEqual(lineToBlocks('  <p data-align="center">x</p>')[0].type, "p", "indented HTML is not accepted");
  assertEqual(lineToBlocks('<p data-align="center">x</p>')[0].align, "center", "HTML line alignment");
});

test("line helpers: runsToInline and inlineToRuns are inverse", async () => {
  const runs = [
    { text: "plain " },
    { text: "bold", b: true },
    { text: " " },
    { text: "both", b: true, i: true },
    { text: " " },
    { text: "all", b: true, i: true, u: true, s: true, code: true },
    { text: " " },
    { text: "link", href: "https://example.com/x?q=1&r=2" },
    { text: " and\nbreak" },
  ];
  assertDeepEqual(inlineToRuns(runsToInline(runs)), runs, "round trip");
  assertEqual(runsToInline([{ text: "a\nb", code: true }]), "<code>a<br>b</code>", "code across a break falls back to safe HTML");
});

test("line helpers: stripInline keeps the visible text", async () => {
  assertEqual(stripInline("**bold** and _italic_"), "bold and italic", "marks stripped");
  assertEqual(stripInline("[label](https://example.com)"), "label", "link keeps its label");
  assertEqual(stripInline("`code`"), "code", "inline code");
  assertEqual(stripInline("<u>under</u>"), "under", "underline markup removed");
  assertEqual(stripInline("one<br>two"), "one\ntwo", "hard break stays a line feed");
  assertEqual(stripInline("\\*not italic\\*"), "*not italic*", "escapes are unescaped");
  assertEqual(stripInline("<b>raw</b>"), "raw", "other inline HTML tags are removed");
  assertEqual(stripInline("\\<b>escaped\\</b>"), "<b>escaped</b>", "escaped tags stay visible");
  assertEqual(stripInline("`<b>`"), "<b>", "tags inside inline code stay visible");
});

/* --------------------------------------------------------------------------
   Totality
   -------------------------------------------------------------------------- */

function mulberry32(seed) {
  let state = seed;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("fuzz: arbitrary user text never throws", async () => {
  const random = mulberry32(0x5eed);
  const alphabet = "\\`*_~[]()<>#!+-., 123abc\n&;:\"'/=\u00e9";
  for (let iteration = 0; iteration < 250; iteration += 1) {
    let text = "";
    const length = Math.floor(random() * 60);
    for (let index = 0; index < length; index += 1) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    const runs = inlineToRuns(text);
    const emitted = runsToInline(runs);
    assert(typeof emitted === "string", "runsToInline returns a string");
    assert(typeof stripInline(text) === "string", "stripInline returns a string");
    const line = readLine(text);
    assert(typeof line.kind === "string", "readLine returns a kind");
    assert(typeof writeLine(line) === "string", "writeLine returns a string");
    const blocks = lineToBlocks(text);
    assert(Array.isArray(blocks), "lineToBlocks returns blocks");
    const source = sourceToRich([sourceBlock(text)]);
    assert(source.blocks.length >= 1, "sourceToRich always returns a block");
    const again = sourceToRich(richToSource(source.blocks).blocks);
    assert(again.blocks.length >= 1, "richToSource round trip returns a block");
  }
});

test("fuzz: arbitrary rich runs round-trip through source", async () => {
  const random = mulberry32(0xc0ffee);
  const alphabet = "abc \\`*_~[]<>#!+-.,\n12";
  const hrefs = ["", "https://example.com/x", "mailto:a@b.c", "https://example.com/a_(b)?c=1&d=2"];
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const runCount = 1 + Math.floor(random() * 4);
    const runs = [];
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      let text = "";
      const length = 1 + Math.floor(random() * 8);
      for (let index = 0; index < length; index += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      const run = { text };
      if (random() < 0.4) run.b = true;
      if (random() < 0.4) run.i = true;
      if (random() < 0.3) run.u = true;
      if (random() < 0.3) run.s = true;
      if (random() < 0.3) run.code = true;
      const href = hrefs[Math.floor(random() * hrefs.length)];
      if (href) run.href = href;
      runs.push(run);
    }
    const block = createBlock("p", runs);
    assertLosslessBlocks([block], "fuzz iteration " + iteration);
  }
});
