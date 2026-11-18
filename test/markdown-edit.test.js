// Tests for the Markdown mode toolbar commands (assets/doc/markdown-edit.js).
//
// editor.test.js owns the harness runner: it collects window.__extraTests,
// runs them after its own tests, and reports failures the same way. This file
// only registers tests, so it does not need its own runner or DOM setup.

import {
  clearFormatting,
  inspect,
  linkAt,
  removeLink,
  setAlign,
  setBlockStyle,
  setLink,
  setMark,
  toggleList,
} from "/assets/doc/markdown-edit.js";
import { blockToLines, readLine, sourceToRich } from "/assets/doc/markdown.js";
import { blockText } from "/assets/doc/model.js";

window.__extraTests = window.__extraTests || [];
const tests = window.__extraTests;

const IMAGE = {
  id: "img1",
  type: "image",
  mode: "block",
  src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  alt: "Dot",
  width: 80,
  height: 60,
};

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

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message}: expected ${b}, got ${a}`);
  }
}

// A document of source lines: the shape Markdown mode holds in the editor.
function sourceBlocks(...lines) {
  return lines.map((line, index) => ({
    id: "s" + index,
    type: "p",
    source: true,
    runs: [{ text: line }],
  }));
}

function imageBlock() {
  return { ...IMAGE };
}

function collapsed(block, offset) {
  return { anchor: { block, offset }, focus: { block, offset }, collapsed: true };
}

function selection(anchorBlock, anchorOffset, focusBlock, focusOffset) {
  return {
    anchor: { block: anchorBlock, offset: anchorOffset },
    focus: { block: focusBlock, offset: focusOffset },
    collapsed: anchorBlock === focusBlock && anchorOffset === focusOffset,
  };
}

function texts(result) {
  return result.blocks.map((block) => (block.type === "image" ? "<image>" : blockText(block)));
}

function richOf(result) {
  return sourceToRich(result.blocks).blocks;
}

// The rich model reduced to the facts these tests compare.
function describeRich(blocks) {
  return blocks.map((block) => {
    if (block.type === "image") {
      return { type: "image" };
    }
    const shape = { type: block.type, text: blockText(block) };
    if (block.type === "list") {
      shape.ordered = Boolean(block.ordered);
    }
    if (block.align) {
      shape.align = block.align;
    }
    return shape;
  });
}

function richShape(result) {
  return describeRich(richOf(result));
}

function expectSingleLine(result, expected, message) {
  assert(result, `${message}: returned null`);
  assertEqual(result.blocks.length, 1, `${message}: one block`);
  assertEqual(blockText(result.blocks[0]), expected, message);
}

/* --------------------------------------------------------------------------
   inspect: the toolbar state
   -------------------------------------------------------------------------- */

test("markdown-edit inspect: plain paragraph reports normal text and no marks", () => {
  const blocks = sourceBlocks("hello world");
  const state = inspect(blocks, collapsed(0, 3));
  assertDeepEqual(
    state.marks,
    { b: false, i: false, u: false, s: false, code: false, href: "" },
    "no marks in plain text",
  );
  assertEqual(state.style, "p", "paragraph style");
  assertEqual(state.align, "left", "no alignment");
  assertEqual(state.ordered, null, "not a list");
  assertEqual(state.href, "", "no link");
});

test("markdown-edit inspect: headings, quotes, and lists report the rich toolbar labels", () => {
  assertEqual(inspect(sourceBlocks("# Heading"), collapsed(0, 4)).style, "h1", "h1");
  assertEqual(inspect(sourceBlocks("## Heading"), collapsed(0, 4)).style, "h2", "h2");
  assertEqual(inspect(sourceBlocks("### Heading"), collapsed(0, 4)).style, "h3", "h3");
  assertEqual(inspect(sourceBlocks("#### Heading"), collapsed(0, 4)).style, "p", "four hashes are a paragraph");
  assertEqual(inspect(sourceBlocks("> quoted"), collapsed(0, 3)).style, "quote", "quote");

  const unordered = inspect(sourceBlocks("- item"), collapsed(0, 3));
  assertEqual(unordered.style, "p", "a list line reports normal text like the rich editor");
  assertEqual(unordered.ordered, false, "unordered list");
  const ordered = inspect(sourceBlocks("1. item"), collapsed(0, 4));
  assertEqual(ordered.ordered, true, "ordered list");
  assertEqual(inspect(sourceBlocks("plain"), collapsed(0, 2)).ordered, null, "non-list has no list kind");
});

test("markdown-edit inspect: fence context reports code", () => {
  const blocks = sourceBlocks("```", "const x = 1;", "```");
  const open = inspect(blocks, collapsed(0, 1));
  const content = inspect(blocks, collapsed(1, 4));
  const close = inspect(blocks, collapsed(2, 2));
  assertEqual(open.style, "code", "opening fence reports code");
  assertEqual(content.style, "code", "fence content reports code");
  assertEqual(close.style, "code", "closing fence reports code");
  assertEqual(content.align, "left", "code has no paragraph alignment");
  assertEqual(content.ordered, null, "code has no list kind");
});

test("markdown-edit inspect: inline marks at the caret", () => {
  assertEqual(inspect(sourceBlocks("a **bold** c"), collapsed(0, 5)).marks.b, true, "bold");
  assertEqual(inspect(sourceBlocks("a **bold** c"), collapsed(0, 1)).marks.b, false, "outside bold");
  assertEqual(inspect(sourceBlocks("*italic*"), collapsed(0, 2)).marks.i, true, "italic");
  assertEqual(inspect(sourceBlocks("<u>under</u>"), collapsed(0, 4)).marks.u, true, "underline");
  assertEqual(inspect(sourceBlocks("~~struck~~"), collapsed(0, 4)).marks.s, true, "strikethrough");
  assertEqual(inspect(sourceBlocks("`code`"), collapsed(0, 2)).marks.code, true, "inline code");
  assertEqual(inspect(sourceBlocks("a `code`"), collapsed(0, 1)).marks.code, false, "outside code");
});

test("markdown-edit inspect: links, alignment, and multi-line selections", () => {
  const blocks = sourceBlocks("a [label](https://example.com) b");
  const atLink = inspect(blocks, collapsed(0, "a [lab".length));
  assertEqual(atLink.marks.href, "https://example.com", "caret inside a link reports its href");
  assertEqual(atLink.href, "https://example.com", "href is exposed for the dialog");
  assertEqual(inspect(blocks, collapsed(0, 0)).marks.href, "", "outside the link");

  const centered = blockToLines({ type: "p", runs: [{ text: "centered" }], align: "center" })[0];
  assertEqual(inspect(sourceBlocks(centered), collapsed(0, 0)).align, "center", "alignment parsed from the line");

  const selected = inspect(sourceBlocks("**bold** plain"), selection(0, 2, 0, 7));
  assertEqual(selected.marks.b, true, "a selection reports the marks at its start");
  assertEqual(selected.style, "p", "style comes from the focus line");
});

test("markdown-edit inspect: images and blank lines fall back to normal text", () => {
  const blocks = [imageBlock()];
  const state = inspect(blocks, collapsed(0, 0));
  assertEqual(state.style, "p", "an image has no paragraph style");
  assertEqual(state.align, "left", "an image has no alignment");
  assertEqual(state.ordered, null, "an image has no list kind");
  const blank = inspect(sourceBlocks("", "text"), collapsed(0, 0));
  assertEqual(blank.style, "p", "a blank line is a normal paragraph");
});

/* --------------------------------------------------------------------------
   setMark: wrap, unwrap, and caret pairs
   -------------------------------------------------------------------------- */

test("markdown-edit setMark: wraps the selected text and keeps the selection", () => {
  const blocks = sourceBlocks("hello world");
  const result = setMark(blocks, selection(0, 6, 0, 11), "b");
  assert(result, "bold changed the line");
  assertEqual(blockText(result.blocks[0]), "hello **world**", "bold markers wrap the selection");
  assert(result.blocks[0].id !== blocks[0].id, "a changed block gets a new id");
  assertEqual(result.anchor.offset, 6, "anchor stays before the opening marker");
  assertEqual(result.focus.offset, "hello **world**".length, "focus follows the wrapped text");
  assertEqual(blockText(blocks[0]), "hello world", "the input is not mutated");
});

test("markdown-edit setMark: a word exactly inside a pair is unwrapped", () => {
  const blocks = sourceBlocks("hello **world**");
  const start = "hello **".length;
  const result = setMark(blocks, selection(0, start, 0, start + "world".length), "b");
  expectSingleLine(result, "hello world", "bold markers around the word are removed");
  assertEqual(result.anchor.offset, "hello ".length, "anchor maps to the label start");
  assertEqual(result.focus.offset, "hello world".length, "focus maps to the label end");
});

test("markdown-edit setMark: a selection including the markers is unwrapped too", () => {
  const blocks = sourceBlocks("**word**");
  const result = setMark(blocks, selection(0, 0, 0, 8), "b");
  expectSingleLine(result, "word", "the whole pair is removed");
});

test("markdown-edit setMark: a collapsed caret without a pair arms pending markers", () => {
  const bold = setMark(sourceBlocks(""), collapsed(0, 0), "b");
  assertEqual(bold.pending, "b", "bold pending instead of an empty pair");

  const under = setMark(sourceBlocks(""), collapsed(0, 0), "u");
  assertEqual(under.pending, "u", "underline pending");

  const code = setMark(sourceBlocks("x"), collapsed(0, 1), "code");
  assertEqual(code.pending, "code", "inline code pending");

  assertEqual(
    setMark(sourceBlocks("plain"), collapsed(0, 2), "b").pending,
    "b",
    "pending is claimed at a plain caret",
  );
  assertEqual(setMark(sourceBlocks("`code`"), collapsed(0, 2), "b"), null, "not inside a code span");
  assertEqual(setMark(sourceBlocks("**bold**"), collapsed(0, 4), "i"), null, "not inside another mark");
});

test("markdown-edit setMark: toggling a collapsed caret off removes the pair", () => {
  const blocks = sourceBlocks("hello **world** more");
  const result = setMark(blocks, collapsed(0, "hello **wo".length), "b");
  expectSingleLine(result, "hello world more", "the enclosing pair is removed");
  assertEqual(result.focus.offset, "hello wo".length, "caret keeps its visible place");

  const empty = sourceBlocks("****");
  const removed = setMark(empty, collapsed(0, 2), "b");
  expectSingleLine(removed, "", "an empty pair is removed");
  assertEqual(removed.focus.offset, 0, "caret collapses back to the start");
});

test("markdown-edit setMark: every supported mark uses its canonical marker", () => {
  const word = () => selection(0, 0, 0, 1);
  expectSingleLine(setMark(sourceBlocks("x"), word(), "i"), "*x*", "italic");
  expectSingleLine(setMark(sourceBlocks("x"), word(), "u"), "<u>x</u>", "underline");
  expectSingleLine(setMark(sourceBlocks("x"), word(), "s"), "~~x~~", "strikethrough");
  expectSingleLine(setMark(sourceBlocks("x"), word(), "code"), "`x`", "inline code");
  assertEqual(setMark(sourceBlocks("x"), word(), "q"), null, "unknown mark key");
});

test("markdown-edit setMark: a multi-line selection is wrapped per line", () => {
  const blocks = sourceBlocks("one", "two");
  const result = setMark(blocks, selection(0, 1, 1, 2), "b");
  assertEqual(texts(result)[0], "o**ne**", "first line wraps its touched part");
  assertEqual(texts(result)[1], "**tw**o", "second line wraps its touched part");
  assertEqual(result.anchor.block, 0, "anchor block");
  assertEqual(result.anchor.offset, 1, "anchor stays at the wrapped text");
  assertEqual(result.focus.block, 1, "focus block");
  assertEqual(result.focus.offset, 6, "focus follows the wrapped text, after the closing markers");
});

test("markdown-edit setMark: images and fenced code are skipped", () => {
  const image = imageBlock();
  const blocks = [sourceBlocks("a")[0], image, sourceBlocks("b")[0]];
  const result = setMark(blocks, selection(0, 0, 2, 1), "b");
  assert(result, "the text around the image changed");
  assertEqual(blockText(result.blocks[0]), "**a**", "text before the image");
  assertEqual(result.blocks[1], image, "the image keeps its identity");
  assertEqual(blockText(result.blocks[2]), "**b**", "text after the image");

  const fenced = sourceBlocks("```", "const x = 1;", "```");
  assertEqual(setMark(fenced, collapsed(1, 3), "b"), null, "markers are not inserted into code");
});

test("markdown-edit setMark: a collapsed caret inside a code span toggles it off", () => {
  const blocks = sourceBlocks("a `code` b");
  const result = setMark(blocks, collapsed(0, "a `co".length), "code");
  expectSingleLine(result, "a code b", "the inline code pair is removed");
});

