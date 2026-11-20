// The editing engine: owns the block model, the selection, and the hidden
// textarea that receives typing, IME, and clipboard input. Every change goes
// through commit(), which keeps undo, layout, and painting in step.

import { blocksFromPastedHtml, selectionHtml } from "./clipboard.js";
import {
  ALIGNMENTS,
  blockAlignment,
  blockIndent,
  blockLength,
  blockText,
  createBlock,
  createBlockId,
  createDivider,
  emptyParagraph,
  headingAnchors,
  isAtomicBlock,
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
  graphemeBoundaryAtOrAfter,
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
const HEADING_TYPES = new Set(["h1", "h2", "h3"]);
// Markdown line shortcuts in the rendered editor. The complete line prefix,
// space included, maps to the block it starts; nothing above Heading 3 exists.
// A row of three dashes is a divider: the block becomes a horizontal rule and
// the caret continues in a paragraph below it.
const MARKDOWN_SHORTCUTS = new Map([
  ["- ", "list"],
  ["# ", "h1"],
  ["## ", "h2"],
  ["### ", "h3"],
  ["--- ", "divider"],
]);
// Tab types four spaces at the caret in a paragraph. A selection gets one tab
// stop at the start of every line it touches instead, the way a code editor
// indents a block of text.
const TAB_TEXT = "    ";
// A deep link leaves this much room above the heading it jumps to, so the
// heading does not hide under the sticky editor header (64 px tall).
const ANCHOR_MARGIN = 96;

export class DocEditor {
  constructor({
    root,
    textarea,
    onLayout,
    onChange,
    onSelection,
    onImageSelect,
    onImageDragStart,
    onSave,
    onLink,
    onPasteImages,
    onSourceFormat,
    onSourceWrap,
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
    this.lineHint = null;
    // Markdown mode: blocks hold source lines, so the rich-text commands must
    // not touch them. The page sets this flag and routes formatting through
    // onSourceFormat instead.
    this.sourceMode = false;
    // Pending inline marks in Markdown mode wrap the next typed text, the way
    // pendingMarks already does for rich text.
    this.pendingSourceMarks = null;
    this.callbacks = {
      onLayout,
      onChange,
      onSelection,
      onImageSelect,
      onImageDragStart,
      onSave,
      onLink,
      onPasteImages,
      onSourceFormat,
      onSourceWrap,
    };
    this.bound = false;
  }

  bind() {
    if (this.bound) {
      return;
    }
    this.bound = true;

    this.textarea.addEventListener("keydown", (event) => this.handleKeyDown(event));
    this.textarea.addEventListener("beforeinput", (event) => {
      // A virtual keyboard can send an editing command without a keydown.
      // In particular, deleting from our empty textarea may never fire input.
      if (event.cancelable && !this.composing && !event.isComposing && this.applyInputCommand(event.inputType)) {
        event.preventDefault();
      }
    });
    this.textarea.addEventListener("input", (event) => this.handleInput(event));
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
    this.root.addEventListener("contextmenu", (event) => this.handleContextMenu(event));
    window.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    window.addEventListener("pointerup", () => this.handlePointerUp());
    window.addEventListener("pointercancel", () => {
      this.cancelImageDrag();
      this.cancelImageResize();
    });
    this.root.addEventListener("dblclick", (event) => this.handleDoubleClick(event));
    // The browser does not emit a "tripleclick" event; a click's `detail` is
    // the running click count, which is the same count that drives dblclick.
    // A count of three selects the line under the pointer and anything beyond
    // that selects the whole document.
    this.root.addEventListener("click", (event) => this.handleClickCount(event));

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

  setDocument(blocks, selection, { history, undoFrom } = {}) {
    this.blocks = blocks.length ? blocks : [emptyParagraph()];
    this.anchor = selection ? { ...selection.anchor } : { block: 0, offset: 0 };
    this.focus = selection ? { ...selection.focus } : { block: 0, offset: 0 };
    this.pendingMarks = null;
    this.pendingSourceMarks = null;
    this.undoStack = history ? history.undo : [];
    this.redoStack = history ? history.redo : [];
    if (undoFrom) {
      this.recordUndo(undoFrom);
    }
    this.typing = null;
    this.lineHint = null;
    this.width = this.root.clientWidth || 640;
    this.relayout();
    this.sync();
  }

  getDocument() {
    return this.blocks;
  }

  getHistory() {
    return { undo: this.undoStack, redo: this.redoStack };
  }

  // Markdown mode switches the editor between rich blocks and plain source
  // lines. The page owns the mode; this only gates the rich-text editing
  // commands that would otherwise rewrite a source line as a styled block.
  setSourceMode(enabled) {
    this.sourceMode = Boolean(enabled);
    this.pendingMarks = null;
    this.pendingSourceMarks = null;
    this.typing = null;
  }

  setSourcePendingMarks(marks) {
    const keys = marks ? Object.keys(marks).filter((key) => marks[key]) : [];
    this.pendingSourceMarks = keys.length ? { ...marks } : null;
  }

  getSourcePendingMarks() {
    return this.pendingSourceMarks ? { ...this.pendingSourceMarks } : null;
  }

  entryFor(index) {
    return this.layout ? this.layout.blocks[index] : null;
  }

  getSelection() {
    return { anchor: { ...this.anchor }, focus: { ...this.focus }, collapsed: this.isCollapsed() };
  }

  linkAtCaret() {
    const block = this.blocks[this.focus.block];
    if (!block || isAtomicBlock(block) || block.type === "code") {
      return null;
    }
    let from = 0;
    for (let index = 0; index < block.runs.length; index += 1) {
      const run = block.runs[index];
      let to = from + run.text.length;
      while (run.href && block.runs[index + 1]?.href === run.href) {
        index += 1;
        to += block.runs[index].text.length;
      }
      if (run.href && from <= this.focus.offset && this.focus.offset <= to) {
        return { href: run.href, from, to };
      }
      from = to;
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

  updateImageBlock(index, changes, options) {
    const block = this.blocks[index];
    if (!block || block.type !== "image") {
      return;
    }
    const next = this.replaceBlock(index, { ...block, ...changes });
    this.commit(next, { block: index, offset: 0 }, { block: index, offset: 0 }, options);
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
    this.view.clearSearchPassage();
    // Moving the caret or dragging a new selection ends the current typing
    // run, so the next undo does not also swallow the text typed before it.
    this.typing = null;
    this.pendingSourceMarks = null;
    this.anchor = { ...anchor };
    this.focus = { ...focus };
    if (!(options && options.keepMarks)) {
      this.pendingMarks = null;
    }
    // A selection set here always comes from a cursor gesture (a key, a click,
    // a drag), so the caret slides to it unless the caller is a viewport jump
    // that keeps the caret in place on screen.
    this.sync({ animateCaret: !options || options.animateCaret !== false });
  }

  collapseTo(position, options) {
    this.setSelection(position, position, options);
  }

  focusEditor() {
    // A dialog that closes can hand this textarea back active but unable to
    // accept text: while the dialog was open the page was inert, and the
    // browser's restored focus does not bring the editing state with it, so
    // keystrokes arrive and nothing is written. Focusing an element that is
    // already active is a no-op and cannot repair that, so take the textarea
    // out and put it back. Both handlers run in this task and paint once, so
    // the caret never flickers.
    if (document.activeElement === this.textarea) {
      this.textarea.blur();
    }
    this.textarea.focus({ preventScroll: true });
    this.sync();
  }

  activeMarks() {
    return this.pendingMarks || this.marksForTyping();
  }

  activeBlockType() {
    const block = this.blocks[this.focus.block];
    if (!block) {
      return "p";
    }
    if (block.type === "list") {
      return "p";
    }
    // A divider has no paragraph style; while the caret rests on one the style
    // menu keeps showing Normal text rather than an unknown label.
    if (block.type === "divider") {
      return "p";
    }
    return block.type;
  }

  activeAlignment() {
    const block = this.blocks[this.focus.block];
    return blockAlignment(block);
  }

  /* ---------------------------------------------------------------------
     Layout and painting
     --------------------------------------------------------------------- */

  relayout() {
    const width = this.width || this.root.clientWidth || 640;
    this.layout = layoutDocument(this.blocks, width);
    this.view.setLayout(this.layout, this.blocks);
    this.callbacks.onLayout?.(this.blocks);
  }

  sync(options) {
    const settings = options || {};
    this.clampSelection();
    const collapsed = this.isCollapsed();
    const entry = this.layout ? blockEntry(this.layout, this.focus.block) : null;

    this.view.setSpellingCaret(this.typing || this.composing ? this.focus : null);

    this.view.paintSelection(this.layout ? { anchor: this.anchor, focus: this.focus } : null);

    if (collapsed) {
      const point = this.caretGeometry();
      this.view.setCaret(this.focused ? point : null, settings.animateCaret === true);
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
    if (isAtomicBlock(entry.block)) {
      return null;
    }
    return caretPoint(entry, this.focus.offset, this.lineHint);
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
    const point = entry && !isAtomicBlock(entry.block) ? caretPoint(entry, saved.offset, this.lineHint) : null;
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
        this.recordUndo(this.historySnapshot());
      }
    }

    const block = blocks[focus.block];
    // Inserting or deleting text can join two previously separate graphemes.
    // Leave the caret after the whole character so the next edit can't split it.
    if (
      block && block !== this.blocks[focus.block] && anchor.block === focus.block &&
      anchor.offset === focus.offset && focus.offset > 0 && focus.offset < blockLength(block)
    ) {
      const offset = graphemeBoundaryAtOrAfter(blockText(block), focus.offset);
      anchor = focus = { block: focus.block, offset };
    }

    this.blocks = blocks;
    this.anchor = { ...anchor };
    this.focus = { ...focus };
    this.lineHint = null;

    if (settings.coalesce) {
      this.typing = { time: Date.now() };
    } else {
      this.typing = null;
    }
    if (settings.keepMarks !== true) {
      this.pendingMarks = settings.pendingMarks || null;
      this.pendingSourceMarks = null;
    }

    this.relayout();
    this.sync();
    this.view.scrollCaretIntoView();
    if (this.callbacks.onChange) {
      this.callbacks.onChange(this.blocks);
    }
  }

  recordUndo(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  replaceMisspelling(index, block, { start, end, word }, text) {
    // A suggestion may arrive after the user has edited or moved the block.
    if (this.sourceMode || this.blocks[index] !== block || blockText(block).slice(start, end) !== word) {
      return false;
    }
    const { left, right } = splitRuns(block.runs, start);
    const { left: original, right: tail } = splitRuns(right, end - start);
    const correction = spellingCorrectionRuns(original, word, text);
    const runs = normalizeRuns([...left, ...correction, ...tail]);
    const next = { ...block, id: createBlockId(), runs };
    const caret = { block: index, offset: start + text.length };
    this.commit(this.replaceBlock(index, next), caret, caret);
    return true;
  }

  historySnapshot() {
    return { blocks: this.blocks, anchor: this.anchor, focus: this.focus, pendingMarks: this.pendingMarks };
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) {
      return;
    }
    this.redoStack.push(this.historySnapshot());
    this.restoreHistorySnapshot(previous);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }
    this.undoStack.push(this.historySnapshot());
    this.restoreHistorySnapshot(next);
  }

  restoreHistorySnapshot(snapshot) {
    this.blocks = snapshot.blocks;
    this.anchor = { ...snapshot.anchor };
    this.focus = { ...snapshot.focus };
    this.typing = null;
    this.pendingMarks = snapshot.pendingMarks || null;
    this.pendingSourceMarks = null;
    this.lineHint = null;
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

  // Markdown line shortcuts, for typed input only: the space that ends "- ",
  // "# ", "## ", "### ", or "--- " at the start of a block turns the block into
  // a bullet item, the matching heading, or a divider and consumes the marker.
  // A heading's caret continues in the converted block, with the text that was
  // after the marker; a divider takes the whole line, so that text continues in
  // the paragraph below it. A marker anywhere else on the line, a code block,
  // a divider, and Markdown source stay literal. Pasting never runs this.
  applyMarkdownShortcut(typed) {
    if (this.sourceMode || !this.isCollapsed()) {
      return false;
    }
    // Every marker is at most four characters long and must start at offset 0,
    // so a caret deeper in the block skips the text work below on every
    // keystroke.
    const offset = this.focus.offset;
    if (offset + typed.length > 4) {
      return false;
    }
    const index = this.focus.block;
    const block = this.blocks[index];
    if (!block || isAtomicBlock(block) || block.type === "code") {
      return false;
    }
    const type = MARKDOWN_SHORTCUTS.get(blockText(block).slice(0, offset) + typed);
    if (!type) {
      return false;
    }

    if (type === "divider") {
      // The rule owns the line, so anything the writer had typed after the
      // marker moves into the paragraph below it and the caret waits there.
      const below = createBlock("p", removeRangeFromRuns(block.runs, 0, offset), {
        align: block.align,
        indent: block.indent,
      });
      const blocks = this.blocks.slice();
      blocks.splice(index, 1, createDivider(), below);
      const caret = { block: index + 1, offset: 0 };
      this.commit(blocks, caret, caret, { coalesce: true, keepMarks: true });
      return true;
    }

    const next = {
      ...block,
      id: createBlockId(),
      runs: removeRangeFromRuns(block.runs, 0, offset),
      type,
      ordered: false,
      // A bullet marker on an item keeps that item's nesting; every other
      // conversion starts at the outermost level, like the style menu.
      depth: type === "list" && block.type === "list" ? block.depth : 0,
    };
    const caret = { block: index, offset: 0 };
    this.commit(this.replaceBlock(index, next), caret, caret, { coalesce: true, keepMarks: true });
    return true;
  }

  insertText(text, overrideMarks, { coalesce = true } = {}) {
    if (!text) {
      return;
    }

    // In Markdown mode a pending toolbar mark wraps the next typed text in
    // markers and leaves the caret inside the pair, so continuing to type stays
    // formatted. A multi-line paste ignores the pending marks: each line would
    // need its own pair, which is not what the toolbar promised.
    if (this.sourceMode && this.pendingSourceMarks) {
      const pending = this.pendingSourceMarks;
      this.pendingSourceMarks = null;
      const raw = String(text);
      const wrapped =
        raw && raw.indexOf("\n") === -1 && this.isCollapsed() && this.callbacks.onSourceWrap
          ? this.callbacks.onSourceWrap(raw, pending)
          : null;
      if (wrapped && wrapped.text) {
        const blockIndex = this.focus.block;
        this.insertText(wrapped.text, undefined, { coalesce });
        if (this.focus.block === blockIndex) {
          const caret = Math.max(0, this.focus.offset - wrapped.closingLength);
          this.setSelection({ block: blockIndex, offset: caret }, { block: blockIndex, offset: caret }, {
            animateCaret: false,
          });
        }
        return;
      }
    }

    const parts = String(text).replace(/\r\n?/g, "\n").split("\n");
    const marks = overrideMarks || this.pendingMarks || this.marksForTyping();

    // Replace a selection in the same commit as the insert, so one undo puts
    // back everything that was selected instead of only the insert.
    const deletion = this.selectionDeletion({ forInsertion: true });
    let caret = deletion ? { ...deletion.caret } : { ...this.focus };
    let blocks = deletion ? deletion.blocks : this.blocks;

    // A collapsed caret can sit on an image or a divider (a click selects it).
    // Typing then replaces that block with a paragraph at the same position.
    if (blocks[caret.block] && isAtomicBlock(blocks[caret.block])) {
      blocks = blocks.slice();
      blocks[caret.block] = emptyParagraph();
      caret = { block: caret.block, offset: 0 };
    }

    // A code block is one block even when a paste brings several lines: its
    // line feeds belong in the code, not in new paragraph blocks.
    const target = blocks[caret.block];
    if (target && target.type === "code" && parts.length > 1) {
      const runs = insertRuns(target, caret.offset, parts.join("\n"), {});
      const next = blocks.slice();
      next[caret.block] = { ...target, id: createBlockId(), runs };
      caret = { block: caret.block, offset: caret.offset + parts.join("\n").length };
      if (deletion) {
        this.typing = null;
      }
      this.commit(next, caret, caret, { coalesce, keepMarks: true });
      return;
    }

    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        const split = this.splitAt(blocks, caret);
        blocks = split.blocks;
        caret = split.caret;
      }
      if (parts[index]) {
        const block = blocks[caret.block];
        const partMarks = block.type === "code" ? {} : marks;
        const next = { ...block, id: createBlockId(), runs: insertRuns(block, caret.offset, parts[index], partMarks) };
        blocks = blocks.slice();
        blocks[caret.block] = next;
        caret = { block: caret.block, offset: caret.offset + parts[index].length };
      }
    }

    // The replacement and the typing that follows it stay one undo step, but
    // it must be a new step: do not merge with typing from before the
    // selection.
    if (deletion) {
      this.typing = null;
    }
    this.commit(blocks, caret, caret, { coalesce, keepMarks: true });
  }

  // Insert block content from a rich clipboard. A single pasted paragraph joins
  // the paragraph at the caret, keeping its marks run by run. Headings, lists,
  // quotes, and code blocks keep their own block and split the line at the
  // caret. A code block and Markdown source hold plain text, so they take the
  // pasted text as lines instead of blocks.
  insertBlocks(pasted) {
    if (!pasted.length) {
      return;
    }
    if (this.sourceMode) {
      this.insertText(pastedPlainText(pasted), undefined, { coalesce: false });
      return;
    }

    const deletion = this.selectionDeletion({ forInsertion: true });
    let blocks = deletion ? deletion.blocks : this.blocks;
    let caret = deletion ? { ...deletion.caret } : { ...this.focus };

    // The surviving block is the paste destination in either selection
    // direction. Code takes one unmarked run, including any line feeds.
    if (blocks[caret.block].type === "code") {
      const text = pastedPlainText(pasted);
      if (!text) return;
      pasted = [createBlock("p", [{ text }])];
    }

    // A picture or divider caret is replaced by a paragraph, the same way
    // typing over a selected picture works; the paste then lands in that
    // paragraph.
    if (blocks[caret.block] && isAtomicBlock(blocks[caret.block])) {
      blocks = blocks.slice();
      blocks[caret.block] = emptyParagraph();
      caret = { block: caret.block, offset: 0 };
    }

    if (pasted.length === 1 && isPlainParagraph(pasted[0])) {
      const runs = insertRunList(blocks[caret.block], caret.offset, pasted[0].runs);
      const next = blocks.slice();
      next[caret.block] = { ...blocks[caret.block], id: createBlockId(), runs };
      const position = { block: caret.block, offset: caret.offset + blockLength(pasted[0]) };
      this.commit(next, position, position);
      return;
    }

    const [head, tail] = splitBlockModel(blocks[caret.block], caret.offset);
    const body = pasted.map((block) => ({ ...block, id: createBlockId() }));
    // Pasting list items inside a nested item inserts them as siblings of that
    // item, so their nesting is relative to where the caret is.
    const listDepth =
      blocks[caret.block] && blocks[caret.block].type === "list"
        ? Math.min(LIST_DEPTH_LIMIT, Math.max(0, Number(blocks[caret.block].depth) || 0))
        : 0;
    if (listDepth > 0) {
      for (let index = 0; index < body.length; index += 1) {
        const block = body[index];
        if (block.type === "list") {
          body[index] = { ...block, depth: Math.min(LIST_DEPTH_LIMIT, (Number(block.depth) || 0) + listDepth) };
        }
      }
    }
    let first = head;
    let last = tail;
    // A pasted paragraph at either edge joins the line it was pasted onto, so
    // pasting "one\ntwo" mid-paragraph continues the sentence instead of
    // leaving ragged half-paragraphs. Headings and list items stay separate.
    const firstParagraph = isPlainParagraph(body[0]) ? body.shift() : null;
    const lastParagraph = isPlainParagraph(body.at(-1)) ? body.pop() : null;
    if (firstParagraph) {
      first = { ...first, id: createBlockId(), runs: normalizeRuns([...first.runs, ...firstParagraph.runs]) };
    }
    if (lastParagraph) {
      last = { ...last, id: createBlockId(), runs: normalizeRuns([...lastParagraph.runs, ...last.runs]) };
    }

    // Keep an empty paragraph supplied by the clipboard. Empty halves
    // created solely by splitting the destination can be left out.
    const replacement = [];
    if (firstParagraph || blockLength(first) > 0) {
      replacement.push(first);
    }
    replacement.push(...body);
    // A merged final paragraph puts the caret in the tail, just before the
    // old text. Otherwise typing continues at the end of the last paste block.
    const pasteEndIndex = lastParagraph ? replacement.length : replacement.length - 1;
    if (lastParagraph || blockLength(last) > 0) {
      replacement.push(last);
    }

    const next = blocks.slice();
    next.splice(caret.block, 1, ...replacement);

    let position = { block: caret.block + pasteEndIndex, offset: blockLength(pasted.at(-1)) };

    // A paste ending with a picture or divider needs a text caret after it.
    // Use the following text, or open a paragraph before the next picture.
    if (isAtomicBlock(next[position.block])) {
      const after = position.block + 1;
      if (!next[after] || isAtomicBlock(next[after])) {
        next.splice(after, 0, emptyParagraph());
      }
      position = { block: after, offset: 0 };
    }
    this.commit(next, position, position);
  }

  marksForTyping() {
    if (!this.isCollapsed()) {
      const { from, to } = this.normalized();
      for (const { block, start } of selectedTextRanges(this.blocks, from, to)) {
        return block.type === "code" ? {} : marksAt(block, start);
      }
      return {};
    }
    const block = this.blocks[this.focus.block];
    if (!block || isAtomicBlock(block)) {
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
    if (isAtomicBlock(block)) {
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

  // The blocks and caret that result from deleting the current selection, or
  // null when it is collapsed. Callers that insert something immediately use
  // this so the delete and the insert share one commit and one undo step.
  selectionDeletion({ forInsertion = false } = {}) {
    if (this.isCollapsed()) {
      return null;
    }
    const { from, to } = this.normalized();
    const first = this.blocks[from.block];
    const last = this.blocks[to.block];

    if (isAtomicBlock(first) && isAtomicBlock(last)) {
      const next = this.blocks.slice();
      next.splice(from.block, to.block - from.block + 1);
      const caret = previousPosition(next, from.block);
      // The neighbour can take focus after Delete, but it is outside the
      // selection. Give a replacement its own caret at the original gap.
      if (!next.length || (forInsertion && isAtomicBlock(next[caret.block]))) {
        const paragraph = emptyParagraph();
        if (this.sourceMode) {
          paragraph.source = true;
        }
        next.splice(from.block, 0, paragraph);
        return { blocks: next, caret: from, openedParagraph: true };
      }
      return { blocks: next, caret };
    }
    if (from.block === to.block) {
      const block = { ...first, id: createBlockId(), runs: removeRangeFromRuns(first.runs, from.offset, to.offset) };
      return { blocks: this.replaceBlock(from.block, block), caret: from };
    }

    const headLength = from.offset;
    const headRuns = isAtomicBlock(first) ? [] : runsInRange(first, 0, from.offset);
    const tailRuns = isAtomicBlock(last) ? [] : runsInRange(last, to.offset, blockLength(last));
    const base = isAtomicBlock(first) ? last : first;
    const mergedRuns = normalizeRuns([...headRuns, ...tailRuns]);
    const merged = {
      ...base,
      id: createBlockId(),
      runs: mergedRuns,
      type: base.type === "code" ? "code" : base.type,
    };
    const next = this.blocks.slice();
    next.splice(from.block, to.block - from.block + 1, merged);
    return { blocks: next, caret: { block: from.block, offset: headLength } };
  }

  deleteSelectionIfAny() {
    const deletion = this.selectionDeletion();
    if (!deletion) {
      return false;
    }
    this.commit(deletion.blocks, deletion.caret, deletion.caret);
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

    if (isAtomicBlock(block)) {
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

    if (isAtomicBlock(previousBlock)) {
      const next = this.blocks.slice();
      next.splice(previousIndex, 1);
      const caret = { block: previousIndex, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    if (isAtomicBlock(block)) {
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

    if (isAtomicBlock(block)) {
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
    if (isAtomicBlock(nextBlock)) {
      const next = this.blocks.slice();
      next.splice(position.block + 1, 1);
      this.commit(next.length ? next : [emptyParagraph()], position, position);
      return;
    }

    if (isAtomicBlock(block)) {
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
    const deletion = this.selectionDeletion({ forInsertion: true });
    const blocks = deletion ? deletion.blocks : this.blocks;
    const index = deletion ? deletion.caret.block : this.focus.block;
    const offset = deletion ? deletion.caret.offset : this.focus.offset;
    const block = blocks[index];
    if (!block || deletion?.openedParagraph) {
      if (deletion) {
        this.commit(deletion.blocks, deletion.caret, deletion.caret);
      }
      return;
    }

    if (isAtomicBlock(block)) {
      const paragraph = emptyParagraph();
      const next = blocks.slice();
      next.splice(index + 1, 0, paragraph);
      const caret = { block: index + 1, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    if (block.type === "code") {
      const runs = insertRuns(block, offset, "\n", {});
      const next = blocks.slice();
      next[index] = { ...block, id: createBlockId(), runs };
      const caret = { block: index, offset: offset + 1 };
      this.commit(next, caret, caret);
      return;
    }

    if (block.type === "list") {
      if (blockLength(block) === 0) {
        const next = blocks.slice();
        if (block.depth > 0) {
          next[index] = { ...block, id: createBlockId(), depth: block.depth - 1 };
          this.commit(next, { block: index, offset }, { block: index, offset });
          return;
        }
        next[index] = emptyParagraph();
        this.commit(next, { block: index, offset }, { block: index, offset });
        return;
      }
      const [first, second] = splitBlockModel(block, offset);
      const next = blocks.slice();
      next.splice(index, 1, first, second);
      const caret = { block: index + 1, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    // Enter at the very start of a heading opens an ordinary line above it
    // instead of breaking the heading itself: the heading stays whole so it can
    // be moved down, and the caret lands on the new empty line. Breaking after
    // some heading text still ends the heading (below).
    if (!this.sourceMode && HEADING_TYPES.has(block.type) && offset === 0 && blockLength(block) > 0) {
      const paragraph = emptyParagraph();
      const next = blocks.slice();
      next.splice(index, 0, paragraph);
      const caret = { block: index, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    const [first, second] = splitBlockModel(block, offset);
    // Enter ends a heading: the text before the break keeps the heading style,
    // and the line the caret lands on is an ordinary paragraph, so writing a
    // title does not continue in heading style. A heading is rich-text only;
    // Markdown source lines stay plain blocks and keep their own markers.
    const continuation =
      !this.sourceMode && HEADING_TYPES.has(block.type) ? { ...second, type: "p" } : second;
    const next = blocks.slice();
    next.splice(index, 1, first, continuation);
    const caret = { block: index + 1, offset: 0 };
    this.commit(next, caret, caret);
  }

  /* ---------------------------------------------------------------------
     Formatting commands
     --------------------------------------------------------------------- */

  toggleMark(key) {
    if (this.sourceMode) {
      return;
    }
    if (this.isCollapsed()) {
      const current = this.activeMarks();
      this.pendingMarks = { ...current, [key]: !current[key] };
      this.sync();
      return;
    }

    const { from, to } = this.normalized();
    const ranges = Array.from(selectedTextRanges(this.blocks, from, to))
      .filter(({ block }) => block.type !== "code");
    if (!ranges.length) {
      return;
    }
    const value = !selectionHasMark(ranges, key);
    const blocks = this.blocks.slice();
    for (const { block, index, start, end } of ranges) {
      blocks[index] = { ...block, id: createBlockId(), runs: setMarkOnRuns(block.runs, start, end, key, value) };
    }

    this.commit(blocks, this.anchor, this.focus);
  }

  setBlockType(type) {
    if (this.sourceMode) {
      return;
    }
    const { from, to } = this.normalized();
    let blocks = this.blocks;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || isAtomicBlock(block)) {
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
    if (this.sourceMode) {
      return;
    }
    const { from, to } = this.normalized();
    const indices = [];
    for (let index = from.block; index <= to.block; index += 1) {
      if (this.blocks[index] && !isAtomicBlock(this.blocks[index])) {
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
      const next = nestListBlock(block, direction);
      if (next === block) {
        continue;
      }
      blocks = blocks.slice();
      blocks[index] = next;
      changed = true;
    }

    if (changed) {
      this.commit(blocks, this.anchor, this.focus);
    }
  }

  setAlignment(align) {
    if (this.sourceMode) {
      return;
    }
    if (!ALIGNMENT_VALUES.has(align)) {
      return;
    }
    const { from, to } = this.normalized();
    let blocks = this.blocks;
    let changed = false;

    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || isAtomicBlock(block) || block.type === "code") {
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

  // Tab types four spaces at the caret in a paragraph, nests a list item, and
  // inserts a tab in a code block. A selection gets one tab stop at the start
  // of every line it touches instead, the way a code editor indents a block of
  // text, so Tab never merges paragraphs and never replaces the selection.
  handleTab(direction) {
    if (!this.isCollapsed()) {
      this.indentSelection(direction);
      return;
    }

    const block = this.blocks[this.focus.block];
    if (!block || isAtomicBlock(block)) {
      return;
    }
    if (block.type === "list") {
      this.indentList(direction);
      return;
    }
    if (direction > 0) {
      this.insertText(block.type === "code" ? "\t" : TAB_TEXT);
      return;
    }
    this.outdentAtCaret();
  }

  // Indent or outdent one tab stop on every line the selection touches. Text
  // is only ever added or removed at the start of the selected lines, so
  // Shift+Tab on an unindented selection is a no-op instead of a delete.
  indentSelection(direction) {
    const { from, to } = this.normalized();
    const anchor = { ...this.anchor };
    const focus = { ...this.focus };
    let blocks = this.blocks;
    let changed = false;

    for (let index = from.block; index <= to.block; index += 1) {
      // A selection dragged to the very start of a block does not touch it.
      if (index === to.block && index !== from.block && to.offset === 0) {
        continue;
      }
      const block = blocks[index];
      if (!block || isAtomicBlock(block)) {
        continue;
      }
      if (block.type === "list") {
        const next = nestListBlock(block, direction);
        if (next !== block) {
          blocks = blocks.slice();
          blocks[index] = next;
          changed = true;
        }
        continue;
      }

      const shifted = shiftLines(block, from, to, index, direction);
      let next = shifted ? shifted.block : null;
      if (!next && direction < 0) {
        // Documents written by older versions may still carry a block indent.
        next = reduceBlockIndent(block);
      }
      if (!next) {
        continue;
      }
      blocks = blocks.slice();
      blocks[index] = next;
      changed = true;
      if (shifted) {
        if (anchor.block === index) {
          anchor.offset = mapOffsetThroughEdits(anchor.offset, shifted.edits);
        }
        if (focus.block === index) {
          focus.offset = mapOffsetThroughEdits(focus.offset, shifted.edits);
        }
      }
    }

    if (changed) {
      this.commit(blocks, anchor, focus);
    }
  }

  // Shift+Tab with a collapsed caret takes back a tab typed at the caret (the
  // spaces Tab just inserted), or else outdents the line the caret sits on by
  // one tab stop: one tab or up to four spaces. It never deletes text.
  outdentAtCaret() {
    const position = this.focus;
    const block = this.blocks[position.block];
    if (!block || isAtomicBlock(block)) {
      return;
    }

    const text = blockText(block);
    // At offset 0 the caret is on the first line whatever the text starts
    // with; `lastIndexOf` would find a leading line feed in the wrong place.
    const lineStart = position.offset === 0 ? 0 : text.lastIndexOf("\n", position.offset - 1) + 1;

    // A tab typed into the middle of a line comes back before the indentation
    // at the start of the line is touched.
    let start = position.offset;
    if (text[start - 1] === "\t") {
      start -= 1;
    } else {
      while (start > lineStart && position.offset - start < TAB_TEXT.length && text[start - 1] === " ") {
        start -= 1;
      }
    }
    if (start < position.offset && text.slice(lineStart, start).trim() !== "") {
      const runs = removeRangeFromRuns(block.runs, start, position.offset);
      const caret = { block: position.block, offset: start };
      this.commit(this.replaceBlock(position.block, { ...block, id: createBlockId(), runs }), caret, caret);
      return;
    }

    const count = outdentLength(text, lineStart);
    if (count > 0) {
      const runs = removeRangeFromRuns(block.runs, lineStart, lineStart + count);
      const caret = { block: position.block, offset: Math.max(lineStart, position.offset - count) };
      this.commit(this.replaceBlock(position.block, { ...block, id: createBlockId(), runs }), caret, caret);
      return;
    }

    const next = reduceBlockIndent(block);
    if (next) {
      this.commit(this.replaceBlock(position.block, next), this.anchor, this.focus);
    }
  }

  setLink(href, label) {
    if (this.sourceMode) {
      return false;
    }
    const { from, to } = this.normalized();
    if (from.block === to.block && from.offset === to.offset) {
      // A caret inside an existing link changes its target. At a bare caret
      // the dialog supplies the text for a new link.
      const link = this.linkAtCaret();
      const block = this.blocks[from.block];
      if (link && block && !isAtomicBlock(block) && block.type !== "code") {
        const runs = setHrefOnRuns(block.runs, link.from, link.to, href || null);
        this.commit(
          this.replaceBlock(from.block, { ...block, id: createBlockId(), runs }),
          this.anchor,
          this.focus,
        );
        return true;
      }
      if (href && label) {
        if (!block || isAtomicBlock(block) || block.type === "code") {
          return false;
        }
        const marks = this.pendingMarks || this.marksForTyping();
        const runs = insertRuns(block, from.offset, label, { ...marks, href });
        const caret = { block: from.block, offset: from.offset + label.length };
        this.commit(this.replaceBlock(from.block, { ...block, id: createBlockId(), runs }), caret, caret, {
          pendingMarks: { ...marks, href: "" },
        });
        return true;
      }
      this.pendingMarks = { ...this.activeMarks(), href: href || "" };
      this.sync();
      return true;
    }

    let blocks = this.blocks;
    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || isAtomicBlock(block) || block.type === "code") {
        continue;
      }
      const start = index === from.block ? from.offset : 0;
      const end = index === to.block ? to.offset : blockLength(block);
      blocks = blocks.slice();
      blocks[index] = { ...block, id: createBlockId(), runs: setHrefOnRuns(block.runs, start, end, href) };
    }
    this.commit(blocks, this.anchor, this.focus);
    return true;
  }

  clearFormatting() {
    if (this.sourceMode) {
      return;
    }
    if (this.isCollapsed()) {
      this.pendingMarks = {};
      this.sync();
      return;
    }
    const { from, to } = this.normalized();
    let blocks = this.blocks;
    for (let index = from.block; index <= to.block; index += 1) {
      const block = blocks[index];
      if (!block || isAtomicBlock(block) || block.type === "code") {
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
    const deletion = this.selectionDeletion({ forInsertion: true });
    const blocks = deletion ? deletion.blocks : this.blocks;
    const index = deletion ? deletion.caret.block : this.focus.block;
    const offset = deletion ? deletion.caret.offset : this.focus.offset;
    const current = blocks[index];

    if (!current || isAtomicBlock(current)) {
      const next = blocks.slice();
      next.splice(index + 1, 0, { ...block, id: createBlockId() });
      const paragraph = emptyParagraph();
      next.splice(index + 2, 0, paragraph);
      const caret = { block: index + 2, offset: 0 };
      this.commit(next, caret, caret);
      return;
    }

    const [head, tail] = splitBlockModel(current, offset);
    const next = blocks.slice();
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
    this.lineHint = null;
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
        if (this.sourceMode) {
          if (this.callbacks.onSourceFormat) {
            this.callbacks.onSourceFormat(lower === "b" ? "b" : lower === "i" ? "i" : "u");
          }
          return;
        }
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
        this.moveToDocumentEdge(key === "Home", shift);
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
        // A source line is one block, so Shift+Enter cannot put a line feed
        // inside it; it starts a new Markdown line just like Enter.
        if (shift && !this.sourceMode) {
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
      case "PageUp":
      case "PageDown":
        event.preventDefault();
        this.moveByPage(key === "PageUp" ? -1 : 1, shift);
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
        this.handleTab(shift ? -1 : 1);
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
    if (this.sourceMode) {
      this.insertParagraph();
      return;
    }
    const deletion = this.selectionDeletion({ forInsertion: true });
    const blocks = deletion ? deletion.blocks : this.blocks;
    const index = deletion ? deletion.caret.block : this.focus.block;
    const offset = deletion ? deletion.caret.offset : this.focus.offset;
    const block = blocks[index];
    if (!block || isAtomicBlock(block)) {
      if (deletion) {
        this.commit(deletion.blocks, deletion.caret, deletion.caret);
      }
      return;
    }
    const marks = block.type === "code" ? {} : this.pendingMarks || this.marksForTyping();
    const runs = insertRuns(block, offset, "\n", marks);
    const next = blocks.slice();
    next[index] = { ...block, id: createBlockId(), runs };
    const caret = { block: index, offset: offset + 1 };
    this.commit(next, caret, caret);
  }

  moveHorizontal(direction, extend) {
    this.lineHint = null;
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
    this.lineHint = null;
    let start = this.focus;
    if (!extend && !this.isCollapsed()) {
      const { from, to } = this.normalized();
      start = direction < 0 ? from : to;
    }
    const next = stepWord(this.blocks, start, direction, extend);
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

    const point = caretPoint(entry, this.focus.offset, this.lineHint);
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
        if (!isAtomicBlock(candidate.block) && candidate.lines.length) {
          targetEntry = candidate;
          targetLine = direction < 0 ? candidate.lines[candidate.lines.length - 1] : candidate.lines[0];
          break;
        }
        cursor += direction;
      }
    }

    let next;
    if (targetLine) {
      next = { block: targetEntry.index, offset: pointToOffset(targetEntry, x, targetLine.y + 1) };
    } else {
      const last = this.blocks.length - 1;
      next = direction < 0 ? { block: 0, offset: 0 } : { block: last, offset: blockLength(this.blocks[last]) };
    }
    // The offset at a soft wrap belongs to both lines; this move chose the
    // target line, so keep the caret there.
    this.lineHint = targetLine;
    if (extend) {
      this.setSelection(this.anchor, next, { keepMarks: true });
    } else {
      this.collapseTo(next);
    }
    this.afterMove();
  }

  // Page Up/Down move the caret one screen and scroll the view by the same
  // distance, so the caret keeps its place in the viewport. A text field moves
  // the caret a page first and then exposes it at the top of the view; keeping
  // the caret where it is reads more calmly and still pages a screen at a time.
  // When the jump would pass the document, the caret goes to its very edge,
  // which is what makes Page Up at the top reach the first character.
  moveByPage(direction, extend) {
    const point = this.layout ? this.caretGeometry() : null;
    const page = this.view.pageDistance();
    const target = point ? this.pageTarget(point.y + direction * page, point.x, direction) : null;
    if (!target) {
      if (point) {
        this.moveToDocumentEdge(direction < 0, extend);
      } else {
        // An image is selected: there is no caret to move, so scroll instead.
        this.view.scrollBy(direction * page);
      }
      return;
    }

    this.lineHint = target.line;
    // The page scrolls by the same distance, so the caret keeps its place on
    // screen. Sliding its document coordinates would make it streak instead.
    if (extend) {
      this.setSelection(this.anchor, target.position, { keepMarks: true, animateCaret: false });
    } else {
      this.collapseTo(target.position, { animateCaret: false });
    }

    this.view.scrollBy(target.line.y - point.y);
    this.afterMove();
  }

  // The line at the target y, or the nearest one in the direction of travel.
  // Pictures are skipped because a page move always lands where a caret fits.
  // Null means the page runs past the document in that direction.
  pageTarget(y, x, direction) {
    let previous = null;
    for (const entry of this.layout.blocks) {
      if (isAtomicBlock(entry.block)) {
        continue;
      }
      for (const line of entry.lines) {
        if (direction > 0) {
          if (line.y + line.height > y) {
            return this.pagePosition(entry, line, x);
          }
        } else if (line.y > y) {
          return previous ? this.pagePosition(previous.entry, previous.line, x) : null;
        }
        previous = { entry, line };
      }
    }
    return null;
  }

  pagePosition(entry, line, x) {
    const offset = pointToOffset(entry, x, line.y + 1);
    return { position: { block: entry.index, offset }, line };
  }

  moveToLineEdge(toEnd, extend) {
    if (!this.layout) {
      return;
    }
    const entry = blockEntry(this.layout, this.focus.block);
    const point = caretPoint(entry, this.focus.offset, this.lineHint);
    if (!entry || !point) {
      return;
    }
    const line = point.line;
    let offset = line.offsetStart || 0;
    if (line.fragments.length) {
      offset = toEnd ? line.fragments[line.fragments.length - 1].end : line.fragments[0].start;
    }
    const next = { block: entry.index, offset };
    this.lineHint = line;
    if (extend) {
      this.setSelection(this.anchor, next, { keepMarks: true });
    } else {
      this.collapseTo(next);
    }
    this.afterMove();
  }

  moveToDocumentEdge(toStart, extend) {
    this.lineHint = null;
    const last = this.blocks.length - 1;
    const edge = toStart
      ? { block: 0, offset: 0 }
      : { block: last, offset: blockLength(this.blocks[last]) };
    // The paper jumps to its edge below, so the caret must not slide across
    // the whole document while the viewport teleports.
    if (extend) {
      this.setSelection(this.anchor, edge, { keepMarks: true, animateCaret: false });
    } else {
      this.collapseTo(edge, { animateCaret: false });
    }
    this.view.scrollToPageEdge(toStart);
  }

  /* ---------------------------------------------------------------------
     Heading anchors
     --------------------------------------------------------------------- */

  // The derived anchor of the heading the caret sits in, or "" for any other
  // block. The document menu offers "Copy link to heading" only when this
  // returns something.
  headingAnchor() {
    if (!this.blocks[this.focus.block]) {
      return "";
    }
    return headingAnchors(this.blocks)[this.focus.block] || "";
  }

  // Jump to the heading whose derived anchor is `slug` (already decoded from a
  // URL fragment). The caret moves to the heading so typing continues there,
  // and the page scrolls it below the sticky header. Returns false when the
  // document has no such heading, so the caller can leave the view alone.
  goToAnchor(slug, options) {
    if (!slug) {
      return false;
    }
    const index = headingAnchors(this.blocks).indexOf(slug);
    if (index < 0 || !this.layout) {
      return false;
    }
    this.collapseTo({ block: index, offset: 0 }, { animateCaret: false });
    const entry = this.layout.blocks[index];
    if (!entry) {
      return true;
    }
    const rect = this.root.getBoundingClientRect();
    const top = Math.max(0, rect.top + window.scrollY + entry.top - ANCHOR_MARGIN);
    window.scrollTo({ top, behavior: options && options.smooth ? "smooth" : "instant" });
    return true;
  }

  deleteWordBackward() {
    if (this.deleteSelectionIfAny()) {
      return;
    }
    const position = this.focus;
    const block = this.blocks[position.block];
    if (!block || isAtomicBlock(block) || position.offset === 0) {
      this.backspace();
      return;
    }
    const text = blockText(block);
    const previous = previousWordStart(text, position.offset);
    if (previous === position.offset) {
      this.backspace();
      return;
    }
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

  applyInputCommand(inputType) {
    switch (inputType) {
      case "deleteContentBackward":
        this.backspace();
        break;
      case "deleteContentForward":
        this.deleteForward();
        break;
      case "deleteWordBackward":
        this.deleteWordBackward();
        break;
      // A textarea reports its ordinary Return as insertLineBreak. Only
      // Shift+Enter requests a hard break, handled by the keydown listener.
      case "insertLineBreak":
      case "insertParagraph":
        this.insertParagraph();
        break;
      case "historyUndo":
        this.undo();
        break;
      case "historyRedo":
        this.redo();
        break;
      default:
        return false;
    }
    return true;
  }

  handleInput(event) {
    if (this.composing || event?.isComposing) {
      return;
    }
    const value = this.textarea.value;
    this.textarea.value = "";
    if (this.applyInputCommand(event?.inputType) || !value) {
      return;
    }
    if (this.applyMarkdownShortcut(value)) {
      return;
    }
    this.insertText(value);
  }

  handleCompositionStart() {
    this.composing = true;
    this.view.setSpellingCaret(this.focus);
    const point = this.caretGeometry();
    if (point) {
      this.view.setComposition(point, "");
    }
  }

  handleCompositionUpdate(event) {
    const point = this.caretGeometry();
    if (point) {
      this.view.setComposition(point, event.data);
    }
  }

  handleCompositionEnd(event) {
    this.composing = false;
    this.view.hideComposition();
    this.textarea.value = "";
    if (event.data) {
      this.insertText(event.data);
    } else {
      this.view.setSpellingCaret(this.typing ? this.focus : null);
    }
  }

  handleCopy(event, cut) {
    if (this.isCollapsed()) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", this.selectionText());
    // The rendered view also offers the selection as semantic HTML, so another
    // program (or Grapho itself) can keep the formatting. Markdown source is
    // plain lines, so its copy stays plain text.
    if (!this.sourceMode) {
      const { from, to } = this.normalized();
      const html = selectionHtml(this.blocks, from, to);
      if (html) {
        event.clipboardData.setData("text/html", html);
      }
    }
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
    // Rich paste is for the rendered view only; Markdown source lines are plain
    // text, and insertBlocks reduces rich content for code blocks too.
    const html = this.sourceMode ? "" : clipboard.getData("text/html");
    if (html) {
      const pasted = blocksFromPastedHtml(html);
      if (pasted && pasted.length) {
        event.preventDefault();
        this.insertBlocks(pasted);
        return;
      }
    }
    const text = clipboard.getData("text/plain");
    if (text) {
      event.preventDefault();
      this.insertText(text, undefined, { coalesce: false });
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

  handleContextMenu(event) {
    // A picture's context menu is the editor's image menu; the browser's own
    // menu has none of these actions. Select the image first so the menu's
    // actions and the arrow keys apply to the picture that was right-clicked.
    if (!event.target.closest(".doc-image")) {
      return;
    }
    const entry = this.imageEntryAt(event.clientX, event.clientY);
    if (!entry) {
      return;
    }
    event.preventDefault();
    const position = { block: entry.index, offset: 0 };
    this.setSelection(position, position);
    this.focusEditor();
    if (this.callbacks.onImageSelect) {
      this.callbacks.onImageSelect(entry);
    }
  }

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
        if (event.shiftKey) {
          this.focusEditor();
        } else {
          this.setSelection(position, position);
          this.focusEditor();
        }
        // Shift on the press means either extending the text selection to the
        // image or locking the drag to one axis. A click never moves, so the
        // release decides which gesture it was.
        this.imageDrag = {
          blockIndex: entry.index,
          startX: event.clientX,
          startY: event.clientY,
          startImage: { ...entry.image },
          anchorTop: entry.top,
          moved: false,
          extend: event.shiftKey,
          axis: null,
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
    // Touch actions can open without calling up the phone keyboard.
    const touchAction = event.pointerType === "touch" && (link || this.view.spellingAtPoint(event));
    if (!touchAction || event.shiftKey) {
      this.focusEditor();
    }
    const position = this.positionFromEvent(event);
    const extend = event.shiftKey;
    this.pointer = { anchor: extend ? { ...this.anchor } : position };
    if (extend) {
      this.setSelection(this.anchor, position, { keepMarks: true });
    } else {
      this.collapseTo(position);
    }
  }

  handlePointerMove(event) {
    // A pointer released outside the window sends no pointerup here. Without
    // this, an ordinary mouse move would go on dragging the old selection (or
    // the old image) and text would feel impossible to select.
    if (event.buttons === 0 && (this.pointer || this.imageDrag || this.imageResize)) {
      this.handlePointerUp();
      return;
    }
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
      } else if (drag.extend) {
        // The Shift press never moved, so it was the ordinary extend-selection
        // click on the image rather than a constrained drag.
        const position = { block: drag.blockIndex, offset: 0 };
        this.setSelection(drag.snapshot.anchor, position, { keepMarks: true });
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
      if (drag.extend) {
        // The Shift press turned into a drag after all, so the image becomes
        // the selection; the snapshot keeps the old one for undo.
        const position = { block: drag.blockIndex, offset: 0 };
        this.setSelection(position, position);
      }
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

    // Shift locks the move to the axis the pointer set off along, so the image
    // slides along one line instead of drifting. Releasing Shift frees the
    // move again, and pressing it again picks the axis from the movement so
    // far.
    let nextX = drag.startImage.x + dx;
    let nextY = drag.startImage.y + dy;
    if (event.shiftKey) {
      drag.axis = drag.axis || (Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
      if (drag.axis === "x") {
        nextY = drag.startImage.y;
      } else {
        nextX = drag.startImage.x;
      }
    } else {
      drag.axis = null;
    }

    const x = clamp(nextX, 0, Math.max(0, columnWidth - width));
    const desiredTop = Math.max(contentTop(), nextY);

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
    const position = this.positionFromEvent(event, { character: true });
    const block = this.blocks[position.block];
    if (!block || isAtomicBlock(block)) {
      return;
    }
    const text = blockText(block);
    for (const part of wordSegments(text)) {
      const end = part.index + part.segment.length;
      if (position.offset < end) {
        this.setSelection({ block: position.block, offset: part.index }, { block: position.block, offset: end });
        this.focusEditor();
        return;
      }
    }
  }

  // Three clicks select the whole line under the pointer, as a native text
  // field does: the text between hard breaks, or the whole block when it has
  // none. The line's own hard break is part of the selection, so replacing the
  // selection replaces the line rather than leaving a blank one behind. A
  // fourth click in the same gesture selects the whole document, like Ctrl+A.
  // A picture has no line to select, and Shift+click is still an ordinary
  // extend.
  handleClickCount(event) {
    if (
      event.detail < 3 ||
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    if (event.detail > 3) {
      this.selectAll();
      this.focusEditor();
      return;
    }
    const position = this.positionFromEvent(event);
    const block = this.blocks[position.block];
    if (!block || isAtomicBlock(block)) {
      return;
    }
    const text = blockText(block);
    const { start, end } = lineRangeAt(text, position.offset);
    if (start === end) {
      this.focusEditor();
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

  positionFromEvent(event, options) {
    if (!this.layout) {
      return { block: 0, offset: 0 };
    }
    const rect = this.root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const entry = entryAtY(this.layout, y);
    if (!entry) {
      this.lineHint = null;
      const last = this.blocks.length - 1;
      return { block: last, offset: blockLength(this.blocks[last]) };
    }
    if (isAtomicBlock(entry.block)) {
      this.lineHint = null;
      return { block: entry.index, offset: 0 };
    }
    // A click belongs to the line under the pointer, which resolves the shared
    // offset at a soft wrap in that line's favour.
    this.lineHint = lineAtY(entry, y);
    return { block: entry.index, offset: pointToOffset(entry, x, y, options) };
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

function spellingCorrectionRuns(runs, word, correction) {
  if (runs.length === 1) return [{ ...runs[0], text: correction }];

  const before = graphemeBoundaries(word);
  const after = graphemeBoundaries(correction);
  const oldCount = before.length - 1;
  const newCount = after.length - 1;
  const matches = (a, b) => word.slice(before[a], before[a + 1]) === correction.slice(after[b], after[b + 1]);
  let prefix = 0;
  let suffix = 0;
  while (prefix < Math.min(oldCount, newCount) && matches(prefix, prefix)) prefix += 1;
  while (prefix + suffix < Math.min(oldCount, newCount) && matches(oldCount - 1 - suffix, newCount - 1 - suffix)) {
    suffix += 1;
  }

  // Keep the marks on unchanged letters at either end. Align boundaries in
  // the edited middle by grapheme so a correction never splits an accent.
  let offset = 0;
  let start = 0;
  return runs.map((run, index) => {
    offset += run.text.length;
    const oldBoundary = before.findIndex((boundary) => boundary >= offset);
    let newBoundary = oldBoundary;
    if (index === runs.length - 1 || oldBoundary >= oldCount - suffix) {
      newBoundary = index === runs.length - 1 ? newCount : newCount - (oldCount - oldBoundary);
    } else if (oldBoundary > prefix) {
      const ratio = (oldBoundary - prefix) / (oldCount - prefix - suffix);
      newBoundary = prefix + Math.round(ratio * (newCount - prefix - suffix));
    }
    const end = after[newBoundary];
    const result = { ...run, text: correction.slice(start, end) };
    start = end;
    return result;
  });
}

function insertRuns(block, offset, text, marks) {
  const { left, right } = splitRuns(block.runs, offset);
  return normalizeRuns([...left, { text, ...marks }, ...right]);
}

// Insert existing runs (with their own marks) at an offset of one block.
function insertRunList(block, offset, runs) {
  const { left, right } = splitRuns(block.runs, offset);
  return normalizeRuns([...left, ...runs, ...right]);
}

// A pasted paragraph joins the line at the caret. Alignment, legacy indent, and
// the other block types belong to a whole block, so they are not joined.
function isPlainParagraph(block) {
  return Boolean(block) && block.type === "p" && !block.align && !block.indent;
}

// Rich content reduced to the lines a code block or a Markdown source line can
// hold: marks and block types have no place there.
function pastedPlainText(blocks) {
  return blocks.map((block) => (isAtomicBlock(block) ? "" : blockText(block))).join("\n");
}

// Start offsets of the lines in a block's text: the text start, and every
// offset just after a line feed.
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineIndexAt(starts, offset) {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) {
    line += 1;
  }
  return line;
}

// How much indentation one Shift+Tab takes off a line: a tab, or up to four
// spaces.
function outdentLength(text, start) {
  if (text[start] === "\t") {
    return 1;
  }
  let count = 0;
  while (count < TAB_TEXT.length && text[start + count] === " ") {
    count += 1;
  }
  return count;
}

// One Tab/Shift+Tab level for a list item, keeping its text. Taking a
// top-level item out of a list turns it into a paragraph, as it always has.
function nestListBlock(block, direction) {
  const depth = block.depth + direction;
  if (depth < 0) {
    return { ...block, id: createBlockId(), type: "p", ordered: false, depth: 0 };
  }
  const clamped = Math.min(depth, LIST_DEPTH_LIMIT);
  return clamped === block.depth ? block : { ...block, id: createBlockId(), depth: clamped };
}

// Older documents keep their paragraph indent as the `data-indent` attribute.
// The editor no longer creates one, but Shift+Tab can still take a step off.
function reduceBlockIndent(block) {
  const indent = blockIndent(block);
  if (indent <= 0) {
    return null;
  }
  const next = { ...block, id: createBlockId() };
  if (indent === 1) {
    delete next.indent;
  } else {
    next.indent = indent - 1;
  }
  return next;
}

// Insert or remove one tab stop at the start of each selected line of one
// block, and report the edits so the selection can move with the text.
function shiftLines(block, from, to, index, direction) {
  const text = blockText(block);
  const starts = lineStarts(text);
  let first = 0;
  let last = starts.length - 1;
  if (index === from.block) {
    first = lineIndexAt(starts, from.offset);
  }
  if (index === to.block) {
    last = lineIndexAt(starts, to.offset);
    // A selection that ends exactly at a line start leaves that line alone,
    // the way a code editor treats a selection dragged to the next line.
    if (to.offset === starts[last]) {
      last -= 1;
    }
  }
  if (last < first) {
    return null;
  }

  const added = direction > 0 ? (block.type === "code" ? "\t" : TAB_TEXT) : "";
  let runs = block.runs;
  const edits = [];
  for (let line = last; line >= first; line -= 1) {
    const start = starts[line];
    if (direction > 0) {
      runs = insertRuns({ runs }, start, added, {});
      edits.push({ offset: start, delta: added.length });
      continue;
    }
    const count = outdentLength(text, start);
    if (count > 0) {
      runs = removeRangeFromRuns(runs, start, start + count);
      edits.push({ offset: start, delta: -count });
    }
  }
  if (!edits.length) {
    return null;
  }
  edits.sort((a, b) => a.offset - b.offset);
  return { block: { ...block, id: createBlockId(), runs }, edits };
}

// Move one selection offset through the line edits of its block. Indentation
// inserted before the offset pushes it right; indentation removed before it
// pulls it left, and an offset inside the removed run lands on its start.
function mapOffsetThroughEdits(offset, edits) {
  let shift = 0;
  for (const edit of edits) {
    if (edit.delta > 0) {
      if (offset < edit.offset) {
        break;
      }
      shift += edit.delta;
      continue;
    }
    const end = edit.offset - edit.delta;
    if (offset <= edit.offset) {
      break;
    }
    if (offset < end) {
      return edit.offset + shift;
    }
    shift += edit.delta;
  }
  return offset + shift;
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
      return { block: cursor, offset: isAtomicBlock(block) ? 0 : blockLength(block) };
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
  if (isAtomicBlock(block)) {
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
    while (index >= 0 && isAtomicBlock(blocks[index])) {
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
  while (index < blocks.length && isAtomicBlock(blocks[index])) {
    index += 1;
  }
  if (index >= blocks.length) {
    return { block: blocks.length - 1, offset: blockLength(blocks[blocks.length - 1]) };
  }
  return { block: index, offset: 0 };
}

function stepWord(blocks, position, direction, extend) {
  const block = blocks[position.block];
  if (!block || isAtomicBlock(block)) {
    return stepPosition(blocks, position, direction);
  }
  const text = blockText(block);
  if (direction < 0) {
    if (position.offset === 0) {
      return stepPosition(blocks, position, -1);
    }
    return { block: position.block, offset: previousWordStart(text, position.offset) };
  }
  if (position.offset >= text.length) {
    return stepPosition(blocks, position, 1);
  }
  return { block: position.block, offset: nextWordBoundary(text, position.offset, extend) };
}

function wordStarts(text) {
  const starts = [];
  for (const part of wordSegments(text)) {
    if (part.isWordLike) {
      starts.push(part.index);
    }
  }
  return starts;
}

function previousWordStart(text, offset) {
  const starts = wordStarts(text);
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    if (starts[index] < offset) {
      return starts[index];
    }
  }
  return 0;
}

function nextWordBoundary(text, offset, extend) {
  // A forward selection ends with the word. Caret movement continues to the
  // start of the next word.
  for (const part of wordSegments(text)) {
    if (!part.isWordLike) {
      continue;
    }
    const boundary = extend ? part.index + part.segment.length : part.index;
    if (boundary > offset) {
      return boundary;
    }
  }
  return text.length;
}

let wordSegmenter = null;
let wordChecked = false;

function ensureWordSegmenter() {
  if (!wordChecked) {
    wordChecked = true;
    try {
      wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
    } catch (error) {
      wordSegmenter = null;
    }
  }
  return wordSegmenter;
}

function wordSegments(text) {
  if (ensureWordSegmenter()) {
    return wordSegmenter.segment(text);
  }
  // Without dictionary segmentation, group consecutive letters and numbers
  // into words. Classify whole graphemes so an accent or emoji stays intact.
  const points = graphemeBoundaries(text);
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    const index = points[i - 1];
    const segment = text.slice(index, points[i]);
    const isWordLike = /[\p{L}\p{N}\p{Pc}]/u.test(segment);
    const previous = segments.at(-1);
    if (isWordLike && previous?.isWordLike) {
      previous.segment += segment;
    } else {
      segments.push({ index, segment, isWordLike });
    }
  }
  return segments;
}

// The line holding an offset: from the start of the text after the previous
// hard break through the end of the following one, if there is one. Whether
// the line wraps on the paper is a layout question; a line here is the writer's
// line, which is what a click count of three selects in a text field.
function lineRangeAt(text, offset) {
  const start = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
  const next = text.indexOf("\n", offset);
  return { start, end: next === -1 ? text.length : next + 1 };
}

function* selectedTextRanges(blocks, from, to) {
  for (let index = from.block; index <= to.block; index += 1) {
    const block = blocks[index];
    const start = index === from.block ? from.offset : 0;
    const end = index === to.block ? to.offset : blockLength(block);
    if (start < end) {
      yield { block, index, start, end };
    }
  }
}

function selectionHasMark(ranges, key) {
  let hasWords = false;
  let allWhitespaceMarked = true;
  for (const { block, start, end } of ranges) {
    for (const run of runsInRange(block, start, end)) {
      if (run.text.trim()) {
        hasWords = true;
        if (!run[key]) {
          return false;
        }
      } else if (!run[key]) {
        allWhitespaceMarked = false;
      }
    }
  }
  return hasWords || allWhitespaceMarked;
}
