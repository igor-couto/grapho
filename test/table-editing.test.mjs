import assert from "node:assert/strict";
import test from "node:test";
import { blockText, emptyTable, serializeDocument, tableCellRanges } from "../assets/doc/model.js";
import { editorWith, paragraph } from "./editor-fixture.mjs";

test("typing over a backward selection across table rows is one undoable edit", () => {
  const table = emptyTable(2, 1);
  table.rows = [
    [[{ text: "Name" }], [{ text: "Status" }]],
    [[{ text: "Cedar", i: true }], [{ text: "Ready", href: "#ready" }]],
  ];
  const editor = editorWith([table]);
  const original = serializeDocument(editor.getDocument());
  const [name, , cedar] = tableCellRanges(table);
  editor.setSelection({ block: 0, offset: cedar.start + 2 }, { block: 0, offset: name.start + 2 });
  const selection = editor.getSelection();
  editor.textarea.value = "!";
  editor.handleInput();

  const updated = serializeDocument(editor.getDocument());
  assert.equal(updated, '<table><thead><tr><th>Na!</th><th></th></tr></thead>' +
    '<tbody><tr><td><i>dar</i></td><td><a href="#ready">Ready</a></td></tr></tbody></table>');
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 3 });
  editor.undo();
  assert.equal(serializeDocument(editor.getDocument()), original);
  assert.deepEqual(editor.getSelection(), selection);
  editor.redo();
  assert.equal(serializeDocument(editor.getDocument()), updated);
});

test("Backspace and Delete remove whole graphemes at opposite edges of a table cell", () => {
  const table = emptyTable(2, 1);
  const emoji = "👩🏽‍💻";
  const accent = "e\u0301";
  table.rows[1] = [[{ text: "First" }], [{ text: emoji + "x" + accent }]];
  const editor = editorWith([table]);
  const last = tableCellRanges(table).at(-1);
  const press = key => editor.handleKeyDown({ key, preventDefault() {} });
  editor.collapseTo({ block: 0, offset: last.end });
  press("Backspace");
  assert.equal(blockText(editor.getDocument()[0]), "\t\nFirst\t" + emoji + "x");
  assert.equal(editor.getSelection().focus.offset, last.end - accent.length);
  editor.collapseTo({ block: 0, offset: last.start });
  press("Delete");
  assert.equal(blockText(editor.getDocument()[0]), "\t\nFirst\tx");
  assert.equal(editor.getSelection().focus.offset, last.start);
  editor.undo();
  editor.undo();
  assert.equal(blockText(editor.getDocument()[0]), blockText(table));
});

test("undoing deletion of the last table column restores its formatting and caret", () => {
  const table = emptyTable(1, 1);
  table.rows[0][0] = [{ text: "Notes" }];
  table.rows[1][0] = [{ text: "First\nSecond", b: true }];
  const editor = editorWith([paragraph("Before"), table, paragraph("After")]);
  const original = serializeDocument(editor.getDocument());
  const position = { block: 1, offset: tableCellRanges(table)[1].start + 3 };
  editor.collapseTo(position);
  editor.tableDeleteColumnAtCaret();
  const empty = "<p>Before</p><p></p><p>After</p>";
  assert.equal(serializeDocument(editor.getDocument()), empty);
  assert.deepEqual(editor.getSelection().focus, { block: 1, offset: 0 });
  editor.undo();
  assert.equal(serializeDocument(editor.getDocument()), original);
  assert.deepEqual(editor.getSelection().focus, position);
  editor.redo();
  assert.equal(serializeDocument(editor.getDocument()), empty);
});
