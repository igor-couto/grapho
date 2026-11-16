// The editing engine: owns the block model, the selection, and the hidden
// textarea that receives typing, IME, and clipboard input. Every change goes
// through commit(), which keeps undo, layout, and painting in step.

import {
  ALIGNMENTS,
  blockAlignment,
  blockIndent,
  blockLength,
  blockText,
  createBlock,
  createBlockId,
  emptyParagraph,
  INDENT_LIMIT,
  marksAt,
  mergeBlocks,
  normalizeRuns,
  removeRangeFromRuns,
  runsInRange,
  setHrefOnRuns,
  setMarkOnRuns,
  splitBlock as splitBlockModel,
  splitRuns,
} from "./model.js";
import {
  blockEntry,
  caretPoint,
  contentTop,
  entryAtY,
  graphemeBoundaries,
  imageWidthFor,
  layoutDocument,
  lineAtY,
  pointToOffset,
} from "./layout.js";
import { EditorView } from "./view.js";

const LIST_DEPTH_LIMIT = 5;
const TYPING_COALESCE_MS = 700;
const UNDO_LIMIT = 120;
const ALIGNMENT_VALUES = new Set(ALIGNMENTS);

export class DocEditor {
  constructor({
    root,
    textarea,
    onChange,
    onSelection,
    onImageSelect,
    onImageDragStart,
    onSave,
    onLink,
    onPasteImages,
  }) {
    this.root = root;
    this.textarea = textarea;
    this.view = new EditorView(root);
    this.blocks = [emptyParagraph()];
    this.anchor = { block: 0, offset: 0 };
    this.focus = { block: 0, offset: 0 };
    this.pendingMarks = null;
    this.undoStack = [];
    this.redoStack = [];
    this.typing = null;
    this.composing = false;
    this.layout = null;
    this.width = 0;
    this.pointer = null;
    this.imageDrag = null;
    this.imageResize = null;
    this.focused = false;
    this.callbacks = {
      onChange,
      onSelection,
      onImageSelect,
      onImageDragStart,
      onSave,
      onLink,
      onPasteImages,
    };
    this.bound = false;
  }

  bind() {
    if (this.bound) {
      return;
    }
    this.bound = true;

    this.textarea.addEventListener("keydown", (event) => this.handleKeyDown(event));
    this.textarea.addEventListener("input", () => this.handleInput());
    this.textarea.addEventListener("compositionstart", () => this.handleCompositionStart());
    this.textarea.addEventListener("compositionupdate", (event) => this.handleCompositionUpdate(event));
    this.textarea.addEventListener("compositionend", (event) => this.handleCompositionEnd(event));
    this.textarea.addEventListener("copy", (event) => this.handleCopy(event, false));
    this.textarea.addEventListener("cut", (event) => this.handleCopy(event, true));
    this.textarea.addEventListener("paste", (event) => this.handlePaste(event));
    this.textarea.addEventListener("focus", () => {
      this.focused = true;
      this.sync();
    });
    this.textarea.addEventListener("blur", () => {
      this.focused = false;
      this.view.setCaret(null);
    });

    this.root.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    window.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    window.addEventListener("pointerup", () => this.handlePointerUp());
    window.addEventListener("pointercancel", () => {
      this.cancelImageDrag();
      this.cancelImageResize();
    });
    this.root.addEventListener("dblclick", (event) => this.handleDoubleClick(event));

    this.textarea.style.fontSize = "16px";

    const observer = new ResizeObserver(() => {
      const width = this.root.clientWidth;
      if (width && Math.abs(width - this.width) > 0.5) {
        this.width = width;
        this.relayout();
        this.sync();
      }
    });
    observer.observe(this.root);
  }

  /* ---------------------------------------------------------------------
     Document and selection state
     --------------------------------------------------------------------- */

  setDocument(blocks, selection) {
    this.blocks = blocks.length ? blocks : [emptyParagraph()];
    this.anchor = selection ? { ...selection.anchor } : { block: 0, offset: 0 };
    this.focus = selection ? { ...selection.focus } : { block: 0, offset: 0 };
    this.pendingMarks = null;
    this.undoStack = [];
    this.redoStack = [];
    this.typing = null;
    this.width = this.root.clientWidth || 640;
    this.relayout();
    this.sync();
  }

  getDocument() {
    return this.blocks;
  }

  entryFor(index) {
    return this.layout ? this.layout.blocks[index] : null;
  }

  getSelection() {
    return { anchor: { ...this.anchor }, focus: { ...this.focus }, collapsed: this.isCollapsed() };
  }

  linkAtCaret() {
    const block = this.blocks[this.focus.block];
    if (!block || block.type === "image" || block.type === "code") {
      return null;
    }
    let index = 0;
    for (const run of block.runs) {
      const end = index + run.text.length;
      if (run.href && this.focus.offset >= index && this.focus.offset <= end) {
        let from = index;
        let to = end;
        let cursor = 0;
        for (const other of block.runs) {
          const otherEnd = cursor + other.text.length;
          if (other.href === run.href && otherEnd >= from && cursor <= to) {
            from = Math.min(from, cursor);
            to = Math.max(to, otherEnd);
          }
          cursor = otherEnd;
        }
        return { href: run.href, from, to };
      }
      index = end;
    }
    return null;
  }

  removeLinkAtCaret() {
    const link = this.linkAtCaret();
    if (!link) {
      return false;
    }
    const index = this.focus.block;
    const block = this.blocks[index];
    const runs = setHrefOnRuns(block.runs, link.from, link.to, null);
    this.commit(this.replaceBlock(index, { ...block, id: createBlockId(), runs }), this.anchor, this.focus);
    return true;
  }

  updateImageBlock(index, changes) {
    const block = this.blocks[index];
    if (!block || block.type !== "image") {
      return;
    }
    const next = this.replaceBlock(index, { ...block, ...changes });
    this.commit(next, { block: index, offset: 0 }, { block: index, offset: 0 });
  }

  deleteBlockAt(index) {
    const next = this.blocks.slice();
    next.splice(index, 1);
    const caret = previousPosition(next, index);
    this.commit(next.length ? next : [emptyParagraph()], caret, caret);
  }

  isCollapsed() {
    return this.anchor.block === this.focus.block && this.anchor.offset === this.focus.offset;
  }

  normalized() {
    const a = this.anchor;
    const b = this.focus;
    if (a.block < b.block || (a.block === b.block && a.offset <= b.offset)) {
      return { from: a, to: b };
    }
    return { from: b, to: a };
  }

