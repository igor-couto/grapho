// Run with node --test test/writing-stress.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { blockText } from "../assets/doc/model.js";
import { editorWith, paragraph } from "./editor-fixture.mjs";

// The reference document is one array of visible characters. Paragraph breaks
// get their own token so a mistaken Enter for Shift+Enter is observable.
const paragraphBreak = "\u2029";
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const characters = (text) => Array.from(segmenter.segment(text), (part) => part.segment);
const typing = ["a", " ", "!", "é", "e\u0301", "字", "ש", "🇵🇹", "👩🏾‍💻"];
const pastes = ["  revise\t", "港\r\n\r\nfim", "\n🇧🇷\n", "café\rnotes", "שלום"];
const actions = [
  "type", "type", "type", "paste", "Enter", "Shift+Enter", "Backspace", "Delete",
  "ArrowLeft", "ArrowRight", "Shift+ArrowLeft", "Shift+ArrowRight", "place caret", "select",
];

function seededIndex(seed) {
  return (length) => {
    seed = (seed * 48271) % 2147483647;
    return Math.floor(seed * length / 2147483647);
  };
}

function positionAt(tokens, index) {
  const paragraphs = tokens.slice(0, index).join("").split(paragraphBreak);
  return { block: paragraphs.length - 1, offset: paragraphs.at(-1).length };
}

function expectedSelection(tokens, anchor, focus) {
  return { anchor: positionAt(tokens, anchor), focus: positionAt(tokens, focus), collapsed: anchor === focus };
}

function exerciseSession(paragraphs, seed) {
  const random = seededIndex(seed);
  const tokens = characters(paragraphs.join(paragraphBreak));
  const editor = editorWith(paragraphs.map(paragraph));

  let anchor = 0;
  let focus = 0;
  function replace(start, end, inserted) {
    tokens.splice(start, end - start, ...inserted);
    anchor = focus = start + inserted.length;
  }

  const trace = [];
  for (let step = 0; step < 512; step += 1) {
    // Enter always opens its own undo step. Revisit the state on both sides
    // after a varied run of edits, without relying on real-time typing groups.
    const checkHistory = (step + 1) % 64 === 0;
    const action = checkHistory ? "Enter" : actions[random(actions.length)];
    const before = checkHistory ? tokens.join("").split(paragraphBreak) : null;
    const beforeSelection = checkHistory ? expectedSelection(tokens, anchor, focus) : null;
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    const context = `seed ${seed}, step ${step + 1}, ${action} at ${anchor}→${focus}`;
    trace.push(context);
    if (trace.length > 6) trace.shift();
    const message = trace.join("\n");
    switch (action) {
      case "place caret":
      case "select":
        anchor = random(tokens.length + 1);
        focus = action === "select" ? random(tokens.length + 1) : anchor;
        editor.setSelection(positionAt(tokens, anchor), positionAt(tokens, focus));
        break;
      case "type": {
        const text = typing[random(typing.length)];
        editor.textarea.value = text;
        editor.handleInput();
        assert.equal(editor.textarea.value, "", message);
        replace(start, end, [text]);
        break;
      }
      case "paste": {
        const text = pastes[random(pastes.length)];
        editor.handlePaste({
          clipboardData: { getData: (format) => format === "text/plain" ? text : "" },
          preventDefault() {},
        });
        replace(start, end, characters(text.replace(/\r\n?|\n/g, paragraphBreak)));
        break;
      }
      default: {
        const key = action.replace("Shift+", "");
        const shiftKey = action.startsWith("Shift+");
        editor.handleKeyDown({ key, shiftKey, preventDefault() {} });
        if (key === "Enter") {
          replace(start, end, [shiftKey ? "\n" : paragraphBreak]);
        } else if (key === "Backspace") {
          replace(start === end ? Math.max(0, start - 1) : start, end, []);
        } else if (key === "Delete") {
          replace(start, start === end ? Math.min(tokens.length, end + 1) : end, []);
        } else {
          const left = key === "ArrowLeft";
          if (!shiftKey && start !== end) {
            focus = left ? start : end;
          } else {
            focus = Math.max(0, Math.min(tokens.length, focus + (left ? -1 : 1)));
          }
          if (!shiftKey) anchor = focus;
        }
      }
    }
    const after = tokens.join("").split(paragraphBreak);
    const afterSelection = expectedSelection(tokens, anchor, focus);
    assert.deepEqual(editor.getDocument().map(blockText), after, message);
    assert.deepEqual(editor.getSelection(), afterSelection, message);
    const selection = tokens.slice(Math.min(anchor, focus), Math.max(anchor, focus)).join("");
    assert.equal(editor.selectionText(), selection.replaceAll(paragraphBreak, "\n"), message);
    if (checkHistory) {
      editor.handleKeyDown({ key: "z", ctrlKey: true, preventDefault() {} });
      assert.deepEqual(editor.getDocument().map(blockText), before, message);
      assert.deepEqual(editor.getSelection(), beforeSelection, message);
      editor.handleKeyDown({ key: "z", ctrlKey: true, shiftKey: true, preventDefault() {} });
      assert.deepEqual(editor.getDocument().map(blockText), after, message);
      assert.deepEqual(editor.getSelection(), afterSelection, message);
    }
  }
}

const initialDrafts = [
  ["blank document", [""]],
  ["blank lines and hard breaks", ["", "line one\nline two\n", "", "", "end"]],
  ["multilingual draft", ["Café e\u0301 🇧🇷", "שבת שלום", "港の朝 👩🏾‍💻"]],
  ["long draft", Array.from({ length: 64 }, (_, i) => `Paragraph ${i + 1}. The next line.\nMore words.`)],
];

for (const [name, paragraphs] of initialDrafts) {
  test("writing, selecting, and undoing match a plain-text reference (" + name + ")", () => {
    for (const seed of [17, 643, 11239, 207829]) exerciseSession(paragraphs, seed);
  });
}
