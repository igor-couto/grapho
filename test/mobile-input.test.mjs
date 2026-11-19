import assert from "node:assert/strict";
import test from "node:test";
import { blockText, createBlock } from "../assets/doc/model.js";
import { editorWith, paragraph } from "./editor-fixture.mjs";

// Bind the same textarea listeners as the page, without a renderer or a
// physical keyboard. Node runs this test file in its own process.
globalThis.window = new EventTarget();
globalThis.ResizeObserver = class { observe() {} };

function boundEditor(blocks) {
  const editor = editorWith(blocks);
  editor.root.addEventListener = () => {};
  editor.textarea = Object.assign(new EventTarget(), { value: "", style: {} });
  editor.bind();
  return editor;
}

function inputEvent(type, inputType, options = {}) {
  return Object.assign(new Event(type, { cancelable: type === "beforeinput" }), { inputType }, options);
}

function nativeEdit(editor, inputType, value = "") {
  const target = editor.textarea;
  if (target.dispatchEvent(inputEvent("beforeinput", inputType))) {
    target.value = value;
    target.dispatchEvent(inputEvent("input", inputType));
  }
}

test("a virtual Backspace deletes the previous grapheme even when the textarea is empty", () => {
  const editor = boundEditor([paragraph("A🇵🇹B")]);
  editor.collapseTo({ block: 0, offset: "A🇵🇹".length });
  // An empty native textarea has no text to remove, so the browser need
  // not emit a subsequent input event.
  const before = inputEvent("beforeinput", "deleteContentBackward");
  editor.textarea.dispatchEvent(before);
  assert.equal(blockText(editor.getDocument()[0]), "AB");
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 1 });
  assert.equal(before.defaultPrevented, true);
  nativeEdit(editor, "historyUndo");
  assert.equal(blockText(editor.getDocument()[0]), "A🇵🇹B");
  nativeEdit(editor, "historyRedo");
  assert.equal(blockText(editor.getDocument()[0]), "AB");
});

test("virtual forward delete replaces a backwards selection, and native undo restores its direction and marks", () => {
  const blocks = [createBlock("p", [{ text: "draft", b: true }]), paragraph("again")];
  const editor = boundEditor(blocks);
  editor.setSelection({ block: 1, offset: 2 }, { block: 0, offset: 3 });
  const originalSelection = editor.getSelection();
  nativeEdit(editor, "deleteContentForward");
  assert.deepEqual(editor.getDocument().map(blockText), ["draain"]);
  nativeEdit(editor, "historyUndo");
  assert.deepEqual(editor.getDocument(), blocks);
  assert.deepEqual(editor.getSelection(), originalSelection);
});

test("word deletion from a virtual keyboard preserves preceding formatted text", () => {
  const editor = boundEditor([createBlock("p", [{ text: "One ", b: true }, { text: "café" }])]);
  editor.collapseTo({ block: 0, offset: 8 });
  nativeEdit(editor, "deleteWordBackward");
  assert.deepEqual(editor.getDocument()[0].runs, [{ text: "One ", b: true }]);
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 4 });
});

for (const inputType of ["insertLineBreak", "insertParagraph"]) {
  test("a virtual Return reported as " + inputType + " ends a heading and starts ordinary prose", () => {
    const editor = boundEditor([createBlock("h2", [{ text: "TitleBody" }])]);
    editor.collapseTo({ block: 0, offset: 5 });
    nativeEdit(editor, inputType, "\n");
    assert.deepEqual(editor.getDocument().map((block) => [block.type, blockText(block)]),
      [["h2", "Title"], ["p", "Body"]]);
    assert.deepEqual(editor.getSelection().focus, { block: 1, offset: 0 });
    nativeEdit(editor, "historyUndo");
    assert.deepEqual(editor.getDocument().map(blockText), ["TitleBody"]);
  });
}

test("an input-only virtual Return exits an empty list without inserting a second blank paragraph", () => {
  const editor = boundEditor([createBlock("list", [])]);
  editor.textarea.value = "\n";
  editor.textarea.dispatchEvent(inputEvent("input", "insertLineBreak"));
  assert.deepEqual(editor.getDocument().map((block) => [block.type, blockText(block)]), [["p", ""]]);
  assert.equal(editor.textarea.value, "");
  nativeEdit(editor, "insertText", "After the list");
  assert.deepEqual(editor.getDocument().map(blockText), ["After the list"]);
});

test("a noncancelable delete followed by input removes exactly one character", () => {
  const editor = boundEditor([paragraph("aébc")]);
  editor.collapseTo({ block: 0, offset: 2 });
  const before = Object.assign(new Event("beforeinput"), { inputType: "deleteContentBackward" });
  editor.textarea.dispatchEvent(before);
  editor.textarea.dispatchEvent(inputEvent("input", "deleteContentBackward"));
  assert.deepEqual(editor.getDocument().map(blockText), ["abc"]);
  assert.deepEqual(editor.getSelection().focus, { block: 0, offset: 1 });
  nativeEdit(editor, "historyUndo");
  assert.deepEqual(editor.getDocument().map(blockText), ["aébc"]);
});

test("a virtual Return inside code preserves the block and its following indentation", () => {
  const editor = boundEditor([createBlock("code", [{ text: "a();\treturn;" }])]);
  editor.collapseTo({ block: 0, offset: 4 });
  nativeEdit(editor, "insertLineBreak", "\n");
  assert.deepEqual(editor.getDocument().map((block) => [block.type, blockText(block)]),
    [["code", "a();\n\treturn;"]]);
  nativeEdit(editor, "historyUndo");
  assert.deepEqual(editor.getDocument().map(blockText), ["a();\treturn;"]);
});

test("deleting an IME candidate leaves the document untouched until the composition commits", () => {
  const editor = boundEditor([paragraph("A")]);
  editor.collapseTo({ block: 0, offset: 1 });
  editor.textarea.dispatchEvent(new Event("compositionstart"));
  const before = inputEvent("beforeinput", "deleteContentBackward", { isComposing: true });
  editor.textarea.dispatchEvent(before);
  assert.equal(before.defaultPrevented, false);
  editor.textarea.dispatchEvent(inputEvent("input", "deleteContentBackward", { isComposing: true }));
  assert.deepEqual(editor.getDocument().map(blockText), ["A"]);
  editor.textarea.dispatchEvent(Object.assign(new Event("compositionend"), { data: "語" }));
  assert.deepEqual(editor.getDocument().map(blockText), ["A語"]);
});
