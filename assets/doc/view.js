// View: paints a layout into the page and keeps the caret and selection in
// sync. Only blocks whose geometry or text changed are rebuilt.

import { blockLength, imageRadius } from "./model.js";
import { dividerLineY, entryAtY, fontFor, fragmentTextWidth, textWidth } from "./layout.js";

const HANDLE_CORNERS = [
  ["nw", 0, 0],
  ["ne", 1, 0],
  ["sw", 0, 1],
  ["se", 1, 1],
];

// The strip the caret keeps clear at the top and bottom of the viewport. Page
// Up/Down measures its jump against the same strip, so the caret ends where it
// started on screen instead of drifting towards an edge.
const CARET_MARGIN = 90;

export class EditorView {
  constructor(root) {
    this.root = root;
    this.content = root.querySelector(".doc-content");
    this.overlay = root.querySelector(".doc-overlay");
    this.caret = root.querySelector(".doc-caret");
    this.composition = null;
    this.layout = null;
    this.blocks = null;
    this.views = new Map();
    this.selectionElements = [];
    this.passage = null;
    this.caretPoint = null;
    this.spellingRanges = new WeakMap();
    this.spellingCaret = null;
    this.ignoredSpelling = new Set();
  }

  setLayout(layout, blocks) {
    const previousBlocks = this.blocks;
    this.layout = layout;
    this.blocks = blocks;
    this.root.style.height = layout.height + "px";
    this.content.style.height = layout.height + "px";

    const seen = new Set();

    layout.blocks.forEach((entry, index) => {
      const signature = this.signature(entry, blocks[index]);
      seen.add(index);
      let view = this.views.get(index);

      if (!view) {
        view = { element: document.createElement("div"), signature: null, spelling: [] };
        view.element.className = "doc-block";
        this.views.set(index, view);
        this.content.appendChild(view.element);
      }

      // Image edits replace the block. Comparing its identity catches pixel
      // and alt-text changes without hashing a data URL on every keystroke.
      if (view.signature !== signature || (entry.image && previousBlocks?.[index] !== blocks[index])) {
        this.paintBlock(view, entry, blocks[index]);
        view.signature = signature;
        this.paintSpelling(index);
      } else if (previousBlocks?.[index] !== blocks[index]) {
        this.paintSpelling(index);
      }
    });

    for (const [index, view] of this.views) {
      if (!seen.has(index)) {
        view.element.remove();
        this.views.delete(index);
      }
    }
    if (this.passage) {
      if (this.passage.blocks === blocks) this.paintSearchPassage();
      else this.clearSearchPassage();
    }
  }

  setSpelling(index, ranges) {
    this.spellingRanges.set(this.blocks[index], ranges);
    this.paintSpelling(index);
  }

  clearSpelling() {
    this.spellingRanges = new WeakMap();
    for (const [index, view] of this.views) {
      if (view.spelling.length) this.paintSpelling(index);
    }
  }

  paintSpelling(index) {
    const view = this.views.get(index);
    for (const { element } of view.spelling) element.remove();
    view.spelling = [];
    const ranges = this.spellingRanges.get(this.blocks[index]);
    if (!ranges?.length) return;

    const entry = this.layout.blocks[index];
    let first = 0;
    const markers = document.createDocumentFragment();
    for (const line of entry.lines) {
      if (!line.fragments.length) continue;
      const lineStart = line.fragments[0].start;
      const lineEnd = line.fragments.at(-1).end;
      while (ranges[first]?.end <= lineStart) first += 1;
      for (let i = first; ranges[i]?.start < lineEnd; i += 1) {
        const range = ranges[i];
        const rect = textRangeRect(line, range.start, range.end);
        if (!rect) continue;
        rect.y -= entry.top;
        const element = rangeRectangle(rect, "doc-spelling-mark");
        element.setAttribute("aria-hidden", "true");
        view.spelling.push({ index, range, element });
        markers.appendChild(element);
      }
    }
    view.element.appendChild(markers);
    this.updateSpellingVisibility(index);
  }

  setSpellingCaret(position) {
    const previous = this.spellingCaret;
    if (previous?.block === position?.block && previous?.offset === position?.offset) return;
    this.spellingCaret = position;
    if (previous) this.updateSpellingVisibility(previous.block);
    if (position && position.block !== previous?.block) this.updateSpellingVisibility(position.block);
  }

  ignoreSpelling(word) {
    this.ignoredSpelling.add(spellingKey(word));
    for (const index of this.views.keys()) this.updateSpellingVisibility(index);
  }

  updateSpellingVisibility(index) {
    const offset = this.spellingCaret?.block === index ? this.spellingCaret.offset : -1;
    for (const { range, element } of this.views.get(index)?.spelling || []) {
      const hidden = (range.start < offset && offset <= range.end) || this.ignoredSpelling.has(spellingKey(range.word));
      if (element.hidden !== hidden) element.hidden = hidden;
    }
  }