/* --------------------------------------------------------------------------
   Links
   -------------------------------------------------------------------------- */

test("markdown-edit links: setLink wraps the selection and linkAt reports it", () => {
  const blocks = sourceBlocks("click here");
  const result = setLink(blocks, selection(0, 6, 0, 10), "https://example.com");
  expectSingleLine(result, "click [here](https://example.com)", "link wrapper added");
  assert(result.blocks[0].id !== blocks[0].id, "changed block gets a new id");

  const context = linkAt(result.blocks, collapsed(0, 8));
  assert(context, "link found at the caret");
  assertEqual(context.href, "https://example.com", "href reported");
  assertEqual(context.from, 6, "link starts at the opening bracket");
  assertEqual(context.to, "click [here](https://example.com)".length, "link ends after the closing paren");
  assertEqual(inspect(result.blocks, collapsed(0, 8)).marks.href, "https://example.com", "toolbar link state");
});

test("markdown-edit links: setLink replaces the url of an existing link", () => {
  const blocks = sourceBlocks("a [label](https://old.example) b");
  const result = setLink(blocks, collapsed(0, "a [lab".length), "https://new.example/x");
  expectSingleLine(result, "a [label](https://new.example/x) b", "url replaced, label kept");
  assertEqual(linkAt(result.blocks, collapsed(0, 4)).href, "https://new.example/x", "new href");
});

