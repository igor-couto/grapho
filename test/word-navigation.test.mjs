import assert from "node:assert/strict";
import test from "node:test";
import { blockText, createBlock, serializeDocument } from "../assets/doc/model.js";
import { editorWith, paragraph } from "./editor-fixture.mjs";

function wordKey(editor, key, extend = false) {
  editor.handleKeyDown({ key, ctrlKey: true, shiftKey: extend, preventDefault() {} });
}

const samples = [
  "café cafe\u0301, ação…fim",
  "العَرَبِيَّة ١٢٣! نهاية",
  "नमस्ते दुनिया",
  "早上好。こんにちは！",
  "👩🏽‍💻 🇵🇹 1️⃣ 👨‍👩‍👦",
  "first\tsecond\nthird\u00a0fourth",
];
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

test("word movement and Shift selection always advance by whole graphemes", () => {
  for (const text of samples) {
    const offsets = new Set([...Array.from(segmenter.segment(text), part => part.index), text.length]);
    const editor = editorWith([paragraph(text)]);
    for (const offset of offsets) {
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        const start = { block: 0, offset };
        for (const extend of [false, true]) {
          editor.collapseTo(start);
          wordKey(editor, key, extend);
          const { anchor, focus } = editor.getSelection();
          const label = JSON.stringify({ text, offset, key, extend });
          assert.equal(focus.block, 0, label);
          assert.ok(offsets.has(focus.offset), label);
          if (key === "ArrowLeft" && offset > 0) assert.ok(focus.offset < offset, label);
          if (key === "ArrowRight" && offset < text.length) assert.ok(focus.offset > offset, label);
          assert.deepEqual(anchor, extend ? start : focus, label);
          if (extend) {
            assert.equal(editor.selectionText(), text.slice(Math.min(offset, focus.offset), Math.max(offset, focus.offset)), label);
          }
        }
      }
    }
    assert.equal(blockText(editor.getDocument()[0]), text);
  }
});

test("Ctrl+Shift+Right stops at the word end before separators or punctuation", () => {
  for (const suffix of [" (beta)", " (", ", beta", " beta"]) {
    const editor = editorWith([paragraph("alpha" + suffix)]);
    wordKey(editor, "ArrowRight", true);
    assert.equal(editor.selectionText(), "alpha", suffix);
  }
});

test("word selection can extend past parentheses and reverse direction", () => {
  const editor = editorWith([paragraph("alpha (beta) gamma")]);
  editor.collapseTo({ block: 0, offset: "alpha (".length });
  wordKey(editor, "ArrowRight", true);
  assert.equal(editor.selectionText(), "beta");
  wordKey(editor, "ArrowLeft", true);
  assert.equal(editor.selectionText(), "");

  editor.collapseTo({ block: 0, offset: "alpha (beta".length });
  wordKey(editor, "ArrowLeft", true);
  assert.equal(editor.selectionText(), "beta");
  wordKey(editor, "ArrowRight", true);
  assert.equal(editor.selectionText(), "");

  editor.collapseTo({ block: 0, offset: 0 });
  wordKey(editor, "ArrowRight", true);
  wordKey(editor, "ArrowRight", true);
  assert.equal(editor.selectionText(), "alpha (beta");
  wordKey(editor, "ArrowRight", true);
  assert.equal(editor.selectionText(), "alpha (beta) gamma");
});

test("word selection and cut respect a contraction split across inline styles", () => {
  const original = createBlock("p", [
    { text: "Keep (" }, { text: "don", b: true }, { text: "\u2019t" },
    { text: ") and " }, { text: "continue", href: "#next" }, { text: "." },
  ]);
  const editor = editorWith([original]);
  editor.collapseTo({ block: 0, offset: "Keep (".length });
  wordKey(editor, "ArrowRight", true);
  assert.equal(editor.selectionText(), "don\u2019t");
  const selection = editor.getSelection();
  const clipboard = new Map();
  editor.handleCopy({ clipboardData: { setData: (type, value) => clipboard.set(type, value) }, preventDefault() {} }, true);
  assert.equal(clipboard.get("text/plain"), "don\u2019t");
  assert.equal(clipboard.get("text/html"), "<p><b>don</b>\u2019t</p>");
  assert.equal(serializeDocument(editor.getDocument()), '<p>Keep () and <a href="#next">continue</a>.</p>');
  editor.undo();
  assert.deepEqual(editor.getDocument(), [original]);
  assert.deepEqual(editor.getSelection(), selection);
  editor.redo();
  assert.deepEqual(editor.getSelection().focus, selection.anchor);
});

