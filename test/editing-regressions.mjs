// Run directly with node --test test/editing-regressions.mjs.
// These exercise the editor commands and saved document model without painting.
import assert from "node:assert/strict";
import test from "node:test";
import { selectionHtml } from "../assets/doc/clipboard.js";
import { DocEditor } from "../assets/doc/input.js";
import { richToSource, sourceToRich } from "../assets/doc/markdown.js";
import { blockText, createBlock, findSearchPassage, serializeDocument } from "../assets/doc/model.js";

test("saving a numbered sublist keeps it under its bullet", () => {
  const source = ["- Packing", "  1. Passport", "- Transport"];
  const lines = source.map((text) => createBlock("p", [{ text }]));
  const { blocks } = sourceToRich(lines);
  assert.deepEqual(blocks.map((item) => item.depth), [0, 1, 0]);
  assert.equal(
    serializeDocument(blocks),
    "<ul><li>Packing<ol><li>Passport</li></ol></li><li>Transport</li></ul>",
  );
});

test("copying across mixed list levels keeps the selected parents and siblings", () => {
  const source = [
    "1. Omitted", "  - Start", "    1. Child", "  1. Sibling",
    "2. Root", "  - Bullet", "  1. Number", "- Next",
  ];
  const { blocks } = sourceToRich(source.map((text) => createBlock("p", [{ text }])));
  const html = selectionHtml(blocks, { block: 1, offset: 0 }, { block: 7, offset: 4 });
  assert.equal(html,
    "<ul><li>Start<ol><li>Child</li></ol></li></ul>" +
    "<ol><li>Sibling</li><li>Root<ul><li>Bullet</li></ul><ol><li>Number</li></ol></li></ol>" +
    "<ul><li>Next</li></ul>",
  );
});

function image(alt) {
  return {
    type: "image", alt, mode: "block", width: 1, height: 1,
    src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  };
}

function editorWith(blocks) {
  const editor = new DocEditor({ root: { querySelector: () => null }, textarea: {} });
  editor.relayout = () => {};
  editor.sync = () => {};
  editor.view.scrollCaretIntoView = () => {};
  editor.setDocument(blocks);
  return editor;
}

function paragraph(text) {
  return createBlock("p", [{ text }]);
}

function editorWithImages() {
  const editor = editorWith([]);
  for (const alt of ["First", "Second", "Third"]) {
    editor.insertImage(image(alt));
  }
  return editor;
}

test("typing over two selected images preserves the third image", () => {
  const editor = editorWithImages();
  const original = editor.getDocument();
  editor.setSelection({ block: 0, offset: 0 }, { block: 1, offset: 0 });
  const selection = editor.getSelection();
  editor.insertText("Replacement");
  const result = editor.getDocument();
  assert.equal(blockText(result[0]), "Replacement");
  assert.deepEqual(result.slice(1), original.slice(2));
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: "Replacement".length });
  editor.undo();
  assert.deepEqual(editor.getDocument(), original);
  assert.deepEqual(editor.getSelection(), selection);
  editor.redo();
  assert.deepEqual(editor.getDocument(), result);
});

test("pasting an image over selected images keeps the next picture and a caret before it", () => {
  const editor = editorWithImages();
  const third = editor.getDocument()[2];
  editor.setSelection({ block: 1, offset: 0 }, { block: 0, offset: 0 });
  editor.insertBlocks([image("Pasted")]);
  editor.insertText("Caption");
  const blocks = editor.getDocument();
  assert.equal(blocks[0].alt, "Pasted");
  assert.equal(blockText(blocks[1]), "Caption");
  assert.equal(blocks[2], third);
});

function clipboardEvent() {
  const values = new Map();
  return {
    clipboardData: {
      getData: (type) => values.get(type) ?? "",
      setData: (type, value) => values.set(type, value),
    },
    preventDefault() {},
  };
}

// The reference is an ordinary string with one newline between paragraphs.
// Enumerate only positions a user can reach, including the empty middle line.
const graphemes = [["A", "🇵🇹", "e\u0301"], [], ["👩🏽‍💻", "Z"]];
const paragraphs = graphemes.map((line) => line.join(""));
const plainText = paragraphs.join("\n");
const positions = [];
let lineStart = 0;
for (const [block, line] of graphemes.entries()) {
  let offset = 0;
  positions.push({ caret: { block, offset }, index: lineStart });
  for (const grapheme of line) {
    offset += grapheme.length;
    positions.push({ caret: { block, offset }, index: lineStart + offset });
  }
  lineStart += offset + 1;
}

