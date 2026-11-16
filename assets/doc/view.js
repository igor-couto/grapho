// View: paints a layout into the page and keeps the caret and selection in
// sync. Only blocks whose geometry or text changed are rebuilt.

import { blockLength } from "./model.js";
import { fragmentTextWidth, textWidth } from "./layout.js";

const HANDLE_CORNERS = [
  ["nw", 0, 0],
  ["ne", 1, 0],
  ["sw", 0, 1],
  ["se", 1, 1],
];

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
    this.caretPoint = null;
  }

  setLayout(layout, blocks) {
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
        view = { element: document.createElement("div"), signature: null };
        view.element.className = "doc-block";
        this.views.set(index, view);
        this.content.appendChild(view.element);
      }

      if (view.signature !== signature) {
        this.paintBlock(view, entry, blocks[index], index);
        view.signature = signature;
      }
    });

    for (const [index, view] of this.views) {
      if (!seen.has(index)) {
        view.element.remove();
        this.views.delete(index);
      }
    }
  }

  signature(entry, block) {
    const parts = [entry.top, entry.height, block ? block.mode || "" : ""];
    if (entry.image) {
      parts.push(
        "i",
        entry.image.x,
        entry.image.y,
        entry.image.width,
        entry.image.height,
        block.src.slice(0, 24),
        block.src.length,
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
    parts.push(entry.marker ? "m" + this.markerText(block, entry.index) : "");
    return parts.join("\u0001");
  }

  paintBlock(view, entry, block, index) {
    const element = view.element;
    element.className = "doc-block" + (entry.quote ? " is-quote" : "");
    element.style.top = entry.top + "px";
    element.style.height = (entry.height || 0) + "px";
    element.textContent = "";

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
          }
          lineElement.appendChild(span);
        }
      }

      element.appendChild(lineElement);
    }

    if (entry.marker) {
      const marker = document.createElement("div");
      marker.className = "doc-marker" + (block.ordered ? " is-number" : "");
      const text = this.markerText(block, index);
      marker.textContent = text;
      marker.style.left = entry.marker.x - textWidth(text, "17.5px Literata") + "px";
      marker.style.top = entry.marker.y - entry.top + "px";
      element.appendChild(marker);
    }
  }

  markerText(block, index) {
    if (!block || !block.ordered) {
      return "•";
    }

    let number = 1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = this.blocks[cursor];
      if (!previous || previous.type !== "list" || previous.depth !== block.depth) {
        break;
      }
      if (!previous.ordered) {
        break;
      }
      number += 1;
    }
    return number + ".";
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
    const from = anchor.block <= focus.block ? anchor : focus;
    const to = anchor.block <= focus.block ? focus : anchor;

    for (let index = startBlock; index <= endBlock; index += 1) {
      const entry = this.layout.blocks[index];
      if (!entry) {
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
        const element = document.createElement("div");
        element.className = "doc-selection";
        element.style.left = rect.x + "px";
        element.style.top = rect.y + "px";
        element.style.width = rect.width + "px";
        element.style.height = rect.height + "px";
        this.overlay.appendChild(element);
        this.selectionElements.push(element);
      }
    }
  }

  setCaret(point) {
    this.caretPoint = point;
    if (!point) {
      this.caret.style.display = "none";
      return;
    }
    this.caret.style.display = "";
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

  scrollCaretIntoView() {
    if (!this.caretPoint) {
      return;
    }
    const top = this.caretPoint.y;
    const bottom = top + this.caretPoint.height;
    const viewTop = window.scrollY;
    const viewBottom = viewTop + window.innerHeight;
    const margin = 90;

    if (top < viewTop + margin) {
      window.scrollTo({ top: Math.max(0, top - margin), behavior: "auto" });
    } else if (bottom > viewBottom - margin) {
      window.scrollTo({ top: bottom - window.innerHeight + margin, behavior: "auto" });
    }
  }
}

function lineClass(block) {
  if (block.type === "h1" || block.type === "h2" || block.type === "h3" || block.type === "h4") {
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

function selectionRectsFor(entry, start, end) {
  const rects = [];
  for (const line of entry.lines) {
    if (!line.fragments.length) {
      continue;
    }
    const lineStart = line.fragments[0].start;
    const lineEnd = line.fragments[line.fragments.length - 1].end;
    if (end <= lineStart || start >= lineEnd) {
      continue;
    }
    const from = xAt(line, Math.max(start, lineStart));
    const to = xAt(line, Math.min(end, lineEnd));
    if (to > from) {
      rects.push({ x: from, y: line.y, width: to - from, height: line.height });
    }
  }
  return rects;
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
