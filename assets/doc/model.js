// The document model: blocks of inline runs, plus HTML conversion.
//
// Blocks are immutable-by-convention. Editing helpers return new block objects
// only for the blocks they touch, so unchanged blocks keep their identity and
// stay in the layout cache.

const INLINE_TAGS = new Set(["a", "b", "code", "del", "em", "i", "s", "span", "strike", "strong", "u"]);
const BLOCK_TAGS = new Set(["blockquote", "div", "h1", "h2", "h3", "p", "pre", "ul", "ol"]);
// Blocks with no text of their own. A caret can rest on one after a click, but
// it cannot be typed into: typing replaces the whole block, and Enter, Delete,
// and the arrow keys step over it.
const ATOMIC_TYPES = new Set(["divider", "image"]);
const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3 };
const LIST_DEPTH_LIMIT = 6;

export const ALIGNMENTS = ["left", "center", "right", "justify"];
export const INDENT_LIMIT = 6;
export const MARK_KEYS = ["b", "i", "u", "s", "code"];
const ALIGNMENT_SET = new Set(ALIGNMENTS);

// Images are square by default. A block stores its own radius only when it
// differs from this, so untouched documents keep their markup.
export const IMAGE_RADIUS_DEFAULT = 0;
export const IMAGE_RADIUS_LIMIT = 200;

let nextBlockId = 1;

export function createBlockId() {
  return "b" + nextBlockId++;
}

export function createBlock(type, runs, format) {
  const block = { id: createBlockId(), type: type || "p", runs: normalizeRuns(runs || []) };
  return applyBlockFormat(block, format);
}

export function blockAlignment(block) {
  return block && ALIGNMENT_SET.has(block.align) ? block.align : "left";
}

export function blockIndent(block) {
  return block ? normalizeIndent(block.indent) : 0;
}

export function imageRadius(block) {
  const radius = block ? block.radius : null;
  if (!Number.isFinite(radius)) {
    return IMAGE_RADIUS_DEFAULT;
  }
  return Math.min(IMAGE_RADIUS_LIMIT, Math.max(0, Math.round(radius)));
}

export function emptyParagraph() {
  return createBlock("p", []);
}

export function createDivider() {
  return { id: createBlockId(), type: "divider", runs: [] };
}

export function isAtomicBlock(block) {
  return Boolean(block) && ATOMIC_TYPES.has(block.type);
}

export function isListBlock(block) {
  return block.type === "list";
}

export function blockLength(block) {
  if (isAtomicBlock(block)) {
    return 0;
  }
  let length = 0;
  for (const run of block.runs) {
    length += run.text.length;
  }
  return length;
}

export function blockText(block) {
  if (isAtomicBlock(block)) {
    return "";
  }
  return block.runs.map((run) => run.text).join("");
}

// Heading anchors are derived from the text, never stored, so no document
// format changes when one is linked to. The slug folds accents, lowercases,
// turns runs of punctuation and whitespace into one hyphen, and keeps Unicode
// letters and digits. A heading that slugs empty is still addressable as
// "section", and repeated slugs get "-2", "-3" in document order so every
// heading has a stable target until the writing around it changes.
const HEADING_ANCHOR_LIMIT = 80;

function headingSlug(text) {
  const slug = String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(slug || "section").slice(0, HEADING_ANCHOR_LIMIT).join("");
}

// One entry per block: the anchor of a heading, null for anything else.
export function headingAnchors(blocks) {
  const anchors = new Array(blocks.length).fill(null);
  const used = new Set();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || (block.type !== "h1" && block.type !== "h2" && block.type !== "h3")) {
      continue;
    }
    const base = headingSlug(blockText(block));
    let anchor = base;
    let suffix = 1;
    while (used.has(anchor)) {
      suffix += 1;
      anchor = base + "-" + suffix;
    }
    used.add(anchor);
    anchors[index] = anchor;
  }
  return anchors;
}

export function runsEqual(a, b) {
  return (
    Boolean(a.b) === Boolean(b.b) &&
    Boolean(a.i) === Boolean(b.i) &&
    Boolean(a.u) === Boolean(b.u) &&
    Boolean(a.s) === Boolean(b.s) &&
    Boolean(a.code) === Boolean(b.code) &&
    (a.href || "") === (b.href || "")
  );
}