for (const operation of ["cut", "paste"]) {
  test(operation + " at every selection boundary matches plain text, including undo and redo", () => {
    for (const anchor of positions) {
      for (const focus of positions) {
        if (operation === "cut" && anchor.index === focus.index) continue;
        const editor = editorWith(paragraphs.map(paragraph));
        editor.setSelection(anchor.caret, focus.caret);
        const before = editor.getDocument();
        const selection = editor.getSelection();
        const start = Math.min(anchor.index, focus.index);
        const end = Math.max(anchor.index, focus.index);
        const selected = plainText.slice(start, end);
        const event = clipboardEvent();
        const message = operation + " from " + anchor.index + " to " + focus.index;
        assert.equal(editor.selectionText(), selected, message);
        let inserted = "";
        if (operation === "cut") {
          editor.handleCopy(event, true);
          assert.equal(event.clipboardData.getData("text/plain"), selected, message);
        } else {
          event.clipboardData.setData("text/plain", "new\r\nline");
          editor.handlePaste(event);
          inserted = "new\nline";
        }
        const expectedPrefix = plainText.slice(0, start) + inserted;
        const expectedLines = (expectedPrefix + plainText.slice(end)).split("\n");
        const prefixLines = expectedPrefix.split("\n");
        const caret = { block: prefixLines.length - 1, offset: prefixLines.at(-1).length };
        assert.deepEqual(editor.getDocument().map(blockText), expectedLines, message);
        assert.deepEqual(editor.getSelection(), { anchor: caret, focus: caret, collapsed: true }, message);
        editor.undo();
        assert.deepEqual(editor.getDocument(), before, message);
        assert.deepEqual(editor.getSelection(), selection, message);
        editor.redo();
        assert.deepEqual(editor.getDocument().map(blockText), expectedLines, message);
        assert.deepEqual(editor.getSelection().focus, caret, message);
      }
    }
  });
}

test("Backspace and Delete remove one grapheme even when its marks change halfway through", () => {
  for (const [first, rest] of [["e", "\u0301"], ["👩🏽", "\u200d💻"], ["🇵", "🇹"]]) {
    const original = createBlock("p", [
      { text: "L" }, { text: first, b: true }, { text: rest, i: true }, { text: "R" },
    ]);
    for (const key of ["Backspace", "Delete"]) {
      const editor = editorWith([original]);
      const offset = key === "Backspace" ? 1 + first.length + rest.length : 1;
      editor.collapseTo({ block: 0, offset });
      editor.handleKeyDown({ key, preventDefault() {} });
      assert.equal(serializeDocument(editor.getDocument()), "<p>LR</p>");
      assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 1 });
      editor.undo();
      assert.deepEqual(editor.getDocument(), [original]);
      assert.equal(editor.getSelection().focus.offset, offset);
    }
  }
});

test("a reverse selection can be indented and outdented without changing text, marks, or endpoints", () => {
  const blocks = [
    createBlock("p", [{ text: "title\n" }, { text: "bold", b: true }]),
    createBlock("code", [{ text: "a\n\nb" }]),
    paragraph("untouched"),
  ];
  const editor = editorWith(blocks);
  editor.setSelection({ block: 2, offset: 0 }, { block: 0, offset: 6 });
  const selection = editor.getSelection();
  editor.handleTab(1);
  assert.deepEqual(editor.getDocument().map(blockText), ["title\n    bold", "\ta\n\t\n\tb", "untouched"]);
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 10 });
  editor.handleTab(-1);
  assert.equal(serializeDocument(editor.getDocument()), serializeDocument(blocks));
  assert.deepEqual(editor.getSelection(), selection);
});