test("markdown-edit links: removeLink keeps the label and drops the wrapper", () => {
  const blocks = sourceBlocks("a [label](https://example.com) b");
  const result = removeLink(blocks, collapsed(0, "a [lab".length));
  expectSingleLine(result, "a label b", "wrapper removed");
  assertEqual(linkAt(result.blocks, collapsed(0, 4)), null, "no link remains");

  const bySelection = removeLink(blocks, selection(0, 2, 0, "a [label](https://example.com)".length));
  expectSingleLine(bySelection, "a label b", "a selection covering the link removes it");
  assertEqual(removeLink(sourceBlocks("plain"), collapsed(0, 2)), null, "nothing to remove");
  assertEqual(linkAt(sourceBlocks("plain"), collapsed(0, 2)), null, "no link outside a link");
});

test("markdown-edit links: web addresses and page paths are accepted", () => {
  const blocks = sourceBlocks("text");
  const span = selection(0, 0, 0, 4);
  assertEqual(setLink(blocks, span, "javascript:alert(1)"), null, "javascript: is refused");
  assertEqual(setLink(blocks, span, "example.com"), null, "a bare relative url is refused");
  assertEqual(setLink(blocks, span, "//example.com/doc"), null, "a protocol-relative url is refused");
  assertEqual(setLink(blocks, span, "/doc/two words"), null, "a path with a space is refused");
  assertEqual(setLink(blocks, span, "ftp://example.com"), null, "ftp: is refused");
  assertEqual(setLink(blocks, span, ""), null, "an empty url is refused");
  const secure = setLink(blocks, span, "https://example.com/a?b=1");
  assert(secure, "https is accepted");
  const mail = setLink(blocks, span, "mailto:someone@example.com");
  assert(mail, "mailto is accepted");
  const page = setLink(blocks, span, "/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7");
  expectSingleLine(page, "[text](/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7)", "a Grapho page path is accepted");
  assertEqual(
    linkAt(page.blocks, collapsed(0, 2)).href,
    "/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7",
    "the page path is found as a link",
  );
});