export function normalizeRuns(runs) {
  const merged = [];
  for (const run of runs) {
    if (!run || !run.text) {
      continue;
    }
    const text = String(run.text);
    if (!text) {
      continue;
    }
    const previous = merged[merged.length - 1];
    if (previous && runsEqual(previous, run)) {
      merged[merged.length - 1] = { ...previous, text: previous.text + text };
    } else {
      merged.push({ ...run, text });
    }
  }
  return merged;
}

// Split a block's runs at a flat offset, returning both halves' runs.
export function splitRuns(runs, offset) {
  const left = [];
  const right = [];
  let index = 0;

  for (const run of runs) {
    const end = index + run.text.length;
    if (offset <= index) {
      right.push(run);
    } else if (offset >= end) {
      left.push(run);
    } else {
      const cut = offset - index;
      left.push({ ...run, text: run.text.slice(0, cut) });
      right.push({ ...run, text: run.text.slice(cut) });
    }
    index = end;
  }

  return { left: normalizeRuns(left), right: normalizeRuns(right) };
}

export function runsInRange(block, start, end) {
  if (isAtomicBlock(block)) {
    return [];
  }
  const runs = [];
  let index = 0;
  for (const run of block.runs) {
    const runEnd = index + run.text.length;
    const from = Math.max(start, index);
    const to = Math.min(end, runEnd);
    if (to > from) {
      runs.push({ ...run, text: run.text.slice(from - index, to - index) });
    }
    index = runEnd;
  }
  return normalizeRuns(runs);
}

export function marksAt(block, offset) {
  if (!block || isAtomicBlock(block) || !block.runs.length) {
    return {};
  }
  let index = 0;
  for (const run of block.runs) {
    const end = index + run.text.length;
    if (offset < end || (offset === end && end === blockLength(block))) {
      return markSet(run);
    }
    index = end;
  }
  return markSet(block.runs[block.runs.length - 1]);
}

export function markSet(run) {
  return {
    b: Boolean(run.b),
    i: Boolean(run.i),
    u: Boolean(run.u),
    s: Boolean(run.s),
    code: Boolean(run.code),
    href: run.href || "",
  };
}

export function insertTextIntoRuns(runs, offset, text, marks) {
  const { left, right } = splitRuns(runs, offset);
  const inserted = normalizeRuns([{ text, ...marks }]);
  return normalizeRuns([...left, ...inserted, ...right]);
}

export function removeRangeFromRuns(runs, start, end) {
  const { left } = splitRuns(runs, start);
  const { right } = splitRuns(runs, end);
  return normalizeRuns([...left, ...right]);
}

export function setMarkOnRuns(runs, start, end, key, value) {
  const { left: head, right: rest } = splitRuns(runs, start);
  const { left: middle, right: tail } = splitRuns(rest, end - start);
  const updated = middle.map((run) => {
    const next = { ...run };
    if (value) {
      next[key] = true;
    } else {
      delete next[key];
    }
    return next;
  });
  return normalizeRuns([...head, ...updated, ...tail]);
}

export function setHrefOnRuns(runs, start, end, href) {
  const { left: head, right: rest } = splitRuns(runs, start);
  const { left: middle, right: tail } = splitRuns(rest, end - start);
  const updated = middle.map((run) => {
    const next = { ...run };
    if (href) {
      next.href = href;
    } else {
      delete next.href;
    }
    return next;
  });
  return normalizeRuns([...head, ...updated, ...tail]);
}

export function splitBlock(block, offset) {
  if (isAtomicBlock(block)) {
    return [block, emptyParagraph()];
  }
  const { left, right } = splitRuns(block.runs, offset);
  const first = { ...block, id: createBlockId(), runs: left };
  const second = { ...block, id: createBlockId(), runs: right };
  return [first, second];
}

export function mergeBlocks(first, second) {
  if (isAtomicBlock(first) || isAtomicBlock(second)) {
    return first;
  }
  const runs = normalizeRuns([...first.runs, ...second.runs]);
  return { ...first, id: createBlockId(), runs };
}

function normalizeIndent(value) {
  const indent = Math.floor(Number(value));
  if (!Number.isFinite(indent) || indent <= 0) {
    return 0;
  }
  return Math.min(indent, INDENT_LIMIT);
}

function applyBlockFormat(block, format) {
  if (!format) {
    return block;
  }
  if (format.align && format.align !== "left" && ALIGNMENT_SET.has(format.align)) {
    block.align = format.align;
  }
  const indent = normalizeIndent(format.indent);
  if (indent > 0) {
    block.indent = indent;
  }
  return block;
}