  spellingAtCaret(position) {
    return this.views.get(position.block)?.spelling.find(({ range, element }) =>
      !element.hidden && range.start <= position.offset && position.offset <= range.end);
  }

  spellingAtPoint({ clientX, clientY }) {
    if (!this.layout) return null;
    const root = this.root.getBoundingClientRect();
    const entry = entryAtY(this.layout, clientY - root.top);
    return this.views.get(entry?.index)?.spelling.find(({ element }) => {
      if (element.hidden) return false;
      const rect = element.getBoundingClientRect();
      return rect.left <= clientX && clientX < rect.right && rect.top <= clientY && clientY < rect.bottom;
    });
  }

  signature(entry, block) {
    const parts = [entry.top, entry.height, block ? block.type : "", block ? block.mode || "" : ""];
    if (entry.divider) {
      parts.push("d");
    }
    if (entry.image) {
      parts.push(
        "i",
        entry.image.x,
        entry.image.y,
        entry.image.width,
        entry.image.height,
        imageRadius(block),
      );
    }
    for (const line of entry.lines) {
      parts.push("l", line.y, line.x, line.height, line.text || "");
      for (const fragment of line.fragments) {
        parts.push(
          fragment.text,
          fragment.x,
          fragment.runIndex,
          fragment.start,
          fragment.gap,
          fragment.spaceExtra,
          fragment.marks.b ? 1 : 0,
          fragment.marks.i ? 1 : 0,
          fragment.marks.u ? 1 : 0,
          fragment.marks.s ? 1 : 0,
          fragment.marks.code ? 1 : 0,
          fragment.marks.href || "",
        );
      }
    }
    parts.push(entry.marker ? "m" + entry.marker.text : "");
    return parts.join("\u0001");
  }

  paintBlock(view, entry, block) {
    const element = view.element;
    element.className = "doc-block" + (entry.quote ? " is-quote" : "") + (entry.divider ? " is-divider" : "");
    element.style.top = entry.top + "px";
    element.style.height = (entry.height || 0) + "px";
    element.textContent = "";

    if (entry.divider) {
      const rule = document.createElement("div");
      rule.className = "doc-divider-rule";
      rule.style.top = dividerLineY(entry) - entry.top + "px";
      element.appendChild(rule);
    }

    if (entry.quote) {
      const rule = document.createElement("div");
      rule.className = "doc-quote-rule";
      rule.style.height = Math.max(entry.height, 20) + "px";
      element.appendChild(rule);
    }

    if (entry.box) {
      const box = document.createElement("div");
      box.className = "doc-code-box";
      box.style.top = entry.box.y - entry.top + "px";
      box.style.left = entry.box.x + "px";
      box.style.width = entry.box.width + "px";
      box.style.height = entry.box.height + "px";
      element.appendChild(box);
    }

    if (entry.image) {
      const image = document.createElement("img");
      image.className = "doc-image";
      image.src = block.src;
      image.alt = block.alt || "";
      image.draggable = false;
      image.style.left = entry.image.x + "px";
      image.style.top = entry.image.y - entry.top + "px";
      image.style.width = entry.image.width + "px";
      image.style.height = entry.image.height + "px";
      image.style.borderRadius = imageRadius(block) + "px";
      element.appendChild(image);
    }

    for (const line of entry.lines) {
      const lineElement = document.createElement("div");
      lineElement.className = "doc-line " + lineClass(block);
      lineElement.style.left = line.x + "px";
      lineElement.style.top = line.y - entry.top + "px";

      if (line.code) {
        lineElement.textContent = line.text;
      } else {
        for (const fragment of line.fragments) {
          if (fragment.gap > 0) {
            const gap = document.createElement("span");
            gap.className = "doc-gap";
            gap.style.width = fragment.gap + "px";
            lineElement.appendChild(gap);
          }
          const span = document.createElement("span");
          span.className = fragmentClass(fragment);
          span.textContent = fragment.text;
          if (fragment.spaceExtra > 0) {
            span.style.wordSpacing = fragment.spaceExtra + "px";
          }
          if (fragment.marks && fragment.marks.href) {
            span.dataset.href = fragment.marks.href;
            span.dataset.end = fragment.end;
          }
          lineElement.appendChild(span);
        }
      }

      element.appendChild(lineElement);
    }

    if (entry.marker) {
      const marker = document.createElement("div");
      marker.className = "doc-marker" + (block.ordered ? " is-number" : "");
      const text = entry.marker.text;
      marker.textContent = text;
      marker.style.left = entry.marker.x - textWidth(text, fontFor(block, null)) + "px";
      marker.style.top = entry.marker.y - entry.top + "px";
      element.appendChild(marker);
    }
  }