test("markdown-edit links: a selection spanning lines links each line", () => {
  const blocks = sourceBlocks("one", "two");
  const result = setLink(blocks, selection(0, 0, 1, 3), "https://example.com");
  assertEqual(texts(result)[0], "[one](https://example.com)", "first line linked");
  assertEqual(texts(result)[1], "[two](https://example.com)", "second line linked");
});

/* --------------------------------------------------------------------------
   setBlockStyle
   -------------------------------------------------------------------------- */

test("markdown-edit setBlockStyle: paragraph and heading markers are rewritten", () => {
  const addHeading = setBlockStyle(sourceBlocks("hello"), collapsed(0, 2), "h1");
  expectSingleLine(addHeading, "# hello", "p to h1");

  const back = setBlockStyle(sourceBlocks("# hello"), collapsed(0, 2), "p");
  expectSingleLine(back, "hello", "h1 to p");

  const h2 = setBlockStyle(sourceBlocks("## hello"), collapsed(0, 3), "h2");
  assertEqual(h2, null, "an unchanged style is a no-op");

  const quote = setBlockStyle(sourceBlocks("# title"), collapsed(0, 2), "quote");
  assertEqual(texts(quote)[0], "> title", "h1 to quote");
  assertEqual(richShape(quote)[0].type, "quote", "rich model is a quote");
});

test("markdown-edit setBlockStyle: a list line becomes a paragraph and keeps its text", () => {
  expectSingleLine(setBlockStyle(sourceBlocks("- item"), collapsed(0, 2), "p"), "item", "unordered list");
  expectSingleLine(setBlockStyle(sourceBlocks("1. item"), collapsed(0, 2), "p"), "item", "ordered list");
});

test("markdown-edit setBlockStyle: alignment survives a style change through the HTML escape", () => {
  const line = blockToLines({ type: "p", runs: [{ text: "hi" }], align: "center" })[0];
  const result = setBlockStyle(sourceBlocks(line), collapsed(0, 0), "h1");
  assert(result, "style changed");
  assertEqual(readLine(blockText(result.blocks[0])).kind, "html", "still carried as serialized HTML");
  assertDeepEqual(
    richShape(result),
    [{ type: "h1", text: "hi", align: "center" }],
    "heading with the alignment preserved",
  );

  const plain = setBlockStyle(sourceBlocks(line), collapsed(0, 0), "p");
  assertEqual(plain, null, "a paragraph that is already p with only alignment changes nothing");
});

test("markdown-edit setBlockStyle code: wraps the selected lines in a fence", () => {
  const blocks = sourceBlocks("const x = 1;");
  const result = setBlockStyle(blocks, collapsed(0, 5), "code");
  assertEqual(texts(result).join("|"), "```|const x = 1;|```", "fenced group");
  assertDeepEqual(
    richShape(result),
    [{ type: "code", text: "const x = 1;" }],
    "one code block in the rich model",
  );
  assertEqual(result.anchor.block, 1, "caret maps into the code content");
  assert(Number.isInteger(result.anchor.offset), "caret offset is present");
});

test("markdown-edit setBlockStyle code: uses the visible text as code content", () => {
  const blocks = sourceBlocks("*hello* there", "plain");
  const result = setBlockStyle(blocks, selection(0, 0, 1, 5), "code");
  assertEqual(texts(result)[0], "```", "opening fence");
  assertEqual(texts(result)[1], "hello there", "inline marks stripped from the code content");
  assertEqual(texts(result)[2], "plain", "second content line");
  assertEqual(texts(result)[3], "```", "closing fence");
  assertDeepEqual(
    richShape(result),
    [{ type: "code", text: "hello there\nplain" }],
    "rich code block",
  );
});

test("markdown-edit setBlockStyle code: a longer fence contains backtick runs", () => {
  const line = blockToLines({ type: "p", runs: [{ text: "a ``` b" }] })[0];
  const result = setBlockStyle(sourceBlocks(line), collapsed(0, 0), "code");
  const resultTexts = texts(result);
  assertEqual(resultTexts[0], "````", "fence grows past the longest backtick run");
  assertEqual(resultTexts[1], "a ``` b", "the backticks are code content");
  assertEqual(resultTexts[2], "````", "closing fence matches");
});

test("markdown-edit setBlockStyle code: a fence inside the selection is toggled off", () => {
  const blocks = sourceBlocks("```", "const x = 1;", "```");
  const result = setBlockStyle(blocks, collapsed(1, 3), "code");
  assertEqual(texts(result).join("|"), "const x = 1;", "the fence lines are removed");
  assertEqual(result.blocks[0], blocks[1], "the code line keeps its identity");
  assertEqual(result.focus.block, 0, "caret stays on the code line");

  const openFence = setBlockStyle(blocks, collapsed(0, 1), "code");
  assertEqual(texts(openFence).join("|"), "const x = 1;", "a caret on the opening fence also unwraps");
});

test("markdown-edit setBlockStyle: blank and fenced lines are skipped for text styles", () => {
  assertEqual(setBlockStyle(sourceBlocks(""), collapsed(0, 0), "h1"), null, "blank line is skipped");
  const fenced = sourceBlocks("```", "code", "```");
  assertEqual(setBlockStyle(fenced, collapsed(1, 2), "h1"), null, "code content is skipped");
  assertEqual(setBlockStyle(sourceBlocks("x"), collapsed(0, 0), "banana"), null, "unknown style");
});

