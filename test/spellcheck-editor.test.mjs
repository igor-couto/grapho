import assert from "node:assert/strict";
import { test } from "node:test";
import { DocEditor } from "../assets/doc/input.js";
import { createBlock, serializeDocument } from "../assets/doc/model.js";
import { EditorView } from "../assets/doc/view.js";

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

test("saved spelling words clear existing marks across blocks and match case and apostrophes", () => {
  const view = new EditorView({ querySelector: () => null });
  const removed = [];
  const mark = (word) => ({ range: { word }, element: { remove: () => removed.push(word) } });
  view.views.set(0, { spelling: [mark("Grapho"), mark("Recieve")] });
  view.views.set(1, { spelling: [mark("GRAPHO"), mark("Grapho’s")] });

  view.addSpellingWords(["grapho", "grapho's"]);

  assert.deepEqual(removed, ["Grapho", "GRAPHO", "Grapho’s"]);
  assert.equal(view.views.get(0).spelling[0].range.word, "Recieve");
  assert.equal(view.views.get(1).spelling.length, 0);
});