  paintSelection(selection) {
    for (const element of this.selectionElements) {
      element.remove();
    }
    this.selectionElements = [];

    if (!selection || !this.layout) {
      return;
    }

    const { anchor, focus } = selection;
    const startBlock = Math.min(anchor.block, focus.block);
    const endBlock = Math.max(anchor.block, focus.block);
    // A backwards selection can end in the block it started in, so the offset
    // decides the order whenever both ends share a block.
    const startsFirst =
      anchor.block < focus.block ||
      (anchor.block === focus.block && anchor.offset <= focus.offset);
    const from = startsFirst ? anchor : focus;
    const to = startsFirst ? focus : anchor;

    for (let index = startBlock; index <= endBlock; index += 1) {
      const entry = this.layout.blocks[index];
      if (!entry) {
        continue;
      }

      if (entry.divider) {
        // A divider has no text to highlight, so a selection that reaches it
        // paints the rule's whole band instead. The same band marks a caret
        // that rests on the divider after a click, which is the only way to
        // show where the caret went on a block with no glyphs.
        const band = document.createElement("div");
        band.className = "doc-selection";
        band.style.left = "0px";
        band.style.top = entry.top + "px";
        band.style.width = this.layout.width + "px";
        band.style.height = entry.height + "px";
        this.overlay.appendChild(band);
        this.selectionElements.push(band);
        continue;
      }

      if (entry.block.type === "image") {
        if (startBlock === endBlock && entry.image) {
          const ring = document.createElement("div");
          ring.className = "doc-image-selection";
          ring.style.left = entry.image.x - 2 + "px";
          ring.style.top = entry.image.y - 2 + "px";
          ring.style.width = entry.image.width + 4 + "px";
          ring.style.height = entry.image.height + 4 + "px";
          ring.style.borderRadius = imageRadius(entry.block) + 2 + "px";
          this.overlay.appendChild(ring);
          this.selectionElements.push(ring);

          for (const [corner, fx, fy] of HANDLE_CORNERS) {
            const handle = document.createElement("div");
            handle.className = "doc-resize-handle";
            handle.dataset.corner = corner;
            handle.style.left = entry.image.x + entry.image.width * fx + "px";
            handle.style.top = entry.image.y + entry.image.height * fy + "px";
            this.overlay.appendChild(handle);
            this.selectionElements.push(handle);
          }
        }
        continue;
      }

      const blockStart = index === from.block ? from.offset : 0;
      const blockEnd = index === to.block ? to.offset : blockLength(entry.block);
      if (blockEnd <= blockStart) {
        continue;
      }

      for (const rect of selectionRectsFor(entry, blockStart, blockEnd)) {
        const element = rangeRectangle(rect, "doc-selection");
        this.overlay.appendChild(element);
        this.selectionElements.push(element);
      }
    }
  }

  showSearchPassage(range) {
    this.clearSearchPassage();
    const layer = document.createElement("div");
    this.overlay.prepend(layer);
    this.passage = {
      range, layer, blocks: this.blocks, scrollY: window.scrollY,
      timer: window.setTimeout(() => this.clearSearchPassage(), 2400),
    };
    this.paintSearchPassage();
  }

  paintSearchPassage() {
    const passage = this.passage;
    const { from, to } = passage.range;
    const fragment = document.createDocumentFragment();
    for (let index = from.block; index <= to.block; index += 1) {
      const entry = this.layout.blocks[index];
      const start = index === from.block ? from.offset : 0;
      const end = index === to.block ? to.offset : blockLength(entry.block);
      if (end <= start) continue;
      for (const rect of selectionRectsFor(entry, start, end)) {
        fragment.appendChild(rangeRectangle(rect, "doc-search-match"));
      }
    }
    passage.layer.replaceChildren(fragment);
    // Reflow (including a late image size) can move the passage. Keep it in
    // sight while highlighted, unless the reader has already scrolled away.
    if (window.scrollY === passage.scrollY) {
      passage.layer.firstElementChild?.scrollIntoView({ block: "center", behavior: "instant" });
      passage.scrollY = window.scrollY;
    }
  }

  clearSearchPassage() {
    if (!this.passage) return;
    window.clearTimeout(this.passage.timer);
    this.passage.layer.remove();
    this.passage = null;
  }

  setCaret(point, animate) {
    this.caretPoint = point;
    if (!point) {
      this.caret.style.display = "none";
      return;
    }
    this.caret.style.display = "";
    // Pinning transition-property is what scopes the slide to real cursor
    // moves: a paused move lands immediately, and the next explicit move
    // restores the stylesheet transition. The browser's computed position at
    // that moment is the animation's start, so no previous point is stored.
    this.caret.style.transitionProperty = animate ? "" : "none";
    this.caret.style.left = point.x + "px";
    this.caret.style.top = point.y + "px";
    this.caret.style.height = point.height + "px";
    this.caret.classList.remove("is-blinking");
    void this.caret.offsetWidth;
    this.caret.classList.add("is-blinking");
  }