  setSelection(anchor, focus, options) {
    this.anchor = { ...anchor };
    this.focus = { ...focus };
    if (!(options && options.keepMarks)) {
      this.pendingMarks = null;
    }
    this.sync();
  }

  collapseTo(position) {
    this.setSelection(position, position);
  }

  focusEditor() {
    if (document.activeElement !== this.textarea) {
      this.textarea.focus({ preventScroll: true });
    }
    this.sync();
  }

  activeMarks() {
    if (this.pendingMarks) {
      return this.pendingMarks;
    }
    if (!this.isCollapsed()) {
      const { from } = this.normalized();
      const block = this.blocks[from.block];
      return block && block.type !== "image" ? marksAt(block, from.offset) : {};
    }
    const block = this.blocks[this.focus.block];
    return block && block.type !== "image" ? marksAt(block, this.focus.offset) : {};
  }

  activeBlockType() {
    const block = this.blocks[this.focus.block];
    if (!block) {
      return "p";
    }
    if (block.type === "list") {
      return "p";
    }
    return block.type;
  }

  activeAlignment() {
    const block = this.blocks[this.focus.block];
    return blockAlignment(block);
  }

  activeIndent() {
    const block = this.blocks[this.focus.block];
    return blockIndent(block);
  }

  /* ---------------------------------------------------------------------
     Layout and painting
     --------------------------------------------------------------------- */

  relayout() {
    const width = this.width || this.root.clientWidth || 640;
    this.layout = layoutDocument(this.blocks, width);
    this.view.setLayout(this.layout, this.blocks);
  }

  sync() {
    this.clampSelection();
    const collapsed = this.isCollapsed();
    const entry = this.layout ? blockEntry(this.layout, this.focus.block) : null;

    this.view.paintSelection(this.layout ? { anchor: this.anchor, focus: this.focus } : null);

    if (collapsed) {
      const point = this.caretGeometry();
      this.view.setCaret(this.focused ? point : null);
      this.positionInput();
    } else {
      this.view.setCaret(null);
      this.positionInputAtSelectionEnd();
    }

    if (this.callbacks.onSelection) {
      this.callbacks.onSelection({
        collapsed,
        marks: this.activeMarks(),
        blockType: this.activeBlockType(),
        alignment: this.activeAlignment(),
        indent: this.activeIndent(),
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
        image: collapsed && entry && entry.block.type === "image" ? entry : null,
      });
    }
  }

  clampSelection() {
    const clamp = (position) => {
      const index = Math.max(0, Math.min(this.blocks.length - 1, position.block));
      const block = this.blocks[index];
      const length = blockLength(block);
      return { block: index, offset: Math.max(0, Math.min(length, position.offset)) };
    };
    this.anchor = clamp(this.anchor);
    this.focus = clamp(this.focus);
  }

  caretGeometry() {
    if (!this.layout) {
      return null;
    }
    const entry = blockEntry(this.layout, this.focus.block);
    if (!entry) {
      return null;
    }
    if (entry.block.type === "image") {
      return null;
    }
    return caretPoint(entry, this.focus.offset);
  }

  positionInput() {
    const point = this.caretGeometry();
    if (!point) {
      this.textarea.style.left = "0px";
      this.textarea.style.top = "0px";
      return;
    }
    this.textarea.style.left = point.x + "px";
    this.textarea.style.top = point.y + "px";
    this.textarea.style.height = point.height + "px";
  }

  positionInputAtSelectionEnd() {
    const saved = this.focus;
    const entry = this.layout ? blockEntry(this.layout, saved.block) : null;
    const point = entry && entry.block.type !== "image" ? caretPoint(entry, saved.offset) : null;
    if (point) {
      this.textarea.style.left = point.x + "px";
      this.textarea.style.top = point.y + "px";
      this.textarea.style.height = point.height + "px";
    }
  }

  /* ---------------------------------------------------------------------
     Commit and undo
     --------------------------------------------------------------------- */