test("markdown-edit setBlockStyle: images are skipped and keep their identity", () => {
  const image = imageBlock();
  const blocks = [sourceBlocks("a")[0], image];
  const result = setBlockStyle(blocks, collapseAll(blocks), "h2");
  assertEqual(blockText(result.blocks[0]), "## a", "text line restyled");
  assertEqual(result.blocks[1], image, "image untouched");
});

function collapseAll(blocks) {
  return selection(0, 0, blocks.length - 1, 0);
}

/* --------------------------------------------------------------------------
   toggleList
   -------------------------------------------------------------------------- */

test("markdown-edit toggleList: toggles bullet markers on and off", () => {
  const first = toggleList(sourceBlocks("alpha", "beta"), selection(0, 0, 1, 4), false);
  assertEqual(texts(first).join("|"), "- alpha|- beta", "list markers added");

  const off = toggleList(first.blocks, selection(0, 0, 1, 6), false);
  assertEqual(texts(off).join("|"), "alpha|beta", "the same kind toggles off");

  const ordered = toggleList(sourceBlocks("alpha"), collapsed(0, 2), true);
  assertEqual(texts(ordered)[0], "1. alpha", "ordered marker uses a repeated 1.");
});

test("markdown-edit toggleList: switches the marker kind and preserves indentation", () => {
  const switched = toggleList(sourceBlocks("- alpha"), collapsed(0, 2), true);
  assertEqual(texts(switched)[0], "1. alpha", "unordered to ordered");

  const indented = toggleList(sourceBlocks("  - alpha"), collapsed(0, 4), true);
  assertEqual(texts(indented)[0], "  1. alpha", "leading spaces are preserved");

  const mixed = toggleList(sourceBlocks("- alpha", "plain"), selection(0, 2, 1, 2), true);
  assertEqual(texts(mixed).join("|"), "1. alpha|1. plain", "mixed lines all become the requested kind");
});

test("markdown-edit toggleList: headings become list items and blank lines are skipped", () => {
  const heading = toggleList(sourceBlocks("# title"), collapsed(0, 2), false);
  assertEqual(texts(heading)[0], "- title", "heading marker replaced by a list marker");

  const withBlank = toggleList(sourceBlocks("alpha", ""), selection(0, 0, 1, 0), false);
  assertEqual(texts(withBlank).join("|"), "- alpha|", "the blank line is left alone");

  assertEqual(toggleList([imageBlock()], collapsed(0, 0), false), null, "an image alone changes nothing");
});

test("markdown-edit toggleList: the caret follows the inserted marker", () => {
  const result = toggleList(sourceBlocks("hello"), collapsed(0, 2), false);
  assertEqual(result.focus.offset, 4, "caret moves past the marker it inserted");
  assertEqual(result.anchor.block, 0, "same block");
});

test("markdown-edit toggleList: an aligned paragraph becomes an aligned list item", () => {
  const centered = blockToLines({ type: "p", runs: [{ text: "hi" }], align: "center" })[0];
  const toList = toggleList(sourceBlocks(centered), collapsed(0, 0), false);
  assertDeepEqual(
    richShape(toList),
    [{ type: "list", text: "hi", ordered: false, align: "center" }],
    "the list item keeps the alignment",
  );
  const back = toggleList(toList.blocks, collapsed(0, 0), false);
  assertDeepEqual(richShape(back), [{ type: "p", text: "hi", align: "center" }], "toggling off keeps the alignment");
});

/* --------------------------------------------------------------------------
   setAlign
   -------------------------------------------------------------------------- */

test("markdown-edit setAlign: aligned lines use the documented HTML escape", () => {
  const result = setAlign(sourceBlocks("hello"), collapsed(0, 2), "center");
  assert(result, "alignment changed");
  const line = blockText(result.blocks[0]);
  assertEqual(readLine(line).kind, "html", "non-left alignment is carried as serialized HTML");
  assertDeepEqual(richShape(result), [{ type: "p", text: "hello", align: "center" }], "rich align");

  const left = setAlign(result.blocks, collapsed(0, 0), "left");
  expectSingleLine(left, "hello", "left removes the alignment and the escape");
});

test("markdown-edit setAlign: headings, quotes, and lists keep their type", () => {
  const heading = setAlign(sourceBlocks("# title"), collapsed(0, 2), "right");
  assertDeepEqual(richShape(heading), [{ type: "h1", text: "title", align: "right" }], "heading");

  const quote = setAlign(sourceBlocks("> quote"), collapsed(0, 2), "justify");
  assertDeepEqual(richShape(quote), [{ type: "quote", text: "quote", align: "justify" }], "quote");

  const list = setAlign(sourceBlocks("- item"), collapsed(0, 2), "center");
  assertDeepEqual(
    richShape(list),
    [{ type: "list", text: "item", ordered: false, align: "center" }],
    "list item alignment",
  );
});

test("markdown-edit setAlign: no-ops and skipped lines", () => {
  assertEqual(setAlign(sourceBlocks("hello"), collapsed(0, 2), "left"), null, "left on left is nothing");
  assertEqual(setAlign(sourceBlocks("hello"), collapsed(0, 2), "middle"), null, "unknown alignment");

  const fenced = sourceBlocks("```", "code", "```");
  assertEqual(setAlign(fenced, collapsed(1, 2), "center"), null, "code is outside paragraph alignment");

  const image = imageBlock();
  const blocks = [sourceBlocks("a")[0], image];
  const result = setAlign(blocks, collapseAll(blocks), "center");
  assert(result, "text line aligned");
  assertEqual(result.blocks[1], image, "image untouched");
});

