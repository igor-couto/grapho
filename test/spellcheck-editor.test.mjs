import assert from "node:assert/strict";
import { test } from "node:test";
import { DocEditor } from "../assets/doc/input.js";
import { createBlock, serializeDocument } from "../assets/doc/model.js";

test("a spelling correction is one undoable edit and preserves formatting", () => {
  const editor = new DocEditor({ root: { querySelector: () => null } });
  editor.relayout = () => {};
  editor.sync = () => {};
  editor.view.scrollCaretIntoView = () => {};
  const block = createBlock("p", [{ text: "We " }, { text: "rec", b: true }, { text: "ieve", i: true }, { text: " letters." }]);
  editor.blocks = [block];
  const misspelling = { start: 3, end: 10, word: "recieve" };

  assert.equal(editor.replaceMisspelling(0, block, misspelling, "receive"), true);
  assert.equal(serializeDocument(editor.getDocument()), "<p>We <b>rec</b><i>eive</i> letters.</p>");
  assert.equal(editor.replaceMisspelling(0, block, misspelling, "relieve"), false);
  editor.undo();
  assert.equal(editor.getDocument()[0], block);
  editor.redo();
  assert.equal(serializeDocument(editor.getDocument()), "<p>We <b>rec</b><i>eive</i> letters.</p>");
});
