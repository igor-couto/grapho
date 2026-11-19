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
        editor.collapseTo(start);
        wordKey(editor, key);
        const end = editor.getSelection().focus;
        const label = JSON.stringify({ text, offset, key });
        assert.equal(end.block, 0, label);
        assert.ok(offsets.has(end.offset), label);
        if (key === "ArrowLeft" && offset > 0) assert.ok(end.offset < offset, label);
        if (key === "ArrowRight" && offset < text.length) assert.ok(end.offset > offset, label);

        editor.collapseTo(start);
        wordKey(editor, key, true);
        assert.deepEqual(editor.getSelection().anchor, start, label);
        assert.deepEqual(editor.getSelection().focus, end, label);
        assert.equal(editor.selectionText(), text.slice(Math.min(offset, end.offset), Math.max(offset, end.offset)), label);
      }
    }
    assert.equal(blockText(editor.getDocument()[0]), text);
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