test("canceling composition leaves a reverse selection intact, and committing it takes one undo", () => {
  const editor = editorWith([paragraph("left"), paragraph("right")]);
  editor.setSelection({ block: 1, offset: 2 }, { block: 0, offset: 2 });
  const selection = editor.getSelection();
  const before = editor.getDocument();
  editor.handleCompositionStart();
  editor.textarea.value = "n";
  editor.handleInput();
  editor.handleCompositionEnd({ data: "" });
  assert.deepEqual(editor.getSelection(), selection);
  assert.deepEqual(editor.getDocument(), before);
  assert.equal(editor.getHistory().undo.length, 0);
  editor.handleCompositionStart();
  editor.textarea.value = "に";
  editor.handleInput();
  editor.handleCompositionEnd({ data: "日本" });
  assert.deepEqual(editor.getDocument().map(blockText), ["le日本ght"]);
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 4 });
  editor.undo();
  assert.deepEqual(editor.getDocument(), before);
  assert.deepEqual(editor.getSelection(), selection);
});

test("rich copy includes the paragraph break when the selection ends at the next line start", () => {
  const editor = editorWith([paragraph("one"), paragraph("two")]);
  editor.setSelection({ block: 0, offset: 0 }, { block: 1, offset: 0 });
  const event = clipboardEvent();
  editor.handleCopy(event, false);
  assert.equal(event.clipboardData.getData("text/plain"), "one\n");
  assert.equal(event.clipboardData.getData("text/html"), "<p>one</p><p></p>");
});

test("copying across heading boundaries keeps selected breaks without borrowing heading styles", () => {
  const blocks = [
    createBlock("h1", [{ text: "Before" }]), paragraph("middle"), createBlock("h2", [{ text: "After" }]),
  ];
  const editor = editorWith(blocks);
  editor.setSelection({ block: 2, offset: 0 }, { block: 0, offset: 6 });
  const event = clipboardEvent();
  editor.handleCopy(event, false);
  assert.equal(event.clipboardData.getData("text/plain"), "\nmiddle\n");
  assert.equal(event.clipboardData.getData("text/html"), "<p></p><p>middle</p><p></p>");
});

test("rich paste preserves deliberately blank paragraphs around a heading", () => {
  const editor = editorWith([paragraph("")]);
  editor.insertBlocks([paragraph(""), createBlock("h2", [{ text: "Chapter" }]), paragraph("")]);
  assert.equal(serializeDocument(editor.getDocument()), "<p></p><h2>Chapter</h2><p></p>");
  assert.deepEqual(editor.getSelection().focus, { block: 2, offset: 0 });
});

test("the same selection across prose and code pastes the same heading in either direction", () => {
  const blocks = [paragraph("Left X"), createBlock("code", [{ text: "Y Right" }])];
  const from = { block: 0, offset: 5 };
  const to = { block: 1, offset: 1 };
  for (const [anchor, focus] of [[to, from], [from, to]]) {
    const editor = editorWith(blocks);
    editor.setSelection(anchor, focus);
    assert.equal(editor.selectionText(), "X\nY");
    editor.insertBlocks([createBlock("h2", [{ text: "Middle" }])]);
    assert.equal(serializeDocument(editor.getDocument()), "<p>Left </p><h2>Middle</h2><p> Right</p>");
  }
});

test("a selection starting in code pastes multiline rich text as code in either direction", () => {
  const blocks = [createBlock("code", [{ text: "let X" }]), paragraph("Y = 1")];
  const from = { block: 0, offset: 4 };
  const to = { block: 1, offset: 1 };
  for (const [anchor, focus] of [[from, to], [to, from]]) {
    const editor = editorWith(blocks);
    editor.setSelection(anchor, focus);
    const selection = editor.getSelection();
    editor.insertBlocks([createBlock("h2", [{ text: "a", b: true }]), paragraph("b")]);
    assert.equal(serializeDocument(editor.getDocument()), "<pre>let a\nb = 1</pre>");
    assert.ok(editor.getDocument()[0].runs.every((run) => !run.b));
    assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 7 });
    editor.undo();
    assert.deepEqual(editor.getDocument(), blocks);
    assert.deepEqual(editor.getSelection(), selection);
  }
});

test("Ctrl+Right moves to or beyond the right edge of a multiword selection", () => {
  for (const [anchor, focus] of [[0, 13], [13, 0]]) {
    const editor = editorWith([paragraph("one two three four")]);
    editor.setSelection({ block: 0, offset: anchor }, { block: 0, offset: focus });
    editor.handleKeyDown({ key: "ArrowRight", ctrlKey: true, preventDefault() {} });
    const selection = editor.getSelection();
    assert.ok(selection.collapsed);
    assert.ok(selection.focus.offset >= 13, "rightward movement landed at offset " + selection.focus.offset);
  }
});