function blockFormat(block) {
  const format = {};
  if (block.align) {
    format.align = block.align;
  }
  if (block.indent) {
    format.indent = block.indent;
  }
  return format;
}

function formatFromNode(node, inherited) {
  const format = inherited ? { ...inherited } : {};
  const align = node.getAttribute("data-align");
  if (ALIGNMENT_SET.has(align)) {
    format.align = align;
  }
  const rawIndent = node.getAttribute("data-indent");
  if (rawIndent !== null && /^[0-9]+$/.test(rawIndent.trim())) {
    const indent = normalizeIndent(rawIndent.trim());
    if (indent > 0) {
      format.indent = indent;
    }
  }
  return format;
}

/* --------------------------------------------------------------------------
   HTML in and out
   -------------------------------------------------------------------------- */

export function parseDocument(html) {
  const source = String(html || "").trim();
  if (!source) {
    return [emptyParagraph()];
  }

  const doc = new DOMParser().parseFromString(
    "<!doctype html><html><body>" + source + "</body></html>",
    "text/html",
  );
  const blocks = [];
  parseChildren(doc.body, blocks, "p", {}, null, true);
  if (!blocks.length) {
    blocks.push(emptyParagraph());
  }
  return blocks;
}

function parseChildren(parent, out, fallbackType, marks, format, container) {
  let pending = [];
  // In a container that holds block elements, whitespace between the tags is
  // formatting. In a container of inline content, a space between two spans is
  // real text and has to stay.
  const skipFormattingWhitespace = Boolean(container) && hasBlockChild(parent);
  const flush = () => {
    if (pending.length) {
      out.push(createBlock(fallbackType, pending, format));
      pending = [];
    }
  };

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = cleanText(node.nodeValue);
      if (skipFormattingWhitespace && !text.trim()) {
        continue;
      }
      if (text) {
        pending.push({ text, ...marks });
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const tag = node.tagName.toLowerCase();
    if (tag === "img") {
      flush();
      out.push(imageBlockFrom(node));
      continue;
    }
    if (tag === "br") {
      pending.push({ text: "\n", ...marks });
      continue;
    }
    if (INLINE_TAGS.has(tag)) {
      pending = pending.concat(inlineRuns(node, marks));
      continue;
    }
    if (tag === "hr") {
      flush();
      out.push(createDivider());
      continue;
    }
    if (!BLOCK_TAGS.has(tag)) {
      pending = pending.concat(inlineRuns(node, marks));
      continue;
    }

    flush();
    parseBlockElement(node, tag, out, marks, format);
  }

  flush();
}

function hasBlockChild(parent) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const tag = node.tagName.toLowerCase();
    if (BLOCK_TAGS.has(tag) || tag === "img" || tag === "hr") {
      return true;
    }
  }
  return false;
}

function parseBlockElement(node, tag, out, marks, format) {
  const ownFormat = formatFromNode(node, format);

  if (HEADING_LEVELS[tag]) {
    const before = out.length;
    parseChildren(node, out, "h" + HEADING_LEVELS[tag], marks, ownFormat, false);
    if (out.length === before) {
      out.push(createBlock("h" + HEADING_LEVELS[tag], [], ownFormat));
    }
    return;
  }
  if (tag === "p") {
    const before = out.length;
    parseChildren(node, out, "p", marks, ownFormat, false);
    // An empty paragraph is a blank line the writer typed, not noise: the
    // editor stores it as <p></p> and must bring it back unchanged.
    if (out.length === before) {
      out.push(createBlock("p", [], ownFormat));
    }
    return;
  }
  if (tag === "div") {
    const before = out.length;
    parseChildren(node, out, "p", marks, ownFormat, true);
    if (out.length === before) {
      out.push(createBlock("p", [], ownFormat));
    }
    return;
  }
  if (tag === "pre") {
    out.push({ id: createBlockId(), type: "code", runs: [{ text: node.textContent.replace(/\r\n/g, "\n") }] });
    return;
  }
  if (tag === "blockquote") {
    const inner = [];
    parseChildren(node, inner, "p", marks, ownFormat, true);
    const runs = [];
    inner.forEach((block, index) => {
      if (index > 0) {
        runs.push({ text: "\n" });
      }
      if (block.runs) {
        runs.push(...block.runs);
      }
    });
    const quote = { id: createBlockId(), type: "quote", runs: normalizeRuns(runs) };
    const innerFormat = inner.length ? blockFormat(inner[0]) : ownFormat;
    out.push(applyBlockFormat(quote, innerFormat));
    return;
  }
  if (tag === "ul" || tag === "ol") {
    parseList(node, tag === "ol", 0, out, marks, ownFormat);
  }
}

