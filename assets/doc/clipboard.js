// Clipboard HTML: copy writes the selection as semantic HTML, and paste turns
// clipboard HTML back into blocks. The stored document stays the editor's own
// semantic format; this module only translates between it and other programs.
//
// The clipboard is untrusted input. Paste is reduced to the tags the editor can
// write (headings, paragraphs, lists, quotes, code, inline marks, links, and
// embedded images) and to the inline styles other editors use for bold, italic,
// underline, strike-through, and paragraph alignment, which become the same
// semantic model. Scripts, styles, forms, media, remote images, unknown
// attributes, and every URL scheme the store would strip never reach the block
// model, so a pasted document can never make the browser fetch anything.

import {
  blockLength,
  createBlock,
  createBlockId,
  emptyParagraph,
  escapeText,
  isTableBlock,
  parseDocument,
  runsInRange,
  serializeCodeBlock,
  serializeDocument,
  tableRunsInRange,
} from "./model.js";

// Headings above the editor's three levels are demoted the same way the store
// demotes an older document's h4.
const HEADING_TAGS = { h1: "h1", h2: "h2", h3: "h3", h4: "h3", h5: "h3", h6: "h3" };
const LIST_TAGS = new Set(["ul", "ol"]);

// Elements whose content is never text the writer can see. Their whole subtree
// is dropped, so a pasted script or style can never leak its body as words.
const DROPPED_TAGS = new Set([
  "applet",
  "area",
  "audio",
  "base",
  "button",
  "canvas",
  "col",
  "colgroup",
  "datalist",
  "dialog",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "link",
  "map",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "optgroup",
  "option",
  "output",
  "param",
  "portal",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
]);

// Block containers other than the ones with their own model block. Their
// content is kept as paragraphs so text never disappears with the wrapper.
const BLOCK_CONTAINERS = new Set([
  "address",
  "article",
  "aside",
  "center",
  "dd",
  "details",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "section",
  "summary",
]);

const BLOCK_TAGS = new Set([
  "blockquote",
  "caption",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  ...BLOCK_CONTAINERS,
]);

const MARK_TAGS = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
  kbd: "code",
  samp: "code",
  tt: "code",
};

const EMBEDDED_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
  "data:image/gif;base64,",
  "data:image/avif;base64,",
];

// CSS values that mean "whatever the parent said": they leave an inherited mark
// alone instead of clearing it.
const DECORATION_INHERITED = new Set(["inherit", "initial", "unset", "revert"]);

/* --------------------------------------------------------------------------
   Copy: selection to HTML
   -------------------------------------------------------------------------- */

// The selected blocks as HTML other programs can read and Grapho can paste
// back. A partial first or last block is cut down to its runs, and its
// alignment and indent are left behind because they belong to the whole block.
export function selectionHtml(blocks, from, to) {
  const copied = [];

  for (let index = from.block; index <= to.block; index += 1) {
    const block = blocks[index];
    if (!block) {
      continue;
    }
    if (block.type === "divider") {
      // A divider has no offset either, so it is copied whenever the range
      // reaches it, and an HTML paste carrying one inserts it as a block.
      copied.push({ ...block, id: createBlockId() });
      continue;
    }
    if (block.type === "image") {
      // A picture has no offset, so it is copied whenever the range reaches it
      // (a select-all reaches the first and last block). An image-only selection
      // is collapsed, so the caller never copies one by itself.
      if (isEmbeddedImage(block.src)) {
        copied.push({ ...block, id: createBlockId() });
      }
      continue;
    }
    if (isTableBlock(block)) {
      // A whole table copies as a real table another program can paste back.
      // A partial selection copies the covered text only, so cutting a few
      // cells does not silently copy a whole grid.
      const start = index === from.block ? from.offset : 0;
      const end = index === to.block ? to.offset : blockLength(block);
      if (start === 0 && end === blockLength(block)) {
        copied.push({ ...block, id: createBlockId() });
      } else {
        const runs = tableRunsInRange(block, start, end);
        if (runs.length) {
          copied.push(createBlock("p", runs));
        }
      }
      continue;
    }

    const start = index === from.block ? from.offset : 0;
    const length = blockLength(block);
    const end = index === to.block ? to.offset : length;
    if (start === end) {
      if (from.block === to.block) continue;
      // Only the paragraph break was selected at this edge. Keep the break
      // without bringing along an unselected heading or list item's style.
      if (length > 0) {
        copied.push(emptyParagraph());
        continue;
      }
    }

    const runs = runsInRange(block, start, end);
    const copy = { ...block, id: createBlockId(), runs };
    if (start > 0 || end < length) {
      delete copy.align;
      delete copy.indent;
    }
    copied.push(copy);
  }

  return serializeDocument(copied);
}