test("search maps case expansion, emoji, and a cross-paragraph match back to original text", () => {
  const blocks = [
    createBlock("p", [{ text: "🇵🇹 İ", b: true }, { text: "zmir" }]),
    paragraph(" \t\u00a0harbour  harbour"),
  ];
  const match = findSearchPassage(blocks, "i\u0307zmir  HARBOUR");
  const editor = editorWith(blocks);
  editor.setSelection(match.from, match.to);
  assert.equal(editor.selectionText(), "İzmir\n \t\u00a0harbour");
  assert.equal(findSearchPassage(blocks, "missing"), null);
});

test("editing a fenced code line in Markdown preserves surrounding blank lines, backticks, and undo", () => {
  const fence = "```";
  const blocks = [
    paragraph("before"), createBlock("code", [{ text: "\n" + fence + "\nanswer\n" }]), paragraph("after"),
  ];
  const source = richToSource(blocks).blocks;
  const editor = editorWith(source);
  editor.setSourceMode(true);
  const line = source.findIndex((block) => blockText(block) === "answer");
  assert.ok(line >= 0);
  editor.setSelection({ block: line, offset: 6 }, { block: line, offset: 0 });
  editor.insertText("42");
  const converted = sourceToRich(editor.getDocument()).blocks;
  assert.deepEqual(converted.map((block) => [block.type, blockText(block)]), [
    ["p", "before"], ["code", "\n" + fence + "\n42\n"], ["p", "after"],
  ]);
  editor.undo();
  assert.equal(serializeDocument(sourceToRich(editor.getDocument()).blocks), serializeDocument(blocks));
});

test("toggling bold on a mixed selection preserves its italic text and link", () => {
  const editor = editorWith([createBlock("p", [
    { text: "A", b: true }, { text: "B", i: true, href: "#notes" }, { text: "C" },
  ])]);
  editor.setSelection({ block: 0, offset: 2 }, { block: 0, offset: 0 });
  editor.toggleMark("b");
  assert.equal(serializeDocument(editor.getDocument()),
    '<p><b>A</b><a href="#notes"><b><i>B</i></b></a>C</p>');
  editor.toggleMark("b");
  assert.equal(serializeDocument(editor.getDocument()),
    '<p>A<a href="#notes"><i>B</i></a>C</p>');
});

test("underlining a run of spaces can be toggled off again", () => {
  const editor = editorWith([paragraph("left   right")]);
  editor.setSelection({ block: 0, offset: 4 }, { block: 0, offset: 7 });
  editor.toggleMark("u");
  assert.equal(serializeDocument(editor.getDocument()), "<p>left<u>   </u>right</p>");
  editor.toggleMark("u");
  assert.equal(serializeDocument(editor.getDocument()), "<p>left   right</p>");
});

test("clearing a reverse selection keeps block styles, code, and marks outside the range", () => {
  const blocks = [
    createBlock("h2", [{ text: "Book", i: true }], { align: "right" }),
    createBlock("code", [{ text: "x\n y" }]),
    createBlock("p", [{ text: "Read", b: true, href: "#book" }]),
  ];
  const editor = editorWith(blocks);
  editor.setSelection({ block: 2, offset: 2 }, { block: 0, offset: 2 });
  const selection = editor.getSelection();
  editor.clearFormatting();
  const expected = '<h2 data-align="right"><i>Bo</i>ok</h2><pre>x\n y</pre>' +
    '<p>Re<a href="#book"><b>ad</b></a></p>';
  assert.equal(serializeDocument(editor.getDocument()), expected);
  assert.deepEqual(editor.getSelection(), selection);
  editor.undo();
  assert.deepEqual(editor.getDocument(), blocks);
  editor.redo();
  assert.equal(serializeDocument(editor.getDocument()), expected);
});

test("clearing formatting at a caret in a link applies only to new typing", () => {
  const editor = editorWith([createBlock("p", [{ text: "AB", b: true, href: "#book" }])]);
  editor.collapseTo({ block: 0, offset: 1 });
  editor.clearFormatting();
  editor.insertText("plain");
  assert.equal(serializeDocument(editor.getDocument()),
    '<p><a href="#book"><b>A</b></a>plain<a href="#book"><b>B</b></a></p>');
});