test("markdown-edit setAlign: a multi-line selection aligns every paragraph line", () => {
  const result = setAlign(sourceBlocks("one", "two"), selection(0, 0, 1, 3), "center");
  assertDeepEqual(
    richShape(result),
    [
      { type: "p", text: "one", align: "center" },
      { type: "p", text: "two", align: "center" },
    ],
    "both paragraphs centered",
  );
  assertEqual(result.anchor.block, 0, "anchor block preserved");
  assertEqual(result.focus.block, 1, "focus block preserved");
});

/* --------------------------------------------------------------------------
   clearFormatting
   -------------------------------------------------------------------------- */

test("markdown-edit clearFormatting: strips inline markers from the selection", () => {
  const blocks = sourceBlocks("**bold** and *italic*");
  const result = clearFormatting(blocks, selection(0, 0, 0, blockText(blocks[0]).length));
  expectSingleLine(result, "bold and italic", "all inline markers removed");

  const partial = clearFormatting(sourceBlocks("hello world"), selection(0, 0, 0, 5));
  assertEqual(partial, null, "plain selected text is a no-op");
  assertEqual(clearFormatting(sourceBlocks("**bold**"), collapsed(0, 2)), null, "collapsed selection changes nothing");
});

test("markdown-edit clearFormatting: keeps the line style and skips code", () => {
  const list = sourceBlocks("- **item**");
  const result = clearFormatting(list, selection(0, 2, 0, blockText(list[0]).length));
  expectSingleLine(result, "- item", "the list marker is kept");

  const fenced = sourceBlocks("```", "**code**", "```");
  assertEqual(clearFormatting(fenced, collapsed(1, 0)), null, "code content is untouched");

  const blocks = sourceBlocks("a `code` b");
  const inline = clearFormatting(blocks, selection(0, 2, 0, 8));
  expectSingleLine(inline, "a code b", "inline code markers removed");
});

test("markdown-edit clearFormatting: multi-line selections are cleared per line", () => {
  const blocks = sourceBlocks("**one**", "*two*");
  const result = clearFormatting(blocks, selection(0, 0, 1, blockText(blocks[1]).length));
  assertEqual(texts(result).join("|"), "one|two", "both lines cleared");
});

/* --------------------------------------------------------------------------
   Escaped text, caret maps, and robustness
   -------------------------------------------------------------------------- */

test("markdown-edit: escaped markers are literal text, not formatting", () => {
  const blocks = sourceBlocks("a \\*literal\\* b");
  assertEqual(inspect(blocks, collapsed(0, 4)).marks.i, false, "escaped stars are not italic");

  const result = setMark(blocks, selection(0, 4, 0, 11), "b");
  assertEqual(blockText(result.blocks[0]), "a \\***literal**\\* b", "bold wraps the word, not the escapes");
  const rich = richOf(result);
  assert(
    rich[0].runs.some((run) => run.b && run.text === "literal"),
    "the wrapped word is the only bold run",
  );
});

test("markdown-edit: a paragraph that looks structural becomes a heading safely", () => {
  const blocks = sourceBlocks("\\# not a heading");
  const result = setBlockStyle(blocks, collapsed(0, 2), "h1");
  assertEqual(texts(result)[0], "# # not a heading", "heading marker added without losing the text");
  assertDeepEqual(richShape(result), [{ type: "h1", text: "# not a heading" }], "the escaped hash is paragraph text");
});

test("markdown-edit setMark: italic and code pairs unwrap from a selection", () => {
  expectSingleLine(setMark(sourceBlocks("a *word* b"), selection(0, 3, 0, 7), "i"), "a word b", "italic pair");
  expectSingleLine(setMark(sourceBlocks("a `code` b"), selection(0, 3, 0, 7), "code"), "a code b", "code pair");
});

test("markdown-edit links: linkAt finds a link by selection and misses outside", () => {
  const blocks = sourceBlocks("a [label](https://example.com) b");
  const found = linkAt(blocks, selection(0, 2, 0, 8));
  assert(found, "a selection touching the link finds it");
  assertEqual(found.href, "https://example.com", "href");
  assertEqual(found.from, 2, "link start");
  assertEqual(found.to, 30, "link end");
  assertEqual(linkAt(blocks, selection(0, 30, 0, 32)), null, "a selection after the link finds nothing");
});

test("markdown-edit setBlockStyle code: an image splits the fenced groups", () => {
  const image = imageBlock();
  const blocks = [sourceBlocks("a")[0], image, sourceBlocks("b")[0]];
  const result = setBlockStyle(blocks, selection(0, 0, 2, 1), "code");
  assertEqual(texts(result).join("|"), "```|a|```|<image>|```|b|```", "two fenced groups around the image");
  assertDeepEqual(
    richShape(result),
    [
      { type: "code", text: "a" },
      { type: "image" },
      { type: "code", text: "b" },
    ],
    "each text run is its own code block",
  );
});

test("markdown-edit setBlockStyle code: an unterminated fence toggles off", () => {
  const blocks = sourceBlocks("```", "code");
  const result = setBlockStyle(blocks, collapsed(1, 2), "code");
  assertEqual(texts(result).join("|"), "code", "the opening fence line is removed");
  assertEqual(result.blocks[0], blocks[1], "the code line keeps its identity");
});

test("markdown-edit toggleList: ordered markers with real numbers toggle off", () => {
  const blocks = sourceBlocks("1. one", "2. two");
  const result = toggleList(blocks, selection(0, 0, 1, 6), true);
  assertEqual(texts(result).join("|"), "one|two", "the digits and markers are removed, the text kept");
});