/* --------------------------------------------------------------------------
   Paste: HTML to blocks
   -------------------------------------------------------------------------- */

// Clipboard HTML as blocks, or null when it carries no content this editor can
// represent (the caller then falls back to the plain-text flavor).
export function blocksFromPastedHtml(html) {
  const source = String(html || "");
  if (!source.trim()) {
    return null;
  }

  let parsed = null;
  try {
    parsed = new DOMParser().parseFromString(source, "text/html");
  } catch (error) {
    return null;
  }
  if (!parsed || !parsed.body) {
    return null;
  }

  // Hostile or broken markup can be arbitrarily deep; a failure here means the
  // plain-text flavor is the honest fallback, not a broken paste.
  let blocks = [];
  try {
    const clean = renderChildren(parsed.body, { marks: {} });
    if (!clean.trim()) {
      return null;
    }
    blocks = parseDocument(clean);
  } catch (error) {
    return null;
  }

  const hasContent = blocks.some((block) => {
    if (block.type === "image") {
      return Boolean(block.src);
    }
    if (block.type === "divider") {
      return true;
    }
    if (isTableBlock(block)) {
      // An empty grid is still a table someone chose to copy.
      return true;
    }
    return Boolean(block.runs && block.runs.some((run) => run.text.trim()));
  });
  return hasContent ? blocks : null;
}

function renderChildren(parent, context) {
  // A container that holds block elements is HTML source formatting: its
  // whitespace and any top-level <br> are separators between those blocks, not
  // text. Google Docs and Safari put a <br> after every paragraph in clipboard
  // HTML; treating those as hard breaks would add a blank paragraph per line.
  // An inline wrapper between blocks inherits its container's flag, so a stray
  // separator inside it is dropped too.
  const blockContainer = hasBlockChild(parent) || context.blockContainer === true;
  const childContext = { ...context, blockContainer };
  let html = "";
  for (const node of Array.from(parent.childNodes)) {
    html += renderChild(node, childContext, blockContainer);
  }
  return html;
}

function renderChild(node, context, skipWhitespace) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeWhitespace(node.nodeValue);
    if (!text || (skipWhitespace && !text.trim())) {
      return "";
    }
    return renderText(text, context);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  if (context.blockContainer && node.tagName.toLowerCase() === "br") {
    return "";
  }
  return renderNode(node, context);
}

function renderNode(node, context) {
  const tag = node.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) {
    return "";
  }
  if (tag === "br") {
    return "<br>";
  }
  if (tag === "img") {
    return renderImage(node);
  }
  if (tag === "pre") {
    return serializeCodeBlock(preText(node));
  }
  if (tag === "hr") {
    return "<hr>";
  }
  if (HEADING_TAGS[tag]) {
    return renderBlock(node, HEADING_TAGS[tag], context);
  }
  if (tag === "p" || tag === "blockquote") {
    return renderBlock(node, tag, context);
  }
  if (tag === "div") {
    const content = renderChildren(node, { ...context, blockContainer: false });
    // An empty wrapper (a formatting shell around nothing) is not a blank line.
    return content.trim() ? "<div" + blockAttributes(node) + ">" + content + "</div>" : "";
  }
  if (LIST_TAGS.has(tag)) {
    return renderList(node, tag === "ol", context);
  }
  if (tag === "li") {
    // A stray item outside a list: keep its text as ordinary inline content.
    return renderChildren(node, { ...context, blockContainer: false });
  }
  if (tag === "table") {
    return renderTable(node, context);
  }
  if (tag === "td" || tag === "th") {
    return renderChildren(node, { ...context, blockContainer: false }) + " ";
  }
  if (tag === "tr" || tag === "caption") {
    return renderChildren(node, { ...context, blockContainer: false }) + "<br>";
  }
  if (BLOCK_CONTAINERS.has(tag)) {
    const content = renderChildren(node, { ...context, blockContainer: false });
    return content.trim() ? "<div" + blockAttributes(node) + ">" + content + "</div>" : "";
  }

  // Anything else is an inline wrapper such as a span, a font, or a link: keep
  // its text and marks, not its tag.
  return renderChildren(node, { ...context, marks: mergedMarks(node, context.marks) });
}

function renderBlock(node, tag, context) {
  return (
    "<" +
    tag +
    blockAttributes(node) +
    ">" +
    renderChildren(node, { ...context, blockContainer: false }) +
    "</" +
    tag +
    ">"
  );
}

function renderList(node, ordered, context) {
  const tag = ordered ? "ol" : "ul";
  let html = "";
  for (const child of Array.from(node.children)) {
    if (child.tagName.toLowerCase() !== "li") {
      continue;
    }
    html += renderListItem(child, context);
  }
  return html ? "<" + tag + ">" + html + "</" + tag + ">" : "";
}