test("replacing plain text next to a link keeps the replacement outside the link in either direction", () => {
  const blocks = [createBlock("p", [{ text: "Guide", href: "#guide" }, { text: " draft" }])];
  for (const [anchor, focus] of [[5, 11], [11, 5]]) {
    const editor = editorWith(blocks);
    editor.setSelection({ block: 0, offset: anchor }, { block: 0, offset: focus });
    assert.equal(editor.selectionText(), " draft");
    editor.insertText(" notes");
    assert.equal(serializeDocument(editor.getDocument()), '<p><a href="#guide">Guide</a> notes</p>',
      "selection from " + anchor + " to " + focus);
  }
});

test("relinking part of two adjacent links keeps the original targets on both sides", () => {
  const blocks = [createBlock("p", [
    { text: "AB", href: "#first" }, { text: "CD", href: "#second" },
  ])];
  const editor = editorWith(blocks);
  editor.setSelection({ block: 0, offset: 3 }, { block: 0, offset: 1 });
  editor.setLink("#middle", "suggested label");
  assert.equal(serializeDocument(editor.getDocument()),
    '<p><a href="#first">A</a><a href="#middle">BC</a><a href="#second">D</a></p>');
  editor.collapseTo({ block: 0, offset: 2 });
  assert.equal(editor.removeLinkAtCaret(), true);
  assert.equal(serializeDocument(editor.getDocument()),
    '<p><a href="#first">A</a>BC<a href="#second">D</a></p>');
});

test("replacing the linked word itself preserves its link in either direction", () => {
  const blocks = [createBlock("p", [{ text: "Guide", href: "#guide" }, { text: " draft" }])];
  for (const [anchor, focus] of [[0, 5], [5, 0]]) {
    const editor = editorWith(blocks);
    editor.setSelection({ block: 0, offset: anchor }, { block: 0, offset: focus });
    editor.insertText("Manual");
    assert.equal(serializeDocument(editor.getDocument()), '<p><a href="#guide">Manual</a> draft</p>');
  }
});

test("replacing a paragraph break and the following word uses the selected word's formatting", () => {
  const blocks = [
    createBlock("p", [{ text: "Guide", href: "#guide" }]),
    createBlock("p", [{ text: "Draft", b: true }]),
  ];
  const start = { block: 0, offset: 5 };
  const end = { block: 1, offset: 5 };
  for (const [anchor, focus] of [[start, end], [end, start]]) {
    const editor = editorWith(blocks);
    editor.setSelection(anchor, focus);
    editor.insertText("Notes");
    assert.equal(serializeDocument(editor.getDocument()), '<p><a href="#guide">Guide</a><b>Notes</b></p>');
  }
});

test("plain whitespace between bold words still allows both words to toggle back to plain", () => {
  const editor = editorWith([createBlock("p", [{ text: "one", b: true }, { text: " " }, { text: "two", b: true }])]);
  editor.setSelection({ block: 0, offset: 0 }, { block: 0, offset: 7 });
  editor.toggleMark("b");
  assert.equal(serializeDocument(editor.getDocument()), "<p>one two</p>");
});

test("a formatting shortcut on just a paragraph break preserves redo", () => {
  const editor = editorWith([paragraph("A"), paragraph("B")]);
  editor.collapseTo({ block: 0, offset: 1 });
  editor.insertText("1");
  editor.undo();
  editor.setSelection({ block: 0, offset: 1 }, { block: 1, offset: 0 });
  editor.handleKeyDown({ key: "b", ctrlKey: true, preventDefault() {} });
  editor.redo();
  assert.equal(serializeDocument(editor.getDocument()), "<p>A1</p><p>B</p>");
});

test("a bold shortcut on selected code leaves a previous text edit available to redo", () => {
  const editor = editorWith([paragraph("A"), createBlock("code", [{ text: "fn" }])]);
  editor.collapseTo({ block: 0, offset: 1 });
  editor.insertText("B");
  editor.undo();
  editor.setSelection({ block: 1, offset: 0 }, { block: 1, offset: 2 });
  editor.handleKeyDown({ key: "b", ctrlKey: true, preventDefault() {} });
  assert.equal(serializeDocument(editor.getDocument()), "<p>A</p><pre>fn</pre>");
  editor.handleKeyDown({ key: "y", ctrlKey: true, preventDefault() {} });
  assert.equal(serializeDocument(editor.getDocument()), "<p>AB</p><pre>fn</pre>");
});