function parseList(list, ordered, depth, out, marks, format) {
  const listFormat = formatFromNode(list, format);
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== "li") {
      continue;
    }
    const runs = [];
    const nested = [];
    for (const child of Array.from(item.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          nested.push({ node: child, ordered: tag === "ol" });
          continue;
        }
        if (tag === "p" || tag === "div") {
          runs.push(...runsFromContainer(child, marks));
          continue;
        }
      }
      runs.push(...runsFromNode(child, marks));
    }
    const itemFormat = formatFromNode(item, listFormat);
    const block = {
      id: createBlockId(),
      type: "list",
      ordered,
      depth: Math.min(depth, LIST_DEPTH_LIMIT),
      runs: normalizeRuns(runs),
    };
    out.push(applyBlockFormat(block, itemFormat));
    for (const child of nested) {
      parseList(child.node, child.ordered, depth + 1, out, marks, listFormat);
    }
  }
}

function runsFromContainer(node, marks) {
  const runs = [];
  for (const child of Array.from(node.childNodes)) {
    runs.push(...runsFromNode(child, marks));
  }
  return runs;
}

function runsFromNode(node, marks) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = cleanText(node.nodeValue);
    return text ? [{ text, ...marks }] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "br") {
    return [{ text: "\n", ...marks }];
  }
  if (tag === "img") {
    return [];
  }
  if (INLINE_TAGS.has(tag) || tag === "p" || tag === "div") {
    return inlineRuns(node, marks);
  }
  return [];
}

function inlineRuns(node, marks) {
  const tag = node.tagName.toLowerCase();
  const next = { ...marks };
  if (tag === "b" || tag === "strong") {
    next.b = true;
  } else if (tag === "i" || tag === "em") {
    next.i = true;
  } else if (tag === "u") {
    next.u = true;
  } else if (tag === "s" || tag === "strike" || tag === "del") {
    next.s = true;
  } else if (tag === "code") {
    next.code = true;
  } else if (tag === "a") {
    const href = node.getAttribute("href");
    if (href) {
      next.href = href;
    }
  }

  const runs = [];
  for (const child of Array.from(node.childNodes)) {
    runs.push(...runsFromNode(child, next));
  }
  return runs;
}

function imageBlockFrom(node) {
  const className = node.getAttribute("class") || "";
  const hasPosition = node.hasAttribute("data-x") || node.hasAttribute("data-y");
  const mode = /\bfree\b/.test(className) || hasPosition
    ? "free"
    : /wrap-left/.test(className)
      ? "left"
      : /wrap-right/.test(className)
        ? "right"
        : "block";
  return {
    id: createBlockId(),
    type: "image",
    mode,
    x: signedNumberOr(node.getAttribute("data-x"), null),
    y: signedNumberOr(node.getAttribute("data-y"), null),
    src: node.getAttribute("src") || "",
    alt: node.getAttribute("alt") || "",
    width: numberOr(node.getAttribute("width"), 0),
    height: numberOr(node.getAttribute("height"), 0),
    displayWidth: numberOr(node.getAttribute("data-width"), null),
    radius: radiusOr(node.getAttribute("data-radius")),
  };
}

function radiusOr(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.min(IMAGE_RADIUS_LIMIT, Math.round(parsed));
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function signedNumberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function serializeDocument(blocks) {
  let html = "";
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (block.type === "list") {
      const ordered = Boolean(block.ordered);
      const items = [];
      while (index < blocks.length && blocks[index].type === "list" && Boolean(blocks[index].ordered) === ordered) {
        items.push(blocks[index]);
        index += 1;
      }
      // A list is an HTML tree, and the model's depths are a number that can
      // skip a level (an item's parent was deleted) or begin above zero (the
      // first item was indented). Normalize the depths into a tree that HTML
      // can represent so no item is lost and serialization always advances.
      const normalized = normalizeListDepths(items);
      html += serializeList(normalized, 0, 0, ordered).html;
      continue;
    }
    html += serializeBlock(block);
    index += 1;
  }

  return html;
}