test("markdown-edit setAlign: the caret maps through the HTML escape and back", () => {
  const centered = setAlign(sourceBlocks("hello"), collapsed(0, 2), "center");
  const line = blockText(centered.blocks[0]);
  assertEqual(line, '<p data-align="center">hello</p>', "the documented HTML shape");
  assertEqual(
    line.slice(0, centered.anchor.offset),
    '<p data-align="center">he',
    "the caret keeps its visible position inside the escape line",
  );

  const left = setAlign(centered.blocks, { ...centered, collapsed: true }, "left");
  expectSingleLine(left, "hello", "back to a plain line");
  assertEqual(left.anchor.offset, 2, "the caret maps back to the visible text");
});

test("markdown-edit setBlockStyle: the caret maps past an escaped block marker", () => {
  const blocks = sourceBlocks("\\# text");
  const result = setBlockStyle(blocks, collapsed(0, 4), "h1");
  assertEqual(texts(result)[0], "# # text", "heading marker plus the escaped paragraph text");
  assertEqual(result.anchor.offset, 5, "the caret keeps its visible place after the escaped hash");
});

test("markdown-edit links: urls with parentheses round-trip through link actions", () => {
  const href = "https://en.wikipedia.org/wiki/Foo_(bar)";
  const blocks = sourceBlocks("a [label](" + href + ") b");
  const found = linkAt(blocks, collapsed(0, 4));
  assert(found, "a link with parentheses in the url is found");
  assertEqual(found.href, href, "the whole url is reported");

  const changed = setLink(blocks, collapsed(0, 4), "https://new.example/path_(x)");
  assertEqual(texts(changed)[0], "a [label](https://new.example/path_(x)) b", "the url is replaced");
  const removed = removeLink(changed.blocks, collapsed(0, 4));
  assertEqual(texts(removed)[0], "a label b", "the link around that url is removed");
});

test("markdown-edit links: image syntax stays literal text, not a link", () => {
  const blocks = sourceBlocks("![alt](https://example.com)");
  assertEqual(linkAt(blocks, collapsed(0, 3)), null, "image syntax is not a link");
  assertEqual(inspect(blocks, collapsed(0, 3)).href, "", "the toolbar shows no link");
  assertEqual(
    clearFormatting(blocks, selection(0, 0, 0, blockText(blocks[0]).length)),
    null,
    "there is no inline marker to clear",
  );
});

/* --------------------------------------------------------------------------
   Lines carried as serialized HTML (alignment et al.)
   -------------------------------------------------------------------------- */

function escapeLine(block) {
  return blockToLines(block)[0];
}

test("markdown-edit setMark: marks work on an aligned HTML-carried line", () => {
  const line = escapeLine({ type: "p", runs: [{ text: "hi" }], align: "center" });
  assertEqual(readLine(line).kind, "html", "the line is the HTML escape form");
  const start = line.indexOf("hi");
  const result = setMark(sourceBlocks(line), selection(0, start, 0, start + 2), "b");
  assert(result, "bold changed the line");
  const rich = richOf(result);
  assertEqual(rich[0].type, "p", "still a paragraph");
  assertEqual(rich[0].align, "center", "the alignment is kept");
  assert(rich[0].runs.some((run) => run.b && run.text === "hi"), "the selected text is bold");
});

test("markdown-edit setMark: a caret inside a bold HTML-carried line clears it", () => {
  const line = escapeLine({ type: "p", runs: [{ text: "hi", b: true }], align: "center" });
  const start = line.indexOf("hi");
  const result = setMark(sourceBlocks(line), collapsed(0, start + 1), "b");
  assert(result, "the bold run was found at the caret");
  const rich = richOf(result);
  assertEqual(rich[0].align, "center", "the alignment is kept");
  assert(!rich[0].runs.some((run) => run.b), "the bold mark is gone");
});

test("markdown-edit clearFormatting: clears marks on an HTML-carried line", () => {
  const line = escapeLine({
    type: "p",
    runs: [{ text: "bold", b: true }, { text: " plain" }],
    align: "center",
  });
  const result = clearFormatting(sourceBlocks(line), selection(0, 0, 0, line.length));
  assert(result, "formatting was cleared");
  assertDeepEqual(
    richShape(result),
    [{ type: "p", text: "bold plain", align: "center" }],
    "text and alignment survive, the mark does not",
  );
});

test("markdown-edit links: links work on an aligned HTML-carried line", () => {
  const line = escapeLine({
    type: "p",
    runs: [{ text: "label", href: "https://old.example" }],
    align: "center",
  });
  const start = line.indexOf("label");
  const found = linkAt(sourceBlocks(line), collapsed(0, start + 2));
  assert(found, "the link inside the HTML line is found");
  assertEqual(found.href, "https://old.example", "href reported");
  assertEqual(found.from, start, "link start maps back to the source line");

  const replaced = setLink(sourceBlocks(line), collapsed(0, start + 2), "https://new.example");
  assert(replaced, "the url was replaced");
  const rich = richOf(replaced);
  assertEqual(rich[0].align, "center", "alignment kept");
  assertEqual(rich[0].runs[0].href, "https://new.example", "new href stored");

  const caret = blockText(replaced.blocks[0]).indexOf("label") + 2;
  const removed = removeLink(replaced.blocks, collapsed(0, caret));
  assert(removed, "the link was removed");
  const plain = richOf(removed);
  assertEqual(plain[0].align, "center", "alignment kept after removal");
  assertEqual(blockText(plain[0]), "label", "the label text is kept");
  assert(!plain[0].runs.some((run) => run.href), "no link remains");
});



