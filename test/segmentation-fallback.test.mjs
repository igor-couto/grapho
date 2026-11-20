import assert from "node:assert/strict";
import test from "node:test";
import { blockText } from "../assets/doc/model.js";
import { editorWith, paragraph } from "./editor-fixture.mjs";

// node:test isolates this file. Both editor segmenters are initialized by
// their first keyboard command while the native constructor is unavailable.
test("editing without Intl.Segmenter", async (t) => {
  t.mock.method(Intl, "Segmenter", function () { throw new TypeError("Segmenter unavailable"); });
  const press = (editor, key, ctrlKey = false) => editor.handleKeyDown({ key, ctrlKey, preventDefault() {} });

  await t.test("word movement and word deletion stop at the next or preceding word", () => {
    const text = "uma ação, cafe\u0301";
    const editor = editorWith([paragraph(text)]);
    press(editor, "ArrowRight", true);
    assert.equal(editor.getSelection().focus.offset, text.indexOf("ação"));
    press(editor, "ArrowRight", true);
    assert.equal(editor.getSelection().focus.offset, text.indexOf("cafe"));
    editor.collapseTo({ block: 0, offset: text.length });
    press(editor, "Backspace", true);
    assert.equal(blockText(editor.getDocument()[0]), "uma ação, ");
    editor.undo();
    assert.equal(blockText(editor.getDocument()[0]), text);
  });

  await t.test("arrow keys and deletion preserve whole accents, flags, and emoji", () => {
    for (const cluster of ["e\u0301", "👩🏽‍💻", "🇵🇹", "1️⃣", "क्ष"]) {
      const text = "L" + cluster + "R";
      const editor = editorWith([paragraph(text)]);
      editor.collapseTo({ block: 0, offset: 1 });
      press(editor, "ArrowRight");
      assert.equal(editor.getSelection().focus.offset, 1 + cluster.length, cluster);
      press(editor, "ArrowLeft");
      assert.equal(editor.getSelection().focus.offset, 1, cluster);
      press(editor, "Delete");
      assert.equal(blockText(editor.getDocument()[0]), "LR", cluster);
      editor.undo();
      editor.collapseTo({ block: 0, offset: 1 + cluster.length });
      press(editor, "Backspace");
      assert.equal(blockText(editor.getDocument()[0]), "LR", cluster);
    }
  });

  await t.test("deleting a line break keeps the caret out of the joined accented letter", () => {
    const editor = editorWith([paragraph("e\n\u0301")]);
    editor.collapseTo({ block: 0, offset: 1 });
    press(editor, "Delete");
    assert.equal(blockText(editor.getDocument()[0]), "e\u0301");
    assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 2 });
    press(editor, "Backspace");
    assert.equal(blockText(editor.getDocument()[0]), "");
  });

  await t.test("double-clicking inside a word includes all its accented characters", () => {
    const word = "revisa\u0303o";
    const editor = editorWith([paragraph("uma " + word + " final")]);
    editor.positionFromEvent = () => ({ block: 0, offset: 6 });
    editor.focusEditor = () => {};
    editor.handleDoubleClick({ preventDefault() {} });
    assert.equal(editor.selectionText(), word);
  });
});