// A list item is one block, so nested block wrappers are flattened to inline
// content and nested lists stay lists. Two paragraphs inside one item become
// one item with a hard break between them, the way the model represents them.
function renderListItem(node, context) {
  let inline = "";
  let nested = "";
  const itemContext = { ...context, blockContainer: false };

  const walk = (parent) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (LIST_TAGS.has(tag)) {
          nested += renderList(child, tag === "ol", itemContext);
          continue;
        }
        if (DROPPED_TAGS.has(tag)) {
          continue;
        }
        if (tag === "pre") {
          if (inline) {
            inline += "<br>";
          }
          inline += renderText(preText(child), itemContext);
          continue;
        }
        if (BLOCK_TAGS.has(tag)) {
          if (inline) {
            inline += "<br>";
          }
          walk(child);
          continue;
        }
      }
      inline += renderChild(child, itemContext, false);
    }
  };
  walk(node);

  return "<li" + blockAttributes(node) + ">" + inline + nested + "</li>";
}

// Tables paste as tables: the first row is the header (GFM's pipe table, and
// the editor's own grid, always has one) and every other row is a body row.
// Only the table's own cells count: a nested table is flattened into inline
// content by renderInline, and any extra cells beyond the first row's count are
// dropped, so the result is the rectangular grid the model stores.
function renderTable(node, context) {
  const rows = [];
  for (const row of Array.from(node.rows || [])) {
    const cells = [];
    for (const cell of Array.from(row.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag === "td" || tag === "th") {
        cells.push(renderInline(cell, context).trim());
      }
    }
    if (cells.length) {
      rows.push(cells);
    }
  }
  if (!rows.length) {
    return "";
  }
  const columns = Math.max(...rows.map((cells) => cells.length));
  for (const cells of rows) {
    while (cells.length < columns) {
      cells.push("");
    }
    cells.length = columns;
  }
  let html = "<table><thead><tr>";
  for (const cell of rows[0]) {
    html += "<th>" + cell + "</th>";
  }
  html += "</tr></thead><tbody>";
  for (const row of rows.slice(1)) {
    html += "<tr>";
    for (const cell of row) {
      html += "<td>" + cell + "</td>";
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

// Inline content with block wrappers flattened away.
function renderInline(parent, context) {
  let html = "";
  const inlineContext = { ...context, blockContainer: false };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (DROPPED_TAGS.has(tag)) {
        continue;
      }
      if (tag === "br") {
        html += "<br>";
        continue;
      }
      if (tag === "pre") {
        html += renderText(preText(node), inlineContext);
        continue;
      }
      if (BLOCK_TAGS.has(tag) || LIST_TAGS.has(tag)) {
        html += renderInline(node, inlineContext);
        continue;
      }
    }
    html += renderChild(node, inlineContext, false);
  }
  return html;
}

function renderText(text, context) {
  const marks = context.marks || {};
  let html = escapeText(text);
  if (marks.code) {
    html = "<code>" + html + "</code>";
  }
  if (marks.s) {
    html = "<s>" + html + "</s>";
  }
  if (marks.u) {
    html = "<u>" + html + "</u>";
  }
  if (marks.i) {
    html = "<i>" + html + "</i>";
  }
  if (marks.b) {
    html = "<b>" + html + "</b>";
  }
  if (marks.href) {
    html = '<a href="' + escapeAttribute(marks.href) + '">' + html + "</a>";
  }
  return html;
}

function mergedMarks(node, marks) {
  const tag = node.tagName.toLowerCase();
  const next = { ...marks };
  const mark = MARK_TAGS[tag];
  if (mark) {
    next[mark] = true;
  }

  // Other editors often write formatting as inline styles instead of tags
  // (Google Docs uses spans, Word uses spans and fonts), so read the few
  // declarations that carry the editor's own marks. A declaration wins over
  // the tag: Google Docs wraps its whole clipboard in <b style="font-weight:
  // normal">, which must not make everything bold.
  const style = styleMap(node);
  const weightValue = cssValue(style["font-weight"]);
  if (weightValue) {
    const weight = boldWeight(weightValue);
    if (weight !== null) {
      next.b = weight;
    }
  }
  const fontStyle = cssValue(style["font-style"]);
  if (fontStyle === "italic" || fontStyle === "oblique") {
    next.i = true;
  } else if (fontStyle === "normal") {
    next.i = false;
  }
  const decoration = cssValue(style["text-decoration-line"]) || cssValue(style["text-decoration"]);
  if (decoration && !DECORATION_INHERITED.has(decoration)) {
    next.u = /\bunderline\b/.test(decoration);
    next.s = /line-through/.test(decoration);
  }

  if (tag === "a") {
    next.href = safeHref(node.getAttribute("href"));
  }
  return next;
}

function styleMap(node) {
  const style = node.getAttribute("style");
  if (!style) {
    return {};
  }
  const map = {};
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().toLowerCase();
    if (name && value) {
      map[name] = value;
    }
  }
  return map;
}

