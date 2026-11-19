import assert from "node:assert/strict";
import test from "node:test";
import { createBlock, serializeDocument } from "../assets/doc/model.js";
import { editorWith, paragraph } from "./editor-fixture.mjs";

const at = (block, offset) => ({ block, offset });
const html = (editor) => serializeDocument(editor.getDocument());

function type(editor, text) {
  editor.textarea.value = text;
  editor.handleInput();
}

test("italicizing new words immediately before a link keeps them outside the link", () => {
  const editor = editorWith([createBlock("p", [{ text: "See " }, { text: "guide", href: "#guide" }])]);
  editor.collapseTo(at(0, 4));
  editor.toggleMark("i");
  type(editor, "the ");
  const expected = '<p>See <i>the </i><a href="#guide">guide</a></p>';
  assert.equal(html(editor), expected);
  editor.undo();
  assert.equal(html(editor), '<p>See <a href="#guide">guide</a></p>');
  editor.redo();
  assert.equal(html(editor), expected);
});

test("bold can be turned off at the boundary between bold and italic text", () => {
  const editor = editorWith([createBlock("p", [{ text: "Draft", b: true }, { text: "notes", i: true }])]);
  editor.collapseTo(at(0, 5));
  assert.equal(editor.activeMarks().b, true);
  editor.toggleMark("b");
  type(editor, " and ");
  assert.equal(html(editor), "<p><b>Draft</b> and <i>notes</i></p>");
});

test("a selection starting with a paragraph break reports the formatting of its first selected word", () => {
  const editor = editorWith([
    createBlock("p", [{ text: "Guide", i: true }]),
    createBlock("p", [{ text: "draft", b: true }]),
  ]);
  editor.setSelection(at(1, 5), at(0, 5));
  assert.equal(editor.activeMarks().b, true);
  assert.equal(editor.activeMarks().i, false);
  type(editor, " revisions");
  assert.equal(html(editor), "<p><i>Guide</i><b> revisions</b></p>");
});

test("undo restores the original selection without borrowing pending formatting from another paragraph", () => {
  const editor = editorWith([
    createBlock("p", [{ text: "First " }, { text: "draft", i: true }]),
    paragraph("Second paragraph"),
  ]);
  editor.setSelection(at(0, 11), at(0, 6));
  const selection = editor.getSelection();
  type(editor, "pass");
  editor.collapseTo(at(1, 0));
  editor.toggleMark("u");
  editor.undo();
  assert.deepEqual(editor.getSelection(), selection);
  type(editor, "revision");
  assert.equal(html(editor), "<p>First <i>revision</i></p><p>Second paragraph</p>");
  editor.redo();
  assert.equal(html(editor), "<p>First <i>revision</i></p><p>Second paragraph</p>");
});

test("undo returns to plain typing inside a link after the writer cleared formatting", () => {
  const editor = editorWith([createBlock("p", [{ text: "AB", b: true, href: "#old" }])]);
  editor.collapseTo(at(0, 1));
  editor.clearFormatting();
  type(editor, "one");
  editor.collapseTo(at(0, 0));
  editor.undo();
  assert.deepEqual(editor.getSelection().focus, at(0, 1));
  type(editor, "two");
  assert.equal(html(editor), '<p><a href="#old"><b>A</b></a>two<a href="#old"><b>B</b></a></p>');
});

test("redoing a link insertion keeps the following punctuation outside the label", () => {
  const editor = editorWith([paragraph("See ")]);
  editor.collapseTo(at(0, 4));
  editor.setLink("#notes", "notes");
  editor.undo();
  editor.collapseTo(at(0, 0));
  editor.redo();
  assert.deepEqual(editor.getSelection().focus, at(0, 9));
  type(editor, ".");
  assert.equal(html(editor), '<p>See <a href="#notes">notes</a>.</p>');
});

test("moving after undo adopts formatting at the new caret", () => {
  const editor = editorWith([paragraph("Draft"), createBlock("p", [{ text: "Status", b: true }])]);
  editor.collapseTo(at(0, 5));
  editor.toggleMark("i");
  type(editor, "!");
  editor.undo();
  editor.collapseTo(at(1, 6));
  type(editor, ":");
  assert.equal(html(editor), "<p>Draft</p><p><b>Status:</b></p>");
});

test("relinking backwards across two paragraphs preserves both original targets through history", () => {
  const editor = editorWith([
    createBlock("p", [{ text: "abc", b: true, href: "#one" }]),
    createBlock("p", [{ text: "xyz", i: true, href: "#two" }]),
  ]);
  editor.setSelection(at(1, 2), at(0, 1));
  const selection = editor.getSelection();
  const original = html(editor);
  const revised = '<p><a href="#one"><b>a</b></a><a href="#new"><b>bc</b></a></p>' +
    '<p><a href="#new"><i>xy</i></a><a href="#two"><i>z</i></a></p>';
  editor.setLink("#new");
  assert.equal(html(editor), revised);
  editor.undo();
  assert.equal(html(editor), original);
  assert.deepEqual(editor.getSelection(), selection);
  editor.redo();
  assert.equal(html(editor), revised);
  assert.deepEqual(editor.getSelection(), selection);
});