  commit(blocks, anchor, focus, options) {
    const settings = options || {};
    if (settings.undo !== false) {
      const coalesce = settings.coalesce && this.typing && Date.now() - this.typing.time < TYPING_COALESCE_MS;
      if (!coalesce) {
        this.undoStack.push({ blocks: this.blocks, anchor: this.anchor, focus: this.focus });
        if (this.undoStack.length > UNDO_LIMIT) {
          this.undoStack.shift();
        }
        this.redoStack = [];
      }
    }

    this.blocks = blocks;
    this.anchor = { ...anchor };
    this.focus = { ...focus };

    if (settings.coalesce) {
      this.typing = { time: Date.now() };
    } else {
      this.typing = null;
    }
    if (settings.keepMarks !== true) {
      this.pendingMarks = null;
    }

    this.relayout();
    this.sync();
    this.view.scrollCaretIntoView();
    if (this.callbacks.onChange) {
      this.callbacks.onChange(this.blocks);
    }
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) {
      return;
    }
    this.redoStack.push({ blocks: this.blocks, anchor: this.anchor, focus: this.focus });
    this.blocks = previous.blocks;
    this.anchor = { ...previous.anchor };
    this.focus = { ...previous.focus };
    this.typing = null;
    this.relayout();
    this.sync();
    this.emitChange();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }
    this.undoStack.push({ blocks: this.blocks, anchor: this.anchor, focus: this.focus });
    this.blocks = next.blocks;
    this.anchor = { ...next.anchor };
    this.focus = { ...next.focus };
    this.typing = null;
    this.relayout();
    this.sync();
    this.emitChange();
  }

  emitChange() {
    if (this.callbacks.onChange) {
      this.callbacks.onChange(this.blocks);
    }
  }

  replaceBlock(index, block) {
    const next = this.blocks.slice();
    next[index] = block;
    return next;
  }

  /* ---------------------------------------------------------------------
     Insertion and deletion
     --------------------------------------------------------------------- */

  insertText(text, overrideMarks) {
    if (!text) {
      return;
    }

    const parts = String(text).replace(/\r\n/g, "\n").split("\n");
    const marks = overrideMarks || this.pendingMarks || this.marksForTyping();

    this.deleteSelectionIfAny();

    let caret = { ...this.focus };
    let blocks = this.blocks;

    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        const split = this.splitAt(blocks, caret);
        blocks = split.blocks;
        caret = split.caret;
      }
      if (parts[index]) {
        const block = blocks[caret.block];
        const next = { ...block, id: createBlockId(), runs: insertRuns(block, caret.offset, parts[index], marks) };
        blocks = blocks.slice();
        blocks[caret.block] = next;
        caret = { block: caret.block, offset: caret.offset + parts[index].length };
      }
    }

    this.commit(blocks, caret, caret, { coalesce: true, keepMarks: true });
  }

  marksForTyping() {
    const block = this.blocks[this.focus.block];
    if (!block || block.type === "image") {
      return {};
    }
    if (block.type === "code") {
      return {};
    }
    const offset = this.focus.offset;
    if (offset > 0) {
      return marksAt(block, offset - 1);
    }
    return marksAt(block, 0);
  }

  splitAt(blocks, caret) {
    const block = blocks[caret.block];
    if (block.type === "image") {
      const paragraph = emptyParagraph();
      const next = blocks.slice();
      next.splice(caret.block + 1, 0, paragraph);
      return { blocks: next, caret: { block: caret.block + 1, offset: 0 } };
    }
    const [first, second] = splitBlockModel(block, caret.offset);
    const next = blocks.slice();
    next.splice(caret.block, 1, first, second);
    return { blocks: next, caret: { block: caret.block + 1, offset: 0 } };
  }

  deleteSelectionIfAny() {
    if (this.isCollapsed()) {
      return false;
    }
    const { from, to } = this.normalized();
    const first = this.blocks[from.block];
    const last = this.blocks[to.block];

    if (from.block === to.block) {
      if (first.type === "image") {
        const next = this.blocks.slice();
        next.splice(from.block, 1);
        const caret = previousPosition(next, from.block);
        this.commit(next.length ? next : [emptyParagraph()], caret, caret);
        return true;
      }
      const block = { ...first, id: createBlockId(), runs: removeRangeFromRuns(first.runs, from.offset, to.offset) };
      this.commit(this.replaceBlock(from.block, block), from, from);
      return true;
    }

    const headLength = from.offset;
    const headRuns = first.type === "image" ? [] : runsInRange(first, 0, from.offset);
    const tailRuns = last.type === "image" ? [] : runsInRange(last, to.offset, blockLength(last));
    const base = first.type === "image" ? last : first;
    const mergedRuns = normalizeRuns([...headRuns, ...tailRuns]);
    const merged = {
      ...base,
      id: createBlockId(),
      runs: mergedRuns,
      type: base.type === "code" ? "code" : base.type,
    };
    const next = this.blocks.slice();
    next.splice(from.block, to.block - from.block + 1, merged);
    const caret = { block: from.block, offset: headLength };
    this.commit(next, caret, caret);
    return true;
  }

  backspace() {
    if (this.deleteSelectionIfAny()) {
      return;
    }

    const position = this.focus;
    const block = this.blocks[position.block];
    if (!block) {
      return;
    }

    if (block.type === "image") {
      this.deleteBlockAt(position.block);
      return;
    }

    if (position.offset > 0) {
      const boundaries = graphemeBoundaries(blockText(block));
      const previous = previousBoundary(boundaries, position.offset);
      const runs = removeRangeFromRuns(block.runs, previous, position.offset);
      const next = { ...block, id: createBlockId(), runs };
      const caret = { block: position.block, offset: previous };
      this.commit(this.replaceBlock(position.block, next), caret, caret);
      return;
    }

    if (block.type === "list" && position.offset === 0) {
      const empty = blockText(block).trim() === "";
      if (block.depth > 0) {
        const next = { ...block, id: createBlockId(), depth: block.depth - 1 };
        this.commit(this.replaceBlock(position.block, next), position, position);
        return;
      }
      if (empty) {
        const next = { ...block, id: createBlockId(), type: "p", ordered: false, depth: 0 };
        this.commit(this.replaceBlock(position.block, next), position, position);
        return;
      }
    }

    if (position.block === 0) {
      return;
    }

    const previousIndex = position.block - 1;
    const previousBlock = this.blocks[previousIndex];

    if (previousBlock.type === "image") {
      const next = this.blocks.slice();
      next.splice(previousIndex, 1);
      const caret = { block: previousIndex, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    if (block.type === "image") {
      const next = this.blocks.slice();
      next.splice(position.block, 1);
      const caret = { block: Math.max(0, position.block - 1), offset: 0 };
      this.commit(next.length ? next : [emptyParagraph()], caret, caret);
      return;
    }

    const merged = mergeBlocks(previousBlock, block);
    const caret = { block: previousIndex, offset: blockLength(previousBlock) };
    const next = this.blocks.slice();
    next.splice(previousIndex, 2, merged);
    this.commit(next, caret, caret);
  }

  deleteForward() {
    if (this.deleteSelectionIfAny()) {
      return;
    }

    const position = this.focus;
    const block = this.blocks[position.block];
    if (!block) {
      return;
    }

    if (block.type === "image") {
      this.deleteBlockAt(position.block);
      return;
    }

    if (position.offset < blockLength(block)) {
      const boundaries = graphemeBoundaries(blockText(block));
      const nextBoundary = nextBoundaryAfter(boundaries, position.offset);
      const runs = removeRangeFromRuns(block.runs, position.offset, nextBoundary);
      const next = { ...block, id: createBlockId(), runs };
      this.commit(this.replaceBlock(position.block, next), position, position);
      return;
    }

    if (position.block >= this.blocks.length - 1) {
      return;
    }

    const nextBlock = this.blocks[position.block + 1];
    if (nextBlock.type === "image") {
      const next = this.blocks.slice();
      next.splice(position.block + 1, 1);
      this.commit(next.length ? next : [emptyParagraph()], position, position);
      return;
    }

    if (block.type === "image") {
      const next = this.blocks.slice();
      next.splice(position.block, 1);
      const caret = { block: Math.max(0, position.block - 1), offset: 0 };
      this.commit(next.length ? next : [emptyParagraph()], caret, caret);
      return;
    }

    const merged = mergeBlocks(block, nextBlock);
    const next = this.blocks.slice();
    next.splice(position.block, 2, merged);
    this.commit(next, position, position);
  }

  insertParagraph() {
    this.deleteSelectionIfAny();
    const index = this.focus.block;
    const block = this.blocks[index];
    if (!block) {
      return;
    }

    if (block.type === "image") {
      const paragraph = emptyParagraph();
      const next = this.blocks.slice();
      next.splice(index + 1, 0, paragraph);
      const caret = { block: index + 1, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    if (block.type === "code") {
      const runs = insertRuns(block, this.focus.offset, "\n", {});
      const next = { ...block, id: createBlockId(), runs };
      const caret = { block: index, offset: this.focus.offset + 1 };
      this.commit(this.replaceBlock(index, next), caret, caret);
      return;
    }

    if (block.type === "list") {
      if (blockLength(block) === 0) {
        if (block.depth > 0) {
          const next = { ...block, id: createBlockId(), depth: block.depth - 1 };
          this.commit(this.replaceBlock(index, next), this.focus, this.focus);
          return;
        }
        const paragraph = emptyParagraph();
        this.commit(this.replaceBlock(index, paragraph), this.focus, this.focus);
        return;
      }
      const [first, second] = splitBlockModel(block, this.focus.offset);
      const next = this.blocks.slice();
      next.splice(index, 1, first, second);
      const caret = { block: index + 1, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    const [first, second] = splitBlockModel(block, this.focus.offset);
    const next = this.blocks.slice();
    next.splice(index, 1, first, second);
    const caret = { block: index + 1, offset: 0 };
    this.commit(next, caret, caret);
  }

  /* ---------------------------------------------------------------------
     Formatting commands
     --------------------------------------------------------------------- */

  toggleMark(key) {
    const collapsed = this.isCollapsed();
    const current = this.activeMarks();
    const nextValue = !current[key];

    if (collapsed) {
      this.pendingMarks = { ...current, [key]: nextValue };
      this.sync();
      return;
    }

    const { from, to } = this.normalized();
    const all = selectionHasMark(this.blocks, from, to, key);
    const value = all ? false : true;
    let blocks = this.blocks;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type === "image" || block.type === "code") {
        continue;
      }
      const start = index === from.block ? from.offset : 0;
      const end = index === to.block ? to.offset : blockLength(block);
      blocks = blocks.slice();
      blocks[index] = { ...block, id: createBlockId(), runs: setMarkOnRuns(block.runs, start, end, key, value) };
    }

    this.commit(blocks, this.anchor, this.focus);
  }

  setBlockType(type) {
    const { from, to } = this.normalized();
    let blocks = this.blocks;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type === "image") {
        continue;
      }
      blocks = blocks.slice();
      if (type === "code") {
        blocks[index] = {
          ...block,
          id: createBlockId(),
          type: "code",
          runs: [{ text: blockText(block) }],
        };
      } else {
        blocks[index] = {
          ...block,
          id: createBlockId(),
          type,
          ordered: false,
          depth: 0,
        };
      }
    }

    this.commit(blocks, this.anchor, this.focus);
  }

  toggleList(ordered) {
    const { from, to } = this.normalized();
    const indices = [];
    for (let index = from.block; index <= to.block; index += 1) {
      if (this.blocks[index] && this.blocks[index].type !== "image") {
        indices.push(index);
      }
    }
    if (!indices.length) {
      return;
    }

    const allLists = indices.every((index) => this.blocks[index].type === "list");
    const sameKind = indices.every((index) => this.blocks[index].type === "list" && Boolean(this.blocks[index].ordered) === ordered);
    let blocks = this.blocks;

    for (const index of indices) {
      const block = blocks[index];
      blocks = blocks.slice();
      if (allLists && sameKind) {
        blocks[index] = { ...block, id: createBlockId(), type: "p", ordered: false, depth: 0 };
      } else {
        blocks[index] = { ...block, id: createBlockId(), type: "list", ordered, depth: block.type === "list" ? block.depth : 0 };
      }
    }

    this.commit(blocks, this.anchor, this.focus);
  }

  indentList(direction) {
    const { from, to } = this.normalized();
    let blocks = this.blocks;
    let changed = false;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type !== "list") {
        continue;
      }
      const depth = block.depth + direction;
      blocks = blocks.slice();
      if (depth < 0) {
        blocks[index] = { ...block, id: createBlockId(), type: "p", ordered: false, depth: 0 };
      } else {
        blocks[index] = { ...block, id: createBlockId(), depth: Math.min(depth, LIST_DEPTH_LIMIT) };
      }
      changed = true;
    }

    if (changed) {
      this.commit(blocks, this.anchor, this.focus);
    }
  }

  setAlignment(align) {
    if (!ALIGNMENT_VALUES.has(align)) {
      return;
    }
    const { from, to } = this.normalized();
    let blocks = this.blocks;
    let changed = false;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type === "image" || block.type === "code") {
        continue;
      }
      if (blockAlignment(block) === align) {
        continue;
      }
      const next = { ...block, id: createBlockId() };
      if (align === "left") {
        delete next.align;
      } else {
        next.align = align;
      }
      blocks = blocks.slice();
      blocks[index] = next;
      changed = true;
    }

    if (changed) {
      this.commit(blocks, this.anchor, this.focus);
    }
  }

  changeIndent(direction) {
    const step = direction < 0 ? -1 : 1;
    const { from, to } = this.normalized();
    let blocks = this.blocks;
    let changed = false;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type === "image" || block.type === "code") {
        continue;
      }
      const current = blockIndent(block);
      const indent = Math.max(0, Math.min(INDENT_LIMIT, current + step));
      if (indent === current) {
        continue;
      }
      const next = { ...block, id: createBlockId() };
      if (indent === 0) {
        delete next.indent;
      } else {
        next.indent = indent;
      }
      blocks = blocks.slice();
      blocks[index] = next;
      changed = true;
    }

    if (changed) {
      this.commit(blocks, this.anchor, this.focus);
    }
  }

  indentForTab(direction) {
    const { from, to } = this.normalized();
    let eligible = 0;
    let allLists = true;
    let indented = false;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = this.blocks[index];
      if (!block || block.type === "image" || block.type === "code") {
        continue;
      }
      eligible += 1;
      if (block.type !== "list") {
        allLists = false;
      }
      if (blockIndent(block) > 0) {
        indented = true;
      }
    }

    if (!eligible) {
      return;
    }
    if (allLists && !(direction < 0 && indented)) {
      this.indentList(direction);
    } else {
      this.changeIndent(direction);
    }
  }

  setLink(href) {
    const { from, to } = this.normalized();
    if (from.block === to.block && from.offset === to.offset) {
      this.pendingMarks = { ...this.activeMarks(), href: href || "" };
      this.sync();
      return;
    }

    let blocks = this.blocks;
    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type === "image" || block.type === "code") {
        continue;
      }
      const start = index === from.block ? from.offset : 0;
      const end = index === to.block ? to.offset : blockLength(block);
      blocks = blocks.slice();
      blocks[index] = { ...block, id: createBlockId(), runs: setHrefOnRuns(block.runs, start, end, href) };
    }
    this.commit(blocks, this.anchor, this.focus);
  }

  clearFormatting() {
    if (this.isCollapsed()) {
      this.pendingMarks = {};
      this.sync();
      return;
    }
    const { from, to } = this.normalized();
    let blocks = this.blocks;
    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || block.type === "image" || block.type === "code") {
        continue;
      }
      const start = index === from.block ? from.offset : 0;
      const end = index === to.block ? to.offset : blockLength(block);
      const runs = runsInRange(block, start, end).map((run) => ({ text: run.text }));
      const before = runsInRange(block, 0, start);
      const after = runsInRange(block, end, blockLength(block));
      blocks = blocks.slice();
      blocks[index] = { ...block, id: createBlockId(), runs: normalizeRuns([...before, ...runs, ...after]) };
    }
    this.commit(blocks, this.anchor, this.focus);
  }

  insertImage(block) {
    this.deleteSelectionIfAny();
    const index = this.focus.block;
    const current = this.blocks[index];

    if (!current || current.type === "image") {
      const next = this.blocks.slice();
      next.splice(index + 1, 0, { ...block, id: createBlockId() });
      const paragraph = emptyParagraph();
      next.splice(index + 2, 0, paragraph);
      const caret = { block: index + 2, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    const [head, tail] = splitBlockModel(current, this.focus.offset);
    const next = this.blocks.slice();
    const replacement = [];
    if (blockLength(head) > 0 || current.type !== "p") {
      replacement.push(head);
    }
    const imageIndex = index + replacement.length;
    replacement.push({ ...block, id: createBlockId() });
    const tailIndex = imageIndex + 1;
    replacement.push(tail);
    next.splice(index, 1, ...replacement);

    const caret = { block: tailIndex, offset: 0 };
    this.commit(next, caret, caret);
  }

  selectAll() {
    const last = this.blocks.length - 1;
    this.setSelection({ block: 0, offset: 0 }, { block: last, offset: blockLength(this.blocks[last]) });
  }

  /* ---------------------------------------------------------------------
     Keyboard
     --------------------------------------------------------------------- */

  handleKeyDown(event) {
    if (this.imageResize) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelImageResize();
      }
      return;
    }
    if (this.imageDrag) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelImageDrag();
      }
      return;
    }
    if (event.isComposing) {
      return;
    }

    const selected = this.isCollapsed() ? this.blocks[this.focus.block] : null;
    if (selected && selected.type === "image" && event.key.startsWith("Arrow")) {
      event.preventDefault();
      this.nudgeImage(event.key, event.shiftKey ? 24 : 4);
      return;
    }

    const key = event.key;
    const command = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    const alt = event.altKey;

    if (command) {
      const lower = key.toLowerCase();
      if (lower === "b" || lower === "i" || lower === "u") {
        event.preventDefault();
        this.toggleMark(lower === "b" ? "b" : lower === "i" ? "i" : "u");
        return;
      }
      if (lower === "z") {
        event.preventDefault();
        if (shift) {
          this.redo();
        } else {
          this.undo();
        }
        return;
      }
      if (lower === "y") {
        event.preventDefault();
        this.redo();
        return;
      }
      if (lower === "a") {
        event.preventDefault();
        this.selectAll();
        return;
      }
      if (lower === "s") {
        event.preventDefault();
        if (this.callbacks.onSave) {
          this.callbacks.onSave();
        }
        return;
      }
      if (lower === "k") {
        event.preventDefault();
        if (this.callbacks.onLink) {
          this.callbacks.onLink();
        }
        return;
      }
      if (key === "Home" || key === "End") {
        event.preventDefault();
        this.moveToDocumentEdge(key === "Home");
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        this.moveWord(key === "ArrowLeft" ? -1 : 1, shift);
        return;
      }
      if (key === "Backspace") {
        event.preventDefault();
        this.deleteWordBackward();
        return;
      }
    }

    switch (key) {
      case "Enter":
        event.preventDefault();
        if (shift) {
          this.insertHardBreak();
        } else {
          this.insertParagraph();
        }
        return;
      case "Backspace":
        event.preventDefault();
        this.backspace();
        return;
      case "Delete":
        event.preventDefault();
        this.deleteForward();
        return;
      case "ArrowLeft":
        event.preventDefault();
        this.moveHorizontal(-1, shift);
        return;
      case "ArrowRight":
        event.preventDefault();
        this.moveHorizontal(1, shift);
        return;
      case "ArrowUp":
        event.preventDefault();
        this.moveVertical(-1, shift);
        return;
      case "ArrowDown":
        event.preventDefault();
        this.moveVertical(1, shift);
        return;
      case "Home":
        event.preventDefault();
        this.moveToLineEdge(false, shift);
        return;
      case "End":
        event.preventDefault();
        this.moveToLineEdge(true, shift);
        return;
      case "Tab":
        event.preventDefault();
        this.indentForTab(shift ? -1 : 1);
        return;
      case "Escape":
        if (!this.isCollapsed()) {
          event.preventDefault();
          this.collapseTo(this.focus);
        }
        return;
      default:
        break;
    }

    if (!alt && !command && event.key.length === 1) {
      // Printable input arrives through the textarea's input event.
      this.pendingMarks = this.pendingMarks || null;
    }
  }

  insertHardBreak() {
    this.deleteSelectionIfAny();
    const index = this.focus.block;
    const block = this.blocks[index];
    if (!block || block.type === "image") {
      return;
    }
    const marks = this.pendingMarks || this.marksForTyping();
    const runs = insertRuns(block, this.focus.offset, "\n", marks);
    const next = { ...block, id: createBlockId(), runs };
    const caret = { block: index, offset: this.focus.offset + 1 };
    this.commit(this.replaceBlock(index, next), caret, caret);
  }

  moveHorizontal(direction, extend) {
    if (!extend && !this.isCollapsed()) {
      const { from, to } = this.normalized();
      this.collapseTo(direction < 0 ? from : to);
      this.afterMove();
      return;
    }

    const next = stepPosition(this.blocks, this.focus, direction);
    if (extend) {
      this.setSelection(this.anchor, next, { keepMarks: true });
    } else {
      this.collapseTo(next);
    }
    this.afterMove();
  }

  moveWord(direction, extend) {
    const from = extend ? this.focus : this.normalized().from;
    const next = stepWord(this.blocks, from, direction);
    if (extend) {
      this.setSelection(this.anchor, next, { keepMarks: true });
    } else {
      this.collapseTo(next);
    }
    this.afterMove();
  }

  moveVertical(direction, extend) {
    if (!this.layout) {
      return;
    }
    const entry = blockEntry(this.layout, this.focus.block);
    if (!entry) {
      return;
    }

    const point = caretPoint(entry, this.focus.offset);
    const x = point ? point.x : 0;
    const line = point ? point.line : entry.lines[0];
    const lineIndex = entry.lines.indexOf(line);
    let targetEntry = entry;
    let targetLine = null;

    if (lineIndex >= 0) {
      targetLine = entry.lines[lineIndex + direction] || null;
    }
    if (!targetLine) {
      let cursor = entry.index + direction;
      while (cursor >= 0 && cursor < this.layout.blocks.length) {
        const candidate = this.layout.blocks[cursor];
        if (candidate.block.type !== "image" && candidate.lines.length) {
          targetEntry = candidate;
          targetLine = direction < 0 ? candidate.lines[candidate.lines.length - 1] : candidate.lines[0];
          break;
        }
        cursor += direction;
      }
    }

    if (!targetLine) {
      if (direction < 0) {
        this.collapseTo({ block: 0, offset: 0 });
      } else {
        const last = this.blocks.length - 1;
        this.collapseTo({ block: last, offset: blockLength(this.blocks[last]) });
      }
      this.afterMove();
      return;
    }

    const offset = pointToOffset(targetEntry, x, targetLine.y + 1);
    const next = { block: targetEntry.index, offset };
    if (extend) {
      this.setSelection(this.anchor, next, { keepMarks: true });
    } else {
      this.collapseTo(next);
    }
    this.afterMove();
  }

  moveToLineEdge(toEnd, extend) {
    if (!this.layout) {
      return;
    }
    const entry = blockEntry(this.layout, this.focus.block);
    const point = caretPoint(entry, this.focus.offset);
    if (!entry || !point) {
      return;
    }
    const line = point.line;
    let offset = 0;
    if (line.fragments.length) {
      offset = toEnd ? line.fragments[line.fragments.length - 1].end : line.fragments[0].start;
    }
    const next = { block: entry.index, offset };
    if (extend) {
      this.setSelection(this.anchor, next, { keepMarks: true });
    } else {
      this.collapseTo(next);
    }
    this.afterMove();
  }

  moveToDocumentEdge(toStart) {
    if (toStart) {
      this.collapseTo({ block: 0, offset: 0 });
    } else {
      const last = this.blocks.length - 1;
      this.collapseTo({ block: last, offset: blockLength(this.blocks[last]) });
    }
    this.afterMove();
  }

  deleteWordBackward() {
    if (this.deleteSelectionIfAny()) {
      return;
    }
    const position = this.focus;
    const block = this.blocks[position.block];
    if (!block || block.type === "image" || position.offset === 0) {
      this.backspace();
      return;
    }
    const boundaries = wordBoundaries(blockText(block));
    const previous = previousBoundary(boundaries, position.offset);
    const runs = removeRangeFromRuns(block.runs, previous, position.offset);
    const next = { ...block, id: createBlockId(), runs };
    const caret = { block: position.block, offset: previous };
    this.commit(this.replaceBlock(position.block, next), caret, caret);
  }

  afterMove() {
    this.typing = null;
    this.view.scrollCaretIntoView();
  }

  /* ---------------------------------------------------------------------
     Input events
     --------------------------------------------------------------------- */

  handleInput() {
    if (this.composing) {
      return;
    }
    const value = this.textarea.value;
    this.textarea.value = "";
    if (!value) {
      return;
    }
    this.insertText(value);
  }

  handleCompositionStart() {
    this.composing = true;
    const point = this.caretGeometry();
    if (point) {
      this.view.setComposition(point, "");
    }
  }

  handleCompositionUpdate(event) {
    const point = this.caretGeometry();
    if (point && event.data) {
      this.view.setComposition(point, event.data);
    }
  }

  handleCompositionEnd(event) {
    this.composing = false;
    this.view.hideComposition();
    this.textarea.value = "";
    if (event.data) {
      this.insertText(event.data);
    }
  }

  handleCopy(event, cut) {
    if (this.isCollapsed()) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", this.selectionText());
    if (cut) {
      this.deleteSelectionIfAny();
    }
  }

  handlePaste(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return;
    }
    const files = clipboard.files ? Array.from(clipboard.files).filter((file) => /^image\//.test(file.type)) : [];
    if (files.length && this.callbacks.onPasteImages) {
      event.preventDefault();
      this.callbacks.onPasteImages(files);
      return;
    }
    const text = clipboard.getData("text/plain");
    if (text) {
      event.preventDefault();
      this.insertText(text);
    }
  }

  selectionText() {
    const { from, to } = this.normalized();
    if (from.block === to.block) {
      return blockText(this.blocks[from.block]).slice(from.offset, to.offset);
    }

    const parts = [blockText(this.blocks[from.block]).slice(from.offset)];
    for (let index = from.block + 1; index < to.block; index += 1) {
      parts.push(blockText(this.blocks[index]));
    }
    parts.push(blockText(this.blocks[to.block]).slice(0, to.offset));
    return parts.join("\n");
  }

  /* ---------------------------------------------------------------------
     Pointer
     --------------------------------------------------------------------- */

  handlePointerDown(event) {
    const resizeHandle = event.target.closest(".doc-resize-handle");
    if (resizeHandle) {
      this.startImageResize(resizeHandle.dataset.corner, event);
      return;
    }
    if (event.button !== 0) {
      return;
    }

    const link = event.target.closest(".m-link");
    if (link && (event.ctrlKey || event.metaKey) && link.dataset.href) {
      event.preventDefault();
      window.open(link.dataset.href, "_blank", "noopener");
      return;
    }

    if (event.target.closest(".doc-image")) {
      const entry = this.imageEntryAt(event.clientX, event.clientY);
      if (entry) {
        event.preventDefault();
        const position = { block: entry.index, offset: 0 };
        this.setSelection(position, position);
        this.focusEditor();
        this.imageDrag = {
          blockIndex: entry.index,
          startX: event.clientX,
          startY: event.clientY,
          startImage: { ...entry.image },
          anchorTop: entry.top,
          moved: false,
          snapshot: {
            blocks: this.blocks,
            anchor: { ...this.anchor },
            focus: { ...this.focus },
          },
        };
        return;
      }
    }

    event.preventDefault();
    this.focusEditor();
    const position = this.positionFromEvent(event);
    this.pointer = { anchor: position };
    this.collapseTo(position);
  }

  handlePointerMove(event) {
    if (this.imageResize) {
      this.resizeImageTo(event);
      return;
    }
    if (this.imageDrag) {
      this.dragImageTo(event);
      return;
    }
    if (!this.pointer) {
      return;
    }
    const position = this.positionFromEvent(event);
    this.setSelection(this.pointer.anchor, position, { keepMarks: true });
  }

  handlePointerUp() {
    if (this.imageResize) {
      const resize = this.imageResize;
      this.imageResize = null;

      if (resize.moved) {
        const finalBlocks = this.blocks;
        this.blocks = resize.snapshot.blocks;
        this.anchor = { ...resize.snapshot.anchor };
        this.focus = { ...resize.snapshot.focus };
        const position = { block: resize.index, offset: 0 };
        this.commit(finalBlocks, position, position);
      }
      return;
    }
    if (this.imageDrag) {
      const drag = this.imageDrag;
      this.imageDrag = null;
      this.root.classList.remove("is-dragging-image");

      if (drag.moved) {
        const finalBlocks = this.blocks;
        this.blocks = drag.snapshot.blocks;
        this.anchor = { ...drag.snapshot.anchor };
        this.focus = { ...drag.snapshot.focus };
        const position = { block: drag.blockIndex, offset: 0 };
        this.commit(finalBlocks, position, position);
      } else {
        const entry = this.layout ? this.layout.blocks[drag.blockIndex] : null;
        if (entry && this.callbacks.onImageSelect) {
          this.callbacks.onImageSelect(entry);
        }
      }
      return;
    }
    this.pointer = null;
  }

  dragImageTo(event) {
    const drag = this.imageDrag;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      this.root.classList.add("is-dragging-image");
      if (this.callbacks.onImageDragStart) {
        this.callbacks.onImageDragStart();
      }
    }

    const columnWidth = this.width || this.root.clientWidth || 640;
    const block = this.blocks[drag.blockIndex];
    const entry = this.layout && this.layout.blocks[drag.blockIndex];
    const width =
      block && block.mode !== "free"
        ? imageWidthFor({ ...block, mode: "free" }, columnWidth)
        : entry && entry.image
          ? entry.image.width
          : drag.startImage.width;
    const x = clamp(drag.startImage.x + dx, 0, Math.max(0, columnWidth - width));
    const desiredTop = Math.max(contentTop(), drag.startImage.y + dy);

    const next = this.blocks.slice();
    next[drag.blockIndex] = { ...next[drag.blockIndex], mode: "free", x, y: desiredTop };
    this.preview(next);
    drag.lastTop = desiredTop;
  }

  nudgeImage(direction, step) {
    const index = this.focus.block;
    const block = this.blocks[index];
    const entry = this.layout && this.layout.blocks[index];
    if (!block || block.type !== "image" || !entry || !entry.image) {
      return;
    }

    const columnWidth = this.width || this.root.clientWidth || 640;
    const width = entry.image.width;
    let x = entry.image.x;
    let top = entry.image.y;

    if (direction === "ArrowLeft") {
      x -= step;
    } else if (direction === "ArrowRight") {
      x += step;
    } else if (direction === "ArrowUp") {
      top -= step;
    } else if (direction === "ArrowDown") {
      top += step;
    }

    x = clamp(x, 0, Math.max(0, columnWidth - width));
    top = Math.max(contentTop(), top);

    const next = this.blocks.slice();
    next[index] = { ...block, mode: "free", x, y: top };
    this.commit(next, this.focus, this.focus);
  }

  preview(blocks) {
    this.blocks = blocks;
    this.relayout();
    this.sync();
  }

  startImageResize(corner, event) {
    const index = this.focus.block;
    const block = this.blocks[index];
    const entry = this.layout && this.layout.blocks[index];
    if (!block || block.type !== "image" || !entry || !entry.image) {
      return;
    }

    event.preventDefault();
    this.focusEditor();

    const rect = entry.image;
    this.imageResize = {
      corner,
      index,
      snapshot: {
        blocks: this.blocks,
        anchor: { ...this.anchor },
        focus: { ...this.focus },
      },
      aspect: rect.height > 0 ? rect.width / rect.height : 1,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      startWidth: rect.width,
      moved: false,
    };
  }

  resizeImageTo(event) {
    const resize = this.imageResize;
    const root = this.root.getBoundingClientRect();
    const pointerX = event.clientX - root.left;
    const columnWidth = this.width || this.root.clientWidth || 640;
    const east = resize.corner.includes("e");
    const west = resize.corner.includes("w");
    const north = resize.corner.includes("n");

    let width;
    let x;
    let y;

    if (event.altKey) {
      // Alt scales around the centre of the image instead of a corner.
      const centreX = (resize.left + resize.right) / 2;
      const centreY = (resize.top + resize.bottom) / 2;
      const distanceX = Math.abs(pointerX - centreX);
      const distanceY = Math.abs(event.clientY - root.top - centreY);
      const maxWidth = Math.min(columnWidth, 2 * Math.min(centreX, columnWidth - centreX));
      const maxHeight = Math.max(48, 2 * (centreY - contentTop()));
      width = Math.min(Math.max(distanceX * 2, distanceY * resize.aspect * 2), maxWidth, maxHeight * resize.aspect);
      if (!Number.isFinite(width) || width < 48 || Math.abs(width - resize.startWidth) < 0.5) {
        return;
      }
      x = centreX - width / 2;
      y = Math.max(contentTop(), centreY - width / resize.aspect / 2);
    } else {
      width = east ? pointerX - resize.left : resize.right - pointerX;
      width = clamp(width, 48, east ? columnWidth - resize.left : resize.right);
      if (!Number.isFinite(width) || width < 48 || Math.abs(width - resize.startWidth) < 0.5) {
        return;
      }
      x = west ? resize.right - width : resize.left;
      y = Math.max(contentTop(), north ? resize.bottom - width / resize.aspect : resize.top);
    }

    resize.moved = true;

    const next = resize.snapshot.blocks.slice();
    next[resize.index] = {
      ...next[resize.index],
      mode: "free",
      x,
      y,
      displayWidth: width,
    };
    this.preview(next);
    resize.lastWidth = width;
  }

  cancelImageResize() {
    if (!this.imageResize) {
      return;
    }
    const resize = this.imageResize;
    this.imageResize = null;
    this.blocks = resize.snapshot.blocks;
    this.anchor = { ...resize.snapshot.anchor };
    this.focus = { ...resize.snapshot.focus };
    this.relayout();
    this.sync();
  }

  cancelImageDrag() {
    if (!this.imageDrag) {
      return;
    }
    const drag = this.imageDrag;
    this.imageDrag = null;
    this.root.classList.remove("is-dragging-image");
    this.blocks = drag.snapshot.blocks;
    this.anchor = { ...drag.snapshot.anchor };
    this.focus = { ...drag.snapshot.focus };
    this.relayout();
    this.sync();
  }

  handleDoubleClick(event) {
    event.preventDefault();
    const position = this.positionFromEvent(event);
    const block = this.blocks[position.block];
    if (!block || block.type === "image") {
      return;
    }
    const text = blockText(block);
    const boundaries = wordBoundaries(text);
    let start = 0;
    let end = text.length;
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      if (boundaries[index] <= position.offset && position.offset <= boundaries[index + 1]) {
        start = boundaries[index];
        end = boundaries[index + 1];
        break;
      }
    }
    if (start === end) {
      return;
    }
    this.setSelection({ block: position.block, offset: start }, { block: position.block, offset: end });
    this.focusEditor();
  }

  imageEntryAt(clientX, clientY) {
    if (!this.layout) {
      return null;
    }
    const rect = this.root.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (const entry of this.layout.blocks) {
      if (entry.block.type !== "image" || !entry.image) {
        continue;
      }
      const image = entry.image;
      if (x >= image.x && x <= image.x + image.width && y >= image.y && y <= image.y + image.height) {
        return entry;
      }
    }
    return null;
  }

  positionFromEvent(event) {
    if (!this.layout) {
      return { block: 0, offset: 0 };
    }
    const rect = this.root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const entry = entryAtY(this.layout, y);
    if (!entry) {
      const last = this.blocks.length - 1;
      return { block: last, offset: blockLength(this.blocks[last]) };
    }
    if (entry.block.type === "image") {
      return { block: entry.index, offset: 0 };
    }
    return { block: entry.index, offset: pointToOffset(entry, x, y) };
  }

  lineAtPoint(event) {
    if (!this.layout) {
      return null;
    }
    const rect = this.root.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const entry = entryAtY(this.layout, y);
    return entry ? lineAtY(entry, y) : null;
  }
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