function cssValue(value) {
  return String(value || "")
    .replace(/!\s*important/g, "")
    .trim();
}

function boldWeight(value) {
  if (value === "bold" || value === "bolder") {
    return true;
  }
  if (value === "normal" || value === "lighter") {
    return false;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric >= 600 : null;
}

function blockAttributes(node) {
  let html = "";
  const align = blockAlign(node);
  if (align) {
    html += ' data-align="' + align + '"';
  }
  // Block indent is a legacy stored property; a copied Grapho document keeps it
  // and an external one rarely has it, but it is bounded either way.
  const indent = node.getAttribute("data-indent");
  if (indent && /^[1-6]$/.test(indent)) {
    html += ' data-indent="' + indent + '"';
  }
  return html;
}

function blockAlign(node) {
  const stored = (node.getAttribute("data-align") || "").toLowerCase();
  if (stored === "center" || stored === "right" || stored === "justify") {
    return stored;
  }
  const attribute = (node.getAttribute("align") || "").toLowerCase();
  if (attribute === "center" || attribute === "right" || attribute === "justify") {
    return attribute;
  }
  const style = cssValue(styleMap(node)["text-align"]);
  if (style === "center" || style === "right" || style === "justify") {
    return style;
  }
  return "";
}

function renderImage(node) {
  const src = node.getAttribute("src") || "";
  if (!isEmbeddedImage(src)) {
    return "";
  }
  let html = '<img src="' + escapeAttribute(src) + '"';
  const alt = node.getAttribute("alt");
  if (alt) {
    html += ' alt="' + escapeAttribute(alt) + '"';
  }
  for (const name of ["width", "height"]) {
    const value = node.getAttribute(name);
    if (value && /^[1-9][0-9]{0,4}$/.test(value)) {
      html += " " + name + '="' + value + '"';
    }
  }
  const displayWidth = node.getAttribute("data-width");
  if (displayWidth && /^[1-9][0-9]{0,4}$/.test(displayWidth)) {
    html += ' data-width="' + displayWidth + '"';
  }
  // Match the store's bounded values exactly, so nothing paste accepts is
  // silently stripped the first time the document is saved.
  const radius = node.getAttribute("data-radius");
  if (radius && /^(0|[1-9][0-9]{0,2})$/.test(radius) && Number(radius) <= 200) {
    html += ' data-radius="' + radius + '"';
  }
  for (const name of ["data-x", "data-y"]) {
    const value = node.getAttribute(name);
    if (value && /^-?[0-9]{1,5}$/.test(value)) {
      html += " " + name + '="' + value + '"';
    }
  }
  const classes = (node.getAttribute("class") || "")
    .split(/\s+/)
    .filter((name) => name === "wrap-left" || name === "wrap-right" || name === "free");
  if (classes.length) {
    html += ' class="' + classes.join(" ") + '"';
  }
  return html + ">";
}

function isEmbeddedImage(value) {
  // Keep this in sync with `is_embedded_image` in src/store.rs: what paste
  // accepts here still has to survive the store's sanitizer on save.
  return EMBEDDED_IMAGE_PREFIXES.some((prefix) => value.length > prefix.length && value.startsWith(prefix));
}

// Links keep the schemes the editor writes and relative targets. A URL with a
// scheme the store would strip is dropped, so a pasted `javascript:` link never
// becomes a clickable run.
function safeHref(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
    return raw;
  }
  const colon = lower.indexOf(":");
  const path = lower.search(/[/?#]/);
  if (colon !== -1 && (path === -1 || colon < path)) {
    return "";
  }
  return raw;
}

function hasBlockChild(parent) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const tag = node.tagName.toLowerCase();
    if (BLOCK_TAGS.has(tag) || LIST_TAGS.has(tag)) {
      return true;
    }
    // A wrapper such as Google Docs' outer <b> can hold the real blocks.
    if (!DROPPED_TAGS.has(tag) && hasBlockChild(node)) {
      return true;
    }
  }
  return false;
}

// HTML source formatting puts line breaks and indentation inside text nodes;
// the browser would paint those as single spaces, so collapse runs that contain
// a line break. Runs of plain spaces and tabs are left alone: Grapho's own copy
// writes a paragraph's spaces and tabs exactly, and pasting it back must not
// silently tidy them.
function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f]*\n[ \t\n\f]*/g, " ");
}

function preText(node) {
  let text = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.nodeValue;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (DROPPED_TAGS.has(tag)) {
      continue;
    }
    if (tag === "br") {
      text += "\n";
      continue;
    }
    text += preText(child);
  }
  return text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}