  setComposition(point, text) {
    if (!text) {
      this.hideComposition();
      return;
    }
    if (!this.composition) {
      this.composition = document.createElement("div");
      this.composition.className = "doc-composition";
      this.overlay.appendChild(this.composition);
    }
    this.composition.textContent = text;
    this.composition.style.display = "";
    this.composition.style.left = point.x + "px";
    this.composition.style.top = point.y + "px";
    this.composition.style.lineHeight = point.height + "px";
  }

  hideComposition() {
    if (this.composition) {
      this.composition.remove();
      this.composition = null;
    }
  }

  // One screen of document, minus the margins the caret keeps at the edges.
  pageDistance() {
    return Math.max(1, window.innerHeight - CARET_MARGIN * 2);
  }

  scrollBy(distance) {
    if (distance) {
      window.scrollBy({ top: distance, behavior: "instant" });
    }
  }

  // A document-edge jump shows the whole paper's beginning or its end,
  // including the title above the prose, rather than stopping at a caret
  // margin that would leave it off screen.
  scrollToPageEdge(toStart) {
    const top = toStart ? 0 : document.scrollingElement.scrollHeight;
    window.scrollTo({ top, behavior: "instant" });
  }

  scrollCaretIntoView() {
    if (!this.caretPoint) {
      return;
    }
    // caretPoint is in the editor's own coordinates; the editor itself starts
    // wherever the page puts it, so compare viewport positions instead of
    // comparing the content offset with window.scrollY.
    const editorTop = this.root.getBoundingClientRect().top;
    const top = editorTop + this.caretPoint.y;
    const bottom = top + this.caretPoint.height;

    if (top < CARET_MARGIN) {
      window.scrollBy({ top: top - CARET_MARGIN, behavior: "instant" });
    } else if (bottom > window.innerHeight - CARET_MARGIN) {
      window.scrollBy({ top: bottom - window.innerHeight + CARET_MARGIN, behavior: "instant" });
    }
  }
}

function lineClass(block) {
  if (block.source === true) {
    return "is-source";
  }
  if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
    return "is-" + block.type;
  }
  if (block.type === "quote") {
    return "is-quote";
  }
  if (block.type === "list") {
    return "is-list";
  }
  if (block.type === "code") {
    return "is-code";
  }
  return "is-p";
}

function fragmentClass(fragment) {
  const classes = ["doc-text"];
  if (!fragment.marks) {
    return classes.join(" ");
  }
  if (fragment.marks.b) {
    classes.push("m-b");
  }
  if (fragment.marks.i) {
    classes.push("m-i");
  }
  if (fragment.marks.u) {
    classes.push("m-u");
  }
  if (fragment.marks.s) {
    classes.push("m-s");
  }
  if (fragment.marks.code) {
    classes.push("m-code");
  }
  if (fragment.marks.href) {
    classes.push("m-link");
  }
  return classes.join(" ");
}

function rangeRectangle(rect, className) {
  const element = document.createElement("div");
  element.className = className;
  element.style.left = rect.x + "px";
  element.style.top = rect.y + "px";
  element.style.width = rect.width + "px";
  element.style.height = rect.height + "px";
  return element;
}

function selectionRectsFor(entry, start, end) {
  const rects = [];
  for (const line of entry.lines) {
    const rect = textRangeRect(line, start, end);
    if (rect) rects.push(rect);
  }
  return rects;
}

function spellingKey(word) {
  return word.normalize("NFC").toLowerCase().replaceAll("’", "'");
}

function textRangeRect(line, start, end) {
  if (!line.fragments.length) return null;
  const lineStart = line.fragments[0].start;
  const lineEnd = line.fragments.at(-1).end;
  if (end <= lineStart || start >= lineEnd) return null;
  const from = xAt(line, Math.max(start, lineStart));
  const to = xAt(line, Math.min(end, lineEnd));
  return to > from ? { x: from, y: line.y, width: to - from, height: line.height } : null;
}

function xAt(line, offset) {
  for (const fragment of line.fragments) {
    if (offset <= fragment.end) {
      if (offset < fragment.start) {
        return fragment.x;
      }
      const cut = Math.max(0, Math.min(fragment.text.length, offset - fragment.start));
      return fragment.x + fragmentTextWidth(fragment, fragment.text.slice(0, cut));
    }
  }
  const last = line.fragments[line.fragments.length - 1];
  return last.x + fragmentTextWidth(last, last.text);
}