test("word selection crosses hard and paragraph breaks only as it extends", () => {
  const editor = editorWith([paragraph("draft\n(aside)"), paragraph("next section")]);
  for (const selected of ["draft", "draft\n(aside", "draft\n(aside)", "draft\n(aside)\n", "draft\n(aside)\nnext"]) {
    wordKey(editor, "ArrowRight", true);
    assert.equal(editor.selectionText(), selected);
  }
  const selection = editor.getSelection();
  editor.textarea.value = "First";
  editor.handleInput();
  assert.deepEqual(editor.getDocument().map(blockText), ["First section"]);
  editor.undo();
  assert.deepEqual(editor.getDocument().map(blockText), ["draft\n(aside)", "next section"]);
  assert.deepEqual(editor.getSelection(), selection);
});

test("double-click uses the character under the pointer on both sides of punctuation", (t) => {
  // Give each glyph ten pixels so the pointer positions are independent of fonts.
  const context = { measureText: (text) => ({ width: 10 * text.length }) };
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { delete globalThis.document; });
  const block = createBlock("p", [{ text: "(" }, { text: "beta", b: true }, { text: ")" }]);
  const editor = editorWith([block]);
  editor.root.getBoundingClientRect = () => ({ left: 0, top: 0 });
  editor.focusEditor = () => {};
  const fragments = [
    { text: "(", start: 0, end: 1, x: 0, width: 10 },
    { text: "beta", start: 1, end: 5, x: 10, width: 40 },
    { text: ")", start: 5, end: 6, x: 50, width: 10 },
  ];
  const line = { y: 0, height: 20, fragments };
  editor.layout = { blocks: [{ block, index: 0, top: 0, height: 20, lines: [line] }] };

  for (const [clientX, offset, expected] of [[8, 1, "("], [12, 1, "beta"], [48, 5, "beta"], [52, 5, ")"]]) {
    const event = { clientX, clientY: 10, preventDefault() {} };
    assert.deepEqual(editor.positionFromEvent(event), { block: 0, offset });
    editor.handleDoubleClick(event);
    assert.equal(editor.selectionText(), expected, `double-click at ${clientX}px`);
  }
});

test("Ctrl+Backspace removes the same text as selecting the previous word, across inline marks", () => {
  const original = createBlock("p", [
    { text: "Anotações: " }, { text: "cafe", b: true }, { text: "\u0301", i: true },
    { text: " 👩🏽‍💻 " }, { text: "東京", href: "#mapa" }, { text: "!" },
  ]);
  const text = blockText(original);
  const htmlBefore = serializeDocument([original]);
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    const caret = { block: 0, offset: end };
    const bySelection = editorWith([original]);
    bySelection.collapseTo(caret);
    wordKey(bySelection, "ArrowLeft", true);
    const start = bySelection.getSelection().focus.offset;
    bySelection.handleKeyDown({ key: "Delete", preventDefault() {} });

    const editor = editorWith([original]);
    editor.collapseTo(caret);
    wordKey(editor, "Backspace");
    assert.equal(blockText(editor.getDocument()[0]), text.slice(0, start) + text.slice(end));
    const htmlAfter = serializeDocument(editor.getDocument());
    assert.equal(htmlAfter, serializeDocument(bySelection.getDocument()));
    assert.deepEqual(editor.getSelection().focus, { block: 0, offset: start });
    editor.undo();
    assert.equal(serializeDocument(editor.getDocument()), htmlBefore);
    assert.deepEqual(editor.getSelection().focus, caret);
    editor.redo();
    assert.equal(serializeDocument(editor.getDocument()), htmlAfter);
  }
});
