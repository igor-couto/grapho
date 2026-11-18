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
  emptyParagraph,
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
const HEADING_TYPES = new Set(["h1", "h2", "h3"]);
// Markdown line shortcuts in the rendered editor. The complete line prefix,
// space included, maps to the block it starts; nothing above Heading 3 exists.
const MARKDOWN_SHORTCUTS = new Map([
  ["- ", "list"],
  ["# ", "h1"],
  ["## ", "h2"],
  ["### ", "h3"],
]);
// Tab types four spaces at the caret in a paragraph. A selection gets one tab
// stop at the start of every line it touches instead, the way a code editor
// indents a block of text.
const TAB_TEXT = "    ";

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
    this.root.addEventListener("click", (event) => this.handleTripleClick(event));

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
    this.pendingSourceMarks = null;
    this.undoStack = [];
    this.redoStack = [];
    this.typing = null;
    this.lineHint = null;
    this.width = this.root.clientWidth || 640;
    this.relayout();
    this.sync();
  }

  getDocument() {
    return this.blocks;
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

  /* ---------------------------------------------------------------------
     Layout and painting
     --------------------------------------------------------------------- */

  relayout() {
    const width = this.width || this.root.clientWidth || 640;
    this.layout = layoutDocument(this.blocks, width);
    this.view.setLayout(this.layout, this.blocks);
  }

  sync(options) {
    const settings = options || {};
    this.clampSelection();
    const collapsed = this.isCollapsed();
    const entry = this.layout ? blockEntry(this.layout, this.focus.block) : null;

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
    if (entry.block.type === "image") {
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
    const point = entry && entry.block.type !== "image" ? caretPoint(entry, saved.offset, this.lineHint) : null;
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
    this.lineHint = null;

    if (settings.coalesce) {
      this.typing = { time: Date.now() };
    } else {
      this.typing = null;
    }
    if (settings.keepMarks !== true) {
      this.pendingMarks = null;
      this.pendingSourceMarks = null;
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
    this.pendingSourceMarks = null;
    this.lineHint = null;
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
  // "# ", "## ", or "### " at the start of a block turns the block into a
  // bullet item or the matching heading and consumes the marker, so the caret
  // continues in the new style. Text already after the caret belongs to the
  // converted block; a marker anywhere else on the line, a code block, and
  // Markdown source stay literal. Pasting never runs this.
  applyMarkdownShortcut(typed) {
    if (this.sourceMode || !this.isCollapsed()) {
      return false;
    }
    // Every marker is at most "### " long and must start at offset 0, so a
    // caret deeper in the block skips the text work below on every keystroke.
    const offset = this.focus.offset;
    if (offset + typed.length > 4) {
      return false;
    }
    const index = this.focus.block;
    const block = this.blocks[index];
    if (!block || block.type === "image" || block.type === "code") {
      return false;
    }
    const type = MARKDOWN_SHORTCUTS.get(blockText(block).slice(0, offset) + typed);
    if (!type) {
      return false;
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

  insertText(text, overrideMarks) {
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
        this.insertText(wrapped.text);
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
    const deletion = this.selectionDeletion();
    let caret = deletion ? { ...deletion.caret } : { ...this.focus };
    let blocks = deletion ? deletion.blocks : this.blocks;

    // A collapsed caret can sit on an image block (a click selects it). Typing
    // then replaces the image with a paragraph at the same position.
    if (blocks[caret.block] && blocks[caret.block].type === "image") {
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
      this.commit(next, caret, caret, { coalesce: true, keepMarks: true });
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
    this.commit(blocks, caret, caret, { coalesce: true, keepMarks: true });
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
    const target = this.blocks[this.focus.block];
    if (this.sourceMode || !target || target.type === "code") {
      this.insertText(pastedPlainText(pasted));
      return;
    }

    const deletion = this.selectionDeletion();
    let blocks = deletion ? deletion.blocks : this.blocks;
    let caret = deletion ? { ...deletion.caret } : { ...this.focus };

    // A picture caret is replaced by a paragraph, the same way typing over a
    // selected picture works; the paste then lands in that paragraph. A caret
    // that only landed on a picture because the deleted selection ended next to
    // it must not replace that picture: the paste goes after it instead.
    if (blocks[caret.block] && blocks[caret.block].type === "image") {
      blocks = blocks.slice();
      if (deletion) {
        blocks.splice(caret.block + 1, 0, emptyParagraph());
        caret = { block: caret.block + 1, offset: 0 };
      } else {
        blocks[caret.block] = emptyParagraph();
        caret = { block: caret.block, offset: 0 };
      }
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
    let mergedLast = false;
    let mergedLastLength = 0;

    // A pasted paragraph at either edge joins the line it was pasted onto, so
    // pasting "one\ntwo" mid-paragraph continues the sentence instead of
    // leaving ragged half-paragraphs. Headings and list items stay separate.
    if (isPlainParagraph(body[0])) {
      const edge = body.shift();
      first = { ...first, id: createBlockId(), runs: normalizeRuns([...first.runs, ...edge.runs]) };
    }
    if (body.length && isPlainParagraph(body[body.length - 1])) {
      const edge = body.pop();
      mergedLast = true;
      mergedLastLength = blockLength(edge);
      last = { ...last, id: createBlockId(), runs: normalizeRuns([...edge.runs, ...last.runs]) };
    }

    // An empty half left over from splitting at the very start or end of a
    // block is not a pasted blank line; it is where the caret already was.
    const keepFirst = blockLength(first) > 0 || body.length === 0;
    const keepLast = blockLength(last) > 0 || body.length === 0;
    const replacement = [];
    if (keepFirst) {
      replacement.push(first);
    }
    const bodyStart = replacement.length;
    replacement.push(...body);
    if (keepLast) {
      replacement.push(last);
    }

    const next = blocks.slice();
    next.splice(caret.block, 1, ...replacement);

    let position = { block: caret.block, offset: 0 };
    if (mergedLast && keepLast) {
      position = { block: caret.block + replacement.length - 1, offset: mergedLastLength };
    } else if (body.length) {
      position = {
        block: caret.block + bodyStart + body.length - 1,
        offset: blockLength(body[body.length - 1]),
      };
    } else if (keepFirst) {
      position = { block: caret.block, offset: blockLength(first) };
    }

    // A picture has no caret. A paste that ends on one and stops the document
    // gets a paragraph to continue writing in; if the split tail follows it, the
    // caret belongs at the start of that text and no paragraph is needed.
    if (next[position.block] && next[position.block].type === "image") {
      if (position.block === next.length - 1) {
        next.push(emptyParagraph());
        position = { block: next.length - 1, offset: 0 };
      } else {
        position = { block: position.block + 1, offset: 0 };
      }
    }
    this.commit(next, position, position);
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

  // The blocks and caret that result from deleting the current selection, or
  // null when it is collapsed. Callers that insert something immediately use
  // this so the delete and the insert share one commit and one undo step.
  selectionDeletion() {
    if (this.isCollapsed()) {
      return null;
    }
    const { from, to } = this.normalized();
    const first = this.blocks[from.block];
    const last = this.blocks[to.block];

    if (from.block === to.block) {
      if (first.type === "image") {
        const next = this.blocks.slice();
        next.splice(from.block, 1);
        const caret = previousPosition(next, from.block);
        return { blocks: next.length ? next : [emptyParagraph()], caret };
      }
      const block = { ...first, id: createBlockId(), runs: removeRangeFromRuns(first.runs, from.offset, to.offset) };
      return { blocks: this.replaceBlock(from.block, block), caret: from };
    }

    const headLength = from.offset;
    if (first.type === "image" && last.type === "image") {
      const next = this.blocks.slice();
      next.splice(from.block, to.block - from.block + 1);
      const caret = previousPosition(next, from.block);
      return { blocks: next.length ? next : [emptyParagraph()], caret };
    }
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
    const deletion = this.selectionDeletion();
    const blocks = deletion ? deletion.blocks : this.blocks;
    const index = deletion ? deletion.caret.block : this.focus.block;
    const offset = deletion ? deletion.caret.offset : this.focus.offset;
    const block = blocks[index];
    if (!block) {
      if (deletion) {
        this.commit(deletion.blocks, deletion.caret, deletion.caret);
      }
      return;
    }

    if (block.type === "image") {
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
    if (this.sourceMode) {
      return;
    }
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
    if (this.sourceMode) {
      return;
    }
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
    if (!block || block.type === "image") {
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
      if (!block || block.type === "image") {
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
    if (!block || block.type === "image") {
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

  setLink(href) {
    if (this.sourceMode) {
      return;
    }
    const { from, to } = this.normalized();
    if (from.block === to.block && from.offset === to.offset) {
      // A caret inside an existing link changes that link, which is how the
      // link dialog's Edit state works. A bare caret instead arms the marks
      // for whatever is typed next.
      const link = this.linkAtCaret();
      const block = this.blocks[from.block];
      if (link && block && block.type !== "image" && block.type !== "code") {
        const runs = setHrefOnRuns(block.runs, link.from, link.to, href || null);
        this.commit(
          this.replaceBlock(from.block, { ...block, id: createBlockId(), runs }),
          this.anchor,
          this.focus,
        );
        return;
      }
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
    const deletion = this.selectionDeletion();
    const blocks = deletion ? deletion.blocks : this.blocks;
    const index = deletion ? deletion.caret.block : this.focus.block;
    const offset = deletion ? deletion.caret.offset : this.focus.offset;
    const current = blocks[index];

    if (!current || current.type === "image") {
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
    const deletion = this.selectionDeletion();
    const blocks = deletion ? deletion.blocks : this.blocks;
    const index = deletion ? deletion.caret.block : this.focus.block;
    const offset = deletion ? deletion.caret.offset : this.focus.offset;
    const block = blocks[index];
    if (!block || block.type === "image") {
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
        if (candidate.block.type !== "image" && candidate.lines.length) {
          targetEntry = candidate;
          targetLine = direction < 0 ? candidate.lines[candidate.lines.length - 1] : candidate.lines[0];
          break;
        }
        cursor += direction;
      }
    }

    if (!targetLine) {
      this.lineHint = null;
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
      if (entry.block.type === "image") {
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

  handleInput() {
    if (this.composing) {
      return;
    }
    const value = this.textarea.value;
    this.textarea.value = "";
    if (!value) {
      return;
    }
    if (this.applyMarkdownShortcut(value)) {
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
    this.focusEditor();
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

  // Three clicks select the whole line under the pointer, as a native text
  // field does: the text between hard breaks, or the whole block when it has
  // none. The line's own hard break is part of the selection, so replacing the
  // selection replaces the line rather than leaving a blank one behind. A
  // picture has no line to select, and Shift+click is still an ordinary extend.
  handleTripleClick(event) {
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
    const position = this.positionFromEvent(event);
    const block = this.blocks[position.block];
    if (!block || block.type === "image") {
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

  positionFromEvent(event) {
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
    if (entry.block.type === "image") {
      this.lineHint = null;
      return { block: entry.index, offset: 0 };
    }
    // A click belongs to the line under the pointer, which resolves the shared
    // offset at a soft wrap in that line's favour.
    this.lineHint = lineAtY(entry, y);
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
  return blocks.map((block) => (block.type === "image" ? "" : blockText(block))).join("\n");
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
  return { block: position.block, offset: nextWordStart(text, position.offset) };
}

// Starts of the word-like segments, so word navigation skips the spaces and
// punctuation between words instead of stopping on every segment edge.
function wordStarts(text) {
  const starts = [];
  if (!ensureWordSegmenter()) {
    return starts;
  }
  for (const part of wordSegmenter.segment(text)) {
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

function nextWordStart(text, offset) {
  const starts = wordStarts(text);
  for (const start of starts) {
    if (start > offset) {
      return start;
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

function wordBoundaries(text) {
  if (!ensureWordSegmenter()) {
    return graphemeBoundaries(text);
  }
  const points = [0];
  for (const part of wordSegmenter.segment(text)) {
    points.push(part.index + part.segment.length);
  }
  return points;
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