function normalizeListDepths(items) {
  let depth = 0;
  return items.map((item, index) => {
    const raw = Math.max(0, Math.min(6, Math.floor(Number(item.depth) || 0)));
    depth = index === 0 ? 0 : Math.min(raw, depth + 1);
    return depth === item.depth ? item : { ...item, depth };
  });
}

function serializeList(items, startIndex, depth, ordered) {
  const tag = ordered ? "ol" : "ul";
  let html = "<" + tag + ">";
  let index = startIndex;

  while (index < items.length) {
    const item = items[index];
    if (item.depth !== depth) {
      break;
    }
    index += 1;
    html += "<li" + blockAttributes(item) + ">" + serializeRuns(item.runs, { allowBreaks: true });
    while (index < items.length && items[index].depth > depth) {
      const nested = serializeList(items, index, depth + 1, ordered);
      html += nested.html;
      if (nested.next <= index) {
        // Defensive: a malformed depth must never trap serialization here.
        break;
      }
      index = nested.next;
    }
    html += "</li>";
  }

  html += "</" + tag + ">";
  return { html, next: index };
}

function serializeBlock(block) {
  if (block.type === "divider") {
    return "<hr>";
  }
  if (block.type === "image") {
    const classes =
      block.mode === "left"
        ? ' class="wrap-left"'
        : block.mode === "right"
          ? ' class="wrap-right"'
          : block.mode === "free"
            ? ' class="free"'
            : "";
    const alt = block.alt ? ' alt="' + escapeAttribute(block.alt) + '"' : "";
    const width = block.width ? ' width="' + Math.round(block.width) + '"' : "";
    const height = block.height ? ' height="' + Math.round(block.height) + '"' : "";
    const x = block.mode === "free" && Number.isFinite(block.x) ? ' data-x="' + Math.round(block.x) + '"' : "";
    const y = block.mode === "free" && Number.isFinite(block.y) ? ' data-y="' + Math.round(block.y) + '"' : "";
    const displayWidth = Number.isFinite(block.displayWidth) ? ' data-width="' + Math.round(block.displayWidth) + '"' : "";
    const radius = Number.isFinite(block.radius) ? ' data-radius="' + Math.round(block.radius) + '"' : "";
    return (
      "<img" +
      classes +
      alt +
      width +
      height +
      displayWidth +
      radius +
      x +
      y +
      ' src="' +
      escapeAttribute(block.src) +
      '">'
    );
  }
  if (block.type === "code") {
    return "<pre>" + escapeText(blockText(block)) + "</pre>";
  }

  const inner = serializeRuns(block.runs, { allowBreaks: true });
  const attributes = blockAttributes(block);
  if (block.type === "quote") {
    return "<blockquote" + attributes + "><p>" + inner + "</p></blockquote>";
  }
  if (HEADING_LEVELS[block.type]) {
    return "<" + block.type + attributes + ">" + inner + "</" + block.type + ">";
  }
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    return "<" + tag + "><li" + attributes + ">" + inner + "</li></" + tag + ">";
  }
  return "<p" + attributes + ">" + inner + "</p>";
}

function blockAttributes(block) {
  const align = blockAlignment(block);
  const indent = blockIndent(block);
  let html = "";
  if (align !== "left") {
    html += ' data-align="' + align + '"';
  }
  if (indent > 0) {
    html += ' data-indent="' + indent + '"';
  }
  return html;
}

export function serializeRuns(runs, options) {
  const allowBreaks = options && options.allowBreaks;
  let html = "";

  for (const run of runs) {
    // Escape the text first, then turn real line feeds into <br>. Doing it the
    // other way escapes the tag itself and saves a hard break as the visible
    // characters "&lt;br&gt;" when the document is written back.
    let inner = escapeText(run.text);
    if (allowBreaks) {
      inner = inner.replace(/\n/g, "<br>");
    }
    if (run.code) {
      inner = "<code>" + inner + "</code>";
    }
    if (run.s) {
      inner = "<s>" + inner + "</s>";
    }
    if (run.u) {
      inner = "<u>" + inner + "</u>";
    }
    if (run.i) {
      inner = "<i>" + inner + "</i>";
    }
    if (run.b) {
      inner = "<b>" + inner + "</b>";
    }
    if (run.href) {
      inner = '<a href="' + escapeAttribute(run.href) + '">' + inner + "</a>";
    }
    html += inner;
  }

  return html;
}

export function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}
