import { DocEditor } from "../assets/doc/input.js";
import { createBlock } from "../assets/doc/model.js";

// Keep the real editing and history paths. Model tests don't need a painted page.
export function editorWith(blocks) {
  const editor = new DocEditor({ root: { querySelector: () => null }, textarea: { value: "" } });
  editor.relayout = () => {};
  editor.sync = () => {};
  editor.view.scrollCaretIntoView = () => {};
  editor.setDocument(blocks);
  return editor;
}

export function paragraph(text) {
  return createBlock("p", [{ text }]);
}