function insertRuns(block, offset, text, marks) {
  const { left, right } = splitRuns(block.runs, offset);
  return normalizeRuns([...left, { text, ...marks }, ...right]);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function previousBoundary(boundaries, offset) {
  let previous = 0;
  for (const boundary of boundaries) {
    if (boundary >= offset) {
      break;
    }
    previous = boundary;
  }
  return previous;
}

function nextBoundaryAfter(boundaries, offset) {
  for (const boundary of boundaries) {
    if (boundary > offset) {
      return boundary;
    }
  }
  return offset;
}

function previousPosition(blocks, index) {
  let cursor = index - 1;
  while (cursor >= 0) {
    const block = blocks[cursor];
    if (block) {
      return { block: cursor, offset: block.type === "image" ? 0 : blockLength(block) };
    }
    cursor -= 1;
  }
  return { block: 0, offset: 0 };
}

function stepPosition(blocks, position, direction) {
  const block = blocks[position.block];
  if (!block) {
    return position;
  }
  if (block.type === "image") {
    const index = Math.max(0, Math.min(blocks.length - 1, position.block + direction));
    return { block: index, offset: 0 };
  }
  const text = blockText(block);
  const boundaries = graphemeBoundaries(text);

  if (direction < 0) {
    if (position.offset > 0) {
      return { block: position.block, offset: previousBoundary(boundaries, position.offset) };
    }
    let index = position.block - 1;
    while (index >= 0 && blocks[index].type === "image") {
      index -= 1;
    }
    if (index < 0) {
      return { block: 0, offset: 0 };
    }
    return { block: index, offset: blockLength(blocks[index]) };
  }

  if (position.offset < text.length) {
    return { block: position.block, offset: nextBoundaryAfter(boundaries, position.offset) };
  }
  let index = position.block + 1;
  while (index < blocks.length && blocks[index].type === "image") {
    index += 1;
  }
  if (index >= blocks.length) {
    return { block: blocks.length - 1, offset: blockLength(blocks[blocks.length - 1]) };
  }
  return { block: index, offset: 0 };
}

function stepWord(blocks, position, direction) {
  const block = blocks[position.block];
  if (!block || block.type === "image") {
    return stepPosition(blocks, position, direction);
  }
  const boundaries = wordBoundaries(blockText(block));
  if (direction < 0) {
    if (position.offset === 0) {
      return stepPosition(blocks, position, -1);
    }
    return { block: position.block, offset: previousBoundary(boundaries, position.offset) };
  }
  if (position.offset >= blockLength(block)) {
    return stepPosition(blocks, position, 1);
  }
  return { block: position.block, offset: nextBoundaryAfter(boundaries, position.offset) };
}

let wordSegmenter = null;
let wordChecked = false;

function wordBoundaries(text) {
  if (!wordChecked) {
    wordChecked = true;
    try {
      wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
    } catch (error) {
      wordSegmenter = null;
    }
  }
  if (!wordSegmenter) {
    return graphemeBoundaries(text);
  }
  const points = [0];
  for (const part of wordSegmenter.segment(text)) {
    points.push(part.index + part.segment.length);
  }
  return points;
}

function selectionHasMark(blocks, from, to, key) {
  let hasText = false;
  for (let index = from.block; index <= to.block; index += 1) {
    const block = blocks[index];
    if (!block || block.type === "image" || block.type === "code") {
      continue;
    }
    const start = index === from.block ? from.offset : 0;
    const end = index === to.block ? to.offset : blockLength(block);
    const runs = runsInRange(block, start, end);
    for (const run of runs) {
      if (!run.text.trim()) {
        continue;
      }
      hasText = true;
      if (!run[key]) {
        return false;
      }
    }
  }
  return hasText;
}