test("markdown-edit: every command is total and keeps a valid selection", () => {
  let seed = 20261117;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const alphabet = ["a", "b", " ", "*", "_", "~", "`", "[", "]", "(", ")", "<", ">", "#", "-", "+", "1", ".", "\\", "!", "|", "/", ":"];
  const keys = ["b", "i", "u", "s", "code"];
  const styles = ["p", "h1", "h2", "h3", "quote", "code"];
  const aligns = ["left", "center", "right", "justify"];

  for (let round = 0; round < 50; round += 1) {
    const lineCount = 1 + Math.floor(random() * 4);
    const lines = [];
    for (let index = 0; index < lineCount; index += 1) {
      const length = Math.floor(random() * 18);
      let line = "";
      for (let at = 0; at < length; at += 1) {
        line += alphabet[Math.floor(random() * alphabet.length)];
      }
      lines.push(line);
    }
    const blocks = sourceBlocks(...lines);
    if (round % 7 === 0) {
      blocks.push(imageBlock());
    }
    const lastBlock = blocks.length - 1;
    const offsetWithin = (block) => Math.floor(random() * (blockText(blocks[block]).length + 1));
    const anchorBlock = Math.floor(random() * (lastBlock + 1));
    const focusBlock = Math.floor(random() * (lastBlock + 1));
    const anchor = { block: anchorBlock, offset: offsetWithin(anchorBlock) };
    const focus =
      random() < 0.5 ? { ...anchor } : { block: focusBlock, offset: offsetWithin(focusBlock) };
    const sel = {
      anchor,
      focus,
      collapsed: anchor.block === focus.block && anchor.offset === focus.offset,
    };

    const actions = [
      () => inspect(blocks, sel),
      () => setMark(blocks, sel, keys[Math.floor(random() * keys.length)]),
      () => setLink(blocks, sel, "https://example.com/x"),
      () => removeLink(blocks, sel),
      () => linkAt(blocks, sel),
      () => setBlockStyle(blocks, sel, styles[Math.floor(random() * styles.length)]),
      () => toggleList(blocks, sel, random() < 0.5),
      () => setAlign(blocks, sel, aligns[Math.floor(random() * aligns.length)]),
      () => clearFormatting(blocks, sel),
    ];

    for (const action of actions) {
      const result = action();
      if (!result || !Array.isArray(result.blocks)) {
        continue;
      }
      assert(result.blocks.length > 0, "a changed document keeps at least one block");
      for (const position of [result.anchor, result.focus]) {
        assert(position && Number.isInteger(position.block) && Number.isInteger(position.offset), "selection positions are integers");
        assert(position.block >= 0 && position.block < result.blocks.length, "selection block is in range");
        const length =
          result.blocks[position.block].type === "image"
            ? 0
            : blockText(result.blocks[position.block]).length;
        assert(position.offset >= 0 && position.offset <= length, "selection offset is in range");
      }
      sourceToRich(result.blocks);
    }
  }
});


/* --------------------------------------------------------------------------
   Marker-structure safety regressions
   -------------------------------------------------------------------------- */

test("markdown-edit setMark: a whole-heading selection keeps its block marker", () => {
  const blocks = sourceBlocks("first", "# Title", "last");
  const result = setMark(blocks, selection(0, 0, 2, 4), "b");
  assertEqual(texts(result)[0], "**first**", "first paragraph wrapped");
  assertEqual(texts(result)[1], "# **Title**", "heading marker stays outside the marks");
  assertEqual(texts(result)[2], "**last**", "last paragraph wrapped");
  const rich = sourceToRich(result.blocks).blocks;
  assertEqual(rich[1].type, "h1", "the line reparses as a heading");
  assertEqual(blockText(rich[1]), "Title", "the heading text is not a literal marker");
});

test("markdown-edit setMark: a whole-list selection keeps the list marker and indent", () => {
  const blocks = sourceBlocks("text", "  - item");
  const result = setMark(blocks, selection(0, 0, 1, 9), "b");
  assertEqual(texts(result)[1], "  - **item**", "list marker and indent stay outside the marks");
  const rich = sourceToRich(result.blocks).blocks;
  assertEqual(rich[1].type, "list", "the line reparses as a list item");
});

test("markdown-edit setMark: a selection cutting through existing markers is left alone", () => {
  assertEqual(
    setMark(sourceBlocks("***both***"), selection(0, 3, 0, 7), "b"),
    null,
    "selecting the content of a combined span does not add more markers",
  );
  assertEqual(
    setMark(sourceBlocks("**bold**"), selection(0, 3, 0, 5), "i"),
    null,
    "selecting inside bold does not inject italic markers",
  );
  assertEqual(
    setMark(sourceBlocks("a `code` b"), selection(0, 5, 0, 7), "b"),
    null,
    "selecting inside inline code does not wrap it",
  );
});

test("markdown-edit links: a whole-heading selection keeps its block marker", () => {
  const blocks = sourceBlocks("# Title", "plain");
  const result = setLink(blocks, selection(0, 0, 1, 5), "https://example.com");
  assertEqual(texts(result)[0], "# [Title](https://example.com)", "heading marker stays outside the link");
  assertEqual(texts(result)[1], "[plain](https://example.com)", "paragraph line linked");
  const rich = sourceToRich(result.blocks).blocks;
  assertEqual(rich[0].type, "h1", "the line reparses as a heading");
});
