// Markdown mode's conversion layer: rich blocks <-> editable Markdown source.
//
// Markdown mode is a view over the usual stored HTML. While the mode is on,
// the editor shows one source line per block: ordinary paragraph blocks with
// `source: true` (one run, no marks, text is the Markdown line) and the image
// blocks unchanged. Leaving the mode, saving, and exporting parse those lines
// back into rich blocks, so the stored HTML format never changes.
//
// This module is pure: it converts block arrays and strings only. It knows
// nothing about the editor, the DOM, saving, or the server.
//
// ---------------------------------------------------------------------------
// Source dialect
// ---------------------------------------------------------------------------
//
// One line is one block. A blank (whitespace-only) line is an empty paragraph
// block, so pressing Enter in the source survives leaving and re-entering the
// mode; blank lines inside fenced code are code content. This matches the
// editor's own Enter semantics: a line is a paragraph.
//
//   paragraph line            plain text
//   (blank line)              an empty paragraph
//   # .. ###                  h1 .. h3 (a space after the hashes)
//   > text                    quote
//   - / * / + text            unordered list item
//   1. text                   ordered list item (any digits; leading spaces
//                             indent the item, two spaces per level, capped
//                             at the model's depth limit of 6)
//   ```                       fenced code; the fence is at least as long as
//                             the longest backtick run inside the code, and
//                             the content is the lines up to the closing fence
//                               (blank lines inside a fence are content)
//
// Inline:
//   **bold**  __bold__        bold
//   *italic*  _italic_        italic
//   ~~struck~~                strikethrough
//   `code`                    inline code (any matching backtick run length)
//   [label](url)              link (label is inline Markdown; url is http,
//                             https, mailto, or a relative/fragment target;
//                             protocol-relative and other schemes stay literal)
//   <u>text</u>               underline
//   <br>                      hard line break inside the block
//   \*  \\  \`  ...           backslash escapes any of \ ` * _ ~ [ ] <
//
// Content Markdown cannot express is carried as one line of the app's own
// serialized HTML, parsed with the normal block parser and sanitized by it:
//   <p data-align="center">text</p>
//   <h2 data-indent="2">text</h2>
//   <blockquote><p data-align="center">text</p></blockquote>
//   <p></p>                                  an empty paragraph, as older
//                                            documents may still carry (new
//                                            empty paragraphs are blank lines)
//   <ul data-depth="1" data-ordered="1"><li data-align="center">text</li></ul>
//                                            a list item carrying rich-only
//                                            attributes (depth is explicit
//                                            because a one-line document has
//                                            no ancestors)
// Only these exact shapes (and the inline tags above) are accepted from HTML
// lines; anything else, including images and absolute remote urls, stays
// literal text so a stored document can never start touching the network.
//
// The conversion is lossless for everything the rich model stores: block
// types, marks, links (absolute and relative), underline, alignment, legacy
// indent, empty paragraphs, hard breaks, nesting, images, and code. Rich blocks
// are never rewritten by entering the mode, and a toggle that changes nothing
// keeps the document byte-identical.
//
// Implementation notes:
// - The emitter writes canonical inline Markdown (bold as `**`, italic as `*`)
//   and then verifies that parsing the line reproduces the same runs. A block
//   that cannot be expressed exactly (a code run spanning a hard break, an
//   href whose Markdown would not round-trip, a line that would be misread as
//   a heading/list/fence) falls back to the HTML escape hatch, which the model
//   parser can represent exactly. That verification is what makes the lossless
//   invariant hold for every construct the model can hold.
// - Line maps carry three private fields beyond the documented shape so the
//   caret maps can clamp without re-parsing: `length` (characters on the
//   source side of this line), `richLength` (characters in the rich block that
//   owns it), and, on richLines, `code`/`segments` for a fenced block.

import {
  INDENT_LIMIT,
  blockAlignment,
  blockIndent,
  blockLength,
  blockText,
  createBlock,
  createBlockId,
  emptyParagraph,
  normalizeRuns,
  parseDocument,
  serializeRuns,
} from "./model.js";

const LIST_DEPTH_LIMIT = 6; // model.js LIST_DEPTH_LIMIT (not exported there)
const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3 };
const ALIGNMENTS = new Set(["center", "right", "justify"]);
const INLINE_HTML_TAGS = new Set(["a", "b", "code", "i", "s", "u"]);

function toText(value) {
  return value == null ? "" : String(value);
}

function clampNumber(value, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

function depthOf(block) {
  return clampNumber(block && block.depth, 0, LIST_DEPTH_LIMIT);
}

/* --------------------------------------------------------------------------
   Inline delimiters (shared by the parser and the escape-aware helpers)
   -------------------------------------------------------------------------- */

function countRun(text, start, end, char) {
  let index = start;
  while (index < end && text[index] === char) {
    index += 1;
  }
  return index - start;
}

// One pass over the text records where each inline delimiter run starts, so a
// recursive descent can find the next closing run without rescanning the line.
// It also pairs the brackets and parentheses once, so a line with many "["
// characters cannot make link scanning quadratic (unmatched brackets are the
// common case for pasted text, and each one used to rescan the rest of the
// line looking for a label end).
function buildInlineIndex(text) {
  const index = { "*": [], "_": [], "`": [], "~": [] };
  let position = 0;
  while (position < text.length) {
    const char = text[position];
    const list = index[char];
    if (!list) {
      position += 1;
      continue;
    }
    const length = countRun(text, position, text.length, char);
    list.push({ pos: position, len: length });
    position += length;
  }
  for (const key of Object.keys(index)) {
    const list = index[key];
    let largest = 0;
    for (let at = list.length - 1; at >= 0; at -= 1) {
      largest = Math.max(largest, list[at].len);
      list[at].maxFromHere = largest;
    }
  }
  index.labelClose = matchDelimiterPairs(text, "[", "]");
  index.parenClose = matchDelimiterPairs(text, "(", ")");
  return index;
}

// Open delimiter position -> its matching close, for balanced pairs. Escaped
// delimiters do not take part, matching the inline parser's backslash rules.
function matchDelimiterPairs(text, open, close) {
  const matches = new Map();
  const stack = [];
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position];
    if (char === "\\") {
      position += 1;
      continue;
    }
    if (char === open) {
      stack.push(position);
    } else if (char === close && stack.length) {
      matches.set(stack.pop(), position);
    }
  }
  return matches;
}

function firstDelimiterAtOrAfter(list, from, minLength) {
  if (!list || !list.length) {
    return -1;
  }
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle].pos < from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low >= list.length || list[low].maxFromHere < minLength) {
    return -1;
  }
  for (let at = low; at < list.length; at += 1) {
    if (list[at].len >= minLength) {
      return list[at].pos;
    }
  }
  return -1;
}

function isAsciiPunctuation(char) {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function mergeMarks(marks, additions) {
  const next = { ...marks };
  for (const key of Object.keys(additions)) {
    if (additions[key]) {
      next[key] = true;
    }
  }
  return next;
}

function matchHardBreak(text, start, end) {
  const limit = Math.min(end, start + 8);
  const candidate = text.slice(start, limit);
  const match = /^<br\s*\/?>/i.exec(candidate);
  return match ? match[0].length : 0;
}

// A link href the dialect can carry. Absolute http/https/mailto urls are the
// form the editor's link dialog creates; stored documents can also hold
// relative and fragment links (the server sanitizer passes them through), so
// those round-trip rather than being silently dropped. Protocol-relative
// targets and backslashes are refused because a browser can resolve them to
// another origin.
function isSafeHref(value) {
  if (typeof value !== "string") {
    return false;
  }
  const href = value.trim();
  if (!href) {
    return false;
  }
  if (/[\u0000-\u0020\u007f]/.test(href) || href.includes("\\")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return /^(?:https?:\/\/\S+|mailto:\S+)$/i.test(href);
  }
  return !href.startsWith("//");
}

/* --------------------------------------------------------------------------
   Inline Markdown -> runs
   -------------------------------------------------------------------------- */

/**
 * Parse inline Markdown into rich runs (text plus `b`, `i`, `u`, `s`, `code`,
 * `href`). Handles every inline form listed at the top of this file.
 */
export function inlineToRuns(text) {
  const source = toText(text);
  const runs = [];
  parseInlineInto(source, 0, source.length, {}, runs, buildInlineIndex(source));
  return normalizeRuns(runs);
}

function parseInlineInto(text, start, end, marks, out, index) {
  let position = start;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push({ text: buffer, ...marks });
      buffer = "";
    }
  };

  while (position < end) {
    const char = text[position];

    if (char === "\\") {
      if (position + 1 < end && isAsciiPunctuation(text[position + 1])) {
        buffer += text[position + 1];
        position += 2;
      } else {
        buffer += "\\";
        position += 1;
      }
      continue;
    }

    if (char === "`") {
      const runLength = countRun(text, position, end, "`");
      const close = firstDelimiterAtOrAfter(index["`"], position + runLength, runLength);
      if (close < 0 || close >= end) {
        buffer += "`".repeat(runLength);
        position += runLength;
        continue;
      }
      flush();
      out.push({ text: text.slice(position + runLength, close), ...marks, code: true });
      position = close + runLength;
      continue;
    }

    if (char === "*" || char === "_") {
      const runLength = countRun(text, position, end, char);
      if (runLength > 3) {
        buffer += char.repeat(runLength);
        position += runLength;
        continue;
      }
      const emphasis = runLength === 1 ? { i: true } : runLength === 2 ? { b: true } : { b: true, i: true };
      const close = firstDelimiterAtOrAfter(index[char], position + runLength, runLength);
      if (close < 0 || close >= end) {
        buffer += char.repeat(runLength);
        position += runLength;
        continue;
      }
      flush();
      parseInlineInto(text, position + runLength, close, mergeMarks(marks, emphasis), out, index);
      position = close + runLength;
      continue;
    }

    if (char === "~" && text[position + 1] === "~") {
      const close = firstDelimiterAtOrAfter(index["~"], position + 2, 2);
      if (close < 0 || close >= end) {
        buffer += "~~";
        position += 2;
        continue;
      }
      flush();
      parseInlineInto(text, position + 2, close, mergeMarks(marks, { s: true }), out, index);
      position = close + 2;
      continue;
    }

    if (char === "<") {
      const breakLength = matchHardBreak(text, position, end);
      if (breakLength) {
        flush();
        out.push({ text: "\n", ...marks });
        position += breakLength;
        continue;
      }
      if (text.startsWith("<u>", position) && position + 3 <= end) {
        const close = text.indexOf("</u>", position + 3);
        if (close >= 0 && close + 4 <= end) {
          flush();
          parseInlineInto(text, position + 3, close, mergeMarks(marks, { u: true }), out, index);
          position = close + 4;
          continue;
        }
      }
      buffer += "<";
      position += 1;
      continue;
    }

    // "![alt](url)" is image syntax this dialect cannot store, so keep the
    // whole thing as literal text instead of turning it into a link.
    if (char === "!" && text[position + 1] === "[") {
      buffer += "![";
      position += 2;
      continue;
    }

    if (char === "[") {
      // A link needs a non-empty label followed by "(href)". Both pairs were
      // matched in one pass by buildInlineIndex, so pasted text full of lone
      // brackets stays linear.
      const labelEnd = index.labelClose.get(position);
      if (
        labelEnd !== undefined &&
        labelEnd > position + 1 &&
        labelEnd + 1 < end &&
        text[labelEnd + 1] === "("
      ) {
        const closeParen = index.parenClose.get(labelEnd + 1);
        if (closeParen !== undefined && closeParen >= labelEnd + 2 && closeParen < end) {
          const href = text.slice(labelEnd + 2, closeParen).trim();
          if (isSafeHref(href)) {
            flush();
            const before = out.length;
            parseInlineInto(text, position + 1, labelEnd, marks, out, index);
            for (let at = before; at < out.length; at += 1) {
              out[at] = { ...out[at], href };
            }
            position = closeParen + 1;
            continue;
          }
        }
      }
      buffer += "[";
      position += 1;
      continue;
    }

    buffer += char;
    position += 1;
  }

  flush();
}

/* --------------------------------------------------------------------------
   Runs -> inline Markdown
   -------------------------------------------------------------------------- */

function longestRunLength(text, char) {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === char) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else {
      current = 0;
    }
  }
  return longest;
}

function escapeInlineMarkdown(text) {
  return String(text).replace(/[\\`*_~[\]<]/g, "\\$&");
}

function runsEqual(a, b) {
  return (
    Boolean(a.b) === Boolean(b.b) &&
    Boolean(a.i) === Boolean(b.i) &&
    Boolean(a.u) === Boolean(b.u) &&
    Boolean(a.s) === Boolean(b.s) &&
    Boolean(a.code) === Boolean(b.code) &&
    (a.href || "") === (b.href || "")
  );
}

function runsEquivalent(left, right) {
  const a = normalizeRuns(left || []);
  const b = normalizeRuns(right || []);
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].text !== b[index].text || !runsEqual(a[index], b[index])) {
      return false;
    }
  }
  return true;
}

// The rich runs as Markdown can hold them. An href the dialect cannot carry is
// dropped rather than written back as a different, unsafe link.
function safeRuns(runs) {
  const list = [];
  for (const run of runs || []) {
    if (!run || !run.text) {
      continue;
    }
    if (run.href && !isSafeHref(run.href)) {
      const copy = { ...run };
      delete copy.href;
      list.push(copy);
    } else {
      list.push(run);
    }
  }
  return normalizeRuns(list);
}

// Returns null when the runs cannot be written as inline Markdown (only a code
// span containing a hard break does that: Markdown has no way to mark the
// break as code).
function inlineMarkdownFor(runs) {
  let out = "";
  for (const run of runs) {
    let inner;
    if (run.code) {
      if (run.text.indexOf("\n") !== -1) {
        return null;
      }
      const ticks = "`".repeat(longestRunLength(run.text, "`") + 1);
      inner = ticks + run.text + ticks;
    } else {
      inner = escapeInlineMarkdown(run.text).replace(/\n/g, "<br>");
    }
    if (run.s) {
      inner = "~~" + inner + "~~";
    }
    if (run.u) {
      inner = "<u>" + inner + "</u>";
    }
    if (run.i) {
      inner = "*" + inner + "*";
    }
    if (run.b) {
      inner = "**" + inner + "**";
    }
    if (run.href) {
      inner = "[" + inner + "](" + run.href + ")";
    }
    out += inner;
  }
  return out;
}

/**
 * Format rich runs as canonical inline Markdown. The inverse of
 * inlineToRuns() for every run array the model can produce.
 */
export function runsToInline(runs) {
  const clean = safeRuns(runs);
  const markdown = inlineMarkdownFor(clean);
  if (markdown !== null) {
    return markdown;
  }
  return serializeRuns(clean, { allowBreaks: true });
}

/**
 * Wrap text in the canonical markers for a set of marks, for Markdown mode's
 * pending-mark typing: the next typed character (or pasted word) is inserted
 * already formatted. Returns the wrapped text, where the caret belongs after
 * the opening markers and the visible text, plus the length of the closing
 * markers so the caller can keep the caret inside the pair.
 *
 * @param {string} text typed text, one line
 * @param {{b?: boolean, i?: boolean, u?: boolean, s?: boolean, code?: boolean}} marks
 * @returns {{text: string, caretOffset: number, closingLength: number}|null}
 */
export function wrapInlineText(text, marks) {
  const plain = toText(text);
  if (!plain) {
    return null;
  }
  const active = marks || {};
  let body = plain;
  let open = "";
  let close = "";
  if (active.b) {
    open += "**";
    close = "**" + close;
  }
  if (active.i) {
    open += "*";
    close = "*" + close;
  }
  if (active.u) {
    open += "<u>";
    close = "</u>" + close;
  }
  if (active.s) {
    open += "~~";
    close = "~~" + close;
  }
  if (active.code) {
    const ticks = "`".repeat(longestRunLength(plain, "`") + 1);
    open += ticks;
    close = ticks + close;
  } else {
    body = escapeInlineMarkdown(plain);
  }
  return {
    text: open + body + close,
    caretOffset: open.length + body.length,
    closingLength: close.length,
  };
}

/* --------------------------------------------------------------------------
   One-line helpers
   -------------------------------------------------------------------------- */

const FENCE_LINE = /^[ \t]*(`+)[ \t]*$/;

// Number of backticks when the line is nothing but a backtick run, else 0.
function fenceLineLength(text) {
  const match = FENCE_LINE.exec(toText(text));
  return match ? match[1].length : 0;
}

function fenceForCode(text) {
  return Math.max(3, longestRunLength(text, "`") + 1);
}

// Total leading whitespace in columns, with a tab counting as four spaces.
function leadingColumns(text) {
  let columns = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === " ") {
      columns += 1;
    } else if (text[index] === "\t") {
      columns += 4;
    } else {
      break;
    }
  }
  return columns;
}

/**
 * Classify one source line without fence context. Returns one of:
 *   {kind: "blank"}
 *   {kind: "html", text}                        rich-only attributes carried
 *                                               as serialized HTML
 *   {kind: "fence"}
 *   {kind: "p", body}
 *   {kind: "h1"} .. {kind: "h3"}, body
 *   {kind: "quote", body}
 *   {kind: "list", ordered, indent, depth, body}
 * `body` is the Markdown text after the line's marker (still Markdown). An
 * ordered list item also carries `number`, the marker's digits, so writeLine()
 * can rebuild the same line.
 */
export function readLine(text) {
  const line = toText(text);
  if (!line.trim()) {
    return { kind: "blank" };
  }
  if (line[0] === "<" && classifyHtmlLine(line)) {
    return { kind: "html", text: line };
  }
  const fenceLength = fenceLineLength(line);
  if (fenceLength >= 3) {
    return { kind: "fence" };
  }
  const heading = /^(#{1,3})[ \t](.*)$/.exec(line);
  if (heading) {
    return { kind: "h" + heading[1].length, body: heading[2] };
  }
  const quote = /^>[ \t]?(.*)$/.exec(line);
  if (quote) {
    return { kind: "quote", body: quote[1] };
  }
  const columns = leadingColumns(line);
  const rest = line.slice(indexAfterLeadingWhitespace(line));
  if (rest.length) {
    const marker = rest[0];
    if (marker === "-" || marker === "*" || marker === "+") {
      if (rest.length === 1) {
        return listLine(false, "", columns);
      }
      if (rest[1] === " " || rest[1] === "\t") {
        return listLine(false, rest.slice(2), columns);
      }
    } else if (marker >= "0" && marker <= "9") {
      const ordered = /^(\d+)\.([ \t].*)?$/.exec(rest);
      if (ordered) {
        const body = ordered[2] === undefined ? "" : ordered[2].slice(1);
        return listLine(true, body, columns, Number(ordered[1]));
      }
    }
  }
  return { kind: "p", body: line };
}

function indexAfterLeadingWhitespace(text) {
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

function listLine(ordered, body, columns, number) {
  const line = {
    kind: "list",
    ordered,
    indent: columns,
    depth: Math.min(Math.floor(columns / 2), LIST_DEPTH_LIMIT),
    body,
  };
  // The digit is kept so writeLine() can rebuild the same line; the rich model
  // stores list order, not list numbers.
  if (ordered) {
    line.number = number;
  }
  return line;
}

/**
 * Build one source line from the object readLine() returns (with `body`
 * replaced). Inverse of readLine() for the forms it produces.
 */
export function writeLine(line) {
  if (!line || typeof line !== "object") {
    return "";
  }
  const body = toText(line.body);
  switch (line.kind) {
    case "blank":
      return "";
    case "html":
      return toText(line.text);
    case "fence": {
      const length = clampNumber(line.fenceLength, 3, 64);
      return "`".repeat(Math.max(3, length));
    }
    case "h1":
    case "h2":
    case "h3":
      return "#".repeat(HEADING_LEVELS[line.kind]) + " " + body;
    case "quote":
      return "> " + body;
    case "list": {
      const depth = clampNumber(line.depth, 0, LIST_DEPTH_LIMIT);
      const prefix = "  ".repeat(depth);
      if (line.ordered) {
        const number = clampNumber(line.number, 1, 999999999);
        return prefix + number + ". " + body;
      }
      return prefix + "- " + body;
    }
    case "p":
      return body;
    default:
      return body;
  }
}

/**
 * Classify every source block with fence context, for editing commands:
 * an array parallel to `blocks`, each entry one of
 *   {kind: "image"}
 *   {kind: "blank"}
 *   {kind: "html"}
 *   {kind: "fenceOpen", fenceLength}
 *   {kind: "fenceClose"}
 *   {kind: "codeContent"}
 *   {kind: "p"|"h1".."h3"|"quote"|"list", body, indent, ordered, depth}
 * plus `index` on text entries.
 */
export function sourceLineInfo(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const out = [];
  let fenceLength = 0;
  for (let index = 0; index < list.length; index += 1) {
    const block = list[index];
    if (!block || block.type === "image") {
      out.push({ kind: "image", index });
      continue;
    }
    const text = sourceText(block);
    if (fenceLength > 0) {
      const count = fenceLineLength(text);
      if (count >= fenceLength) {
        out.push({ kind: "fenceClose", fenceLength: count, index });
        fenceLength = 0;
      } else {
        out.push({ kind: "codeContent", index });
      }
      continue;
    }
    const info = readLine(text);
    switch (info.kind) {
      case "blank":
        out.push({ kind: "blank", index });
        break;
      case "html":
        out.push({ kind: "html", index });
        break;
      case "fence": {
        const count = fenceLineLength(text);
        out.push({ kind: "fenceOpen", fenceLength: count, index });
        fenceLength = count;
        break;
      }
      case "list":
        out.push({
          kind: "list",
          body: info.body,
          indent: info.indent,
          ordered: info.ordered,
          depth: info.depth,
          index,
        });
        break;
      default:
        out.push({ kind: info.kind, body: info.body, index });
        break;
    }
  }
  return out;
}

/**
 * Parse one source line on its own into rich blocks. A blank or fence line
 * returns [] because an isolated line used by the editing commands carries no
 * content; the whole-document parser is the one that turns blank lines into
 * empty paragraphs. A line carrying HTML returns the blocks the normal parser
 * makes from it, but only when the line uses the accepted shapes; otherwise the
 * line is a paragraph.
 */
export function lineToBlocks(text) {
  const line = toText(text);
  const info = readLine(line);
  if (info.kind === "blank" || info.kind === "fence") {
    return [];
  }
  if (info.kind === "html") {
    return parseHtmlLine(line) || [literalParagraph(line)];
  }
  return [richBlockFromLine(line, info)];
}

/**
 * Format one rich block as source lines: a code block becomes a fenced group,
 * an image becomes [], every other block one line (serialized HTML when the
 * block carries rich-only attributes).
 */
export function blockToLines(block) {
  return blockLinesFor(block, []).lines;
}

function sourceText(block) {
  if (!block || block.type === "image") {
    return "";
  }
  return blockText(block);
}

function literalParagraph(line) {
  return createBlock("p", line ? [{ text: line }] : []);
}

function startsWithInlineMarkdown(line) {
  return line.startsWith("<u>") || /^<br\s*\/?>/i.test(line);
}

function richBlockFromLine(line, info) {
  switch (info.kind) {
    case "h1":
    case "h2":
    case "h3":
      return createBlock(info.kind, inlineToRuns(info.body));
    case "quote":
      return createBlock("quote", inlineToRuns(info.body));
    case "list": {
      const block = createBlock("list", inlineToRuns(info.body));
      block.ordered = Boolean(info.ordered);
      block.depth = clampNumber(info.depth, 0, LIST_DEPTH_LIMIT);
      return block;
    }
    default:
      // A line that looks like HTML but is not an accepted shape stays a
      // literal paragraph: the user wrote markup, not Markdown. `<u>` and
      // `<br>` are inline Markdown, so a paragraph may legitimately start
      // with them.
      if (line[0] === "<" && !startsWithInlineMarkdown(line)) {
        return literalParagraph(line);
      }
      return createBlock("p", inlineToRuns(info.body));
  }
}

/* --------------------------------------------------------------------------
   Whole-document conversion
   -------------------------------------------------------------------------- */

/**
 * Convert rich blocks into the source blocks the editor shows in Markdown
 * mode. Image blocks are copied through unchanged and split the text.
 *
 * @param {Array} blocks rich blocks from the editor
 * @returns {{blocks: Array, lineMap: Array, richLines: Array, imageTargets: Array}}
 *   `blocks` are the source blocks (text blocks carry `source: true`; images
 *   are the same objects). `lineMap[i]` describes source block `i` for
 *   mapping a source caret back to the rich model:
 *     {richIndex, lineOffset, prefixLength} for a text line (including the
 *       empty paragraph a blank line becomes),
 *     null for an image.
 *   `lineOffset` is the offset inside the rich block where this source line
 *   starts (non-zero only for the lines of a fenced code block).
 *   `richLines[i]` is the inverse for rich block `i`:
 *     {sourceIndex, prefixLength} or null when the rich block is an image.
 *   `imageTargets[i]` is the rich index of a source image block, so a caret
 *   on a picture can be mapped back to that picture.
 */
export function richToSource(blocks) {
  const input = Array.isArray(blocks) ? blocks : [];
  const sourceBlocks = [];
  const lineMap = [];
  const richLines = [];
  const imageTargets = [];
  const counters = [];

  if (!input.length) {
    // The editor always shows a line, even for an empty document.
    sourceBlocks.push(sourceLine(""));
    lineMap.push(lineEntry(0, 0, 0, 0, 0));
    return { blocks: sourceBlocks, lineMap, richLines, imageTargets };
  }

  if (isLoneEmptyParagraph(input)) {
    // Exactly one empty paragraph is the editor's placeholder state, so it is
    // one empty source line rather than the `<p></p>` escape hatch.
    sourceBlocks.push(sourceLine(""));
    lineMap.push(lineEntry(0, 0, 0, 0, 0));
    richLines.push({ sourceIndex: 0, prefixLength: 0, length: 0 });
    return { blocks: sourceBlocks, lineMap, richLines, imageTargets };
  }

  for (let richIndex = 0; richIndex < input.length; richIndex += 1) {
    const block = input[richIndex];
    if (!block) {
      counters.length = 0;
      sourceBlocks.push(sourceLine(""));
      lineMap.push(null);
      richLines.push(null);
      imageTargets.push(null);
      continue;
    }
    if (block.type === "image") {
      counters.length = 0;
      sourceBlocks.push(block);
      lineMap.push(null);
      richLines.push(null);
      imageTargets.push(richIndex);
      continue;
    }
    imageTargets.push(null);
    if (block.type !== "list") {
      counters.length = 0;
    }
    const emitted = blockLinesFor(block, counters);
    const richLength = blockLength(block);
    if (block.type === "code") {
      const text = blockText(block);
      const fenceLength = fenceForCode(text);
      const contentLines = text.split("\n");
      const start = sourceBlocks.length;
      const richEntry = {
        sourceIndex: start,
        prefixLength: fenceLength,
        code: true,
        length: text.length,
        segments: [],
      };
      richLines.push(richEntry);
      sourceBlocks.push(sourceLine(emitted.lines[0]));
      lineMap.push(lineEntry(richIndex, 0, fenceLength, 0, text.length));
      let offset = 0;
      for (let lineIndex = 0; lineIndex < contentLines.length; lineIndex += 1) {
        const line = contentLines[lineIndex];
        const sourceIndex = sourceBlocks.length;
        sourceBlocks.push(sourceLine(line));
        lineMap.push(lineEntry(richIndex, offset, 0, line.length, text.length));
        richEntry.segments.push({ sourceIndex, offsetStart: offset });
        offset += line.length;
        if (lineIndex < contentLines.length - 1) {
          offset += 1;
        }
      }
      sourceBlocks.push(sourceLine(emitted.lines[emitted.lines.length - 1]));
      lineMap.push(lineEntry(richIndex, text.length, fenceLength, 0, text.length));
      continue;
    }

    const line = emitted.lines[0];
    const sourceIndex = sourceBlocks.length;
    sourceBlocks.push(sourceLine(line));
    const html = emitted.kind === "html";
    const prefixLength = html ? 0 : emitted.prefixLength;
    const bodyLength = html ? line.length : line.length - prefixLength;
    lineMap.push(lineEntry(richIndex, 0, prefixLength, bodyLength, richLength, html));
    richLines.push({ sourceIndex, prefixLength, length: richLength, html });
  }

  return { blocks: sourceBlocks, lineMap, richLines, imageTargets };
}

/**
 * Parse the source blocks shown in Markdown mode back into rich blocks.
 * Images pass through unchanged and keep their position between text.
 *
 * @param {Array} sourceBlocks blocks from the editor in Markdown mode
 * @returns {{blocks: Array, lineMap: Array}}
 *   `blocks` are rich blocks. `lineMap[i]` describes source block `i`:
 *     {richIndex, lineOffset, prefixLength} when it produced or continued a
 *     rich block, or null for an image. A blank line maps to the empty
 *     paragraph it becomes. A fenced code block's content lines all map to the
 *     same `richIndex` with their own `lineOffset`. `imageTargets[i]` is the
 *     rich index of a source image block (null elsewhere), so a caret on a
 *     picture stays on the picture.
 */
export function sourceToRich(sourceBlocks) {
  const input = Array.isArray(sourceBlocks) ? sourceBlocks : [];
  const blocks = [];
  const lineMap = [];
  const imageTargets = [];
  let index = 0;

  while (index < input.length) {
    const source = input[index];
    if (!source) {
      lineMap.push(null);
      imageTargets.push(null);
      index += 1;
      continue;
    }
    if (source.type === "image") {
      blocks.push(source);
      lineMap.push(null);
      imageTargets.push(blocks.length - 1);
      index += 1;
      continue;
    }
    const text = sourceText(source);
    const info = readLine(text);
    if (info.kind === "blank") {
      // A line the user left empty is an intentionally empty paragraph, so a
      // toggle out of the mode must not drop it.
      blocks.push(emptyParagraph());
      lineMap.push(lineEntry(blocks.length - 1, 0, 0, 0, 0));
      imageTargets.push(null);
      index += 1;
      continue;
    }
    if (info.kind === "fence") {
      const openLength = fenceLineLength(text);
      const start = blocks.length;
      const entries = [lineEntry(start, 0, openLength, 0, 0)];
      const contentLines = [];
      let offset = 0;
      let cursor = index + 1;
      while (cursor < input.length) {
        const next = input[cursor];
        if (!next || next.type === "image") {
          break;
        }
        const nextText = sourceText(next);
        const closeLength = fenceLineLength(nextText);
        if (closeLength >= openLength) {
          entries.push(lineEntry(start, offset, closeLength, 0, 0));
          cursor += 1;
          break;
        }
        contentLines.push(nextText);
        entries.push(lineEntry(start, offset, 0, nextText.length, 0));
        offset += nextText.length + 1;
        cursor += 1;
      }
      const codeText = contentLines.join("\n");
      blocks.push({ id: createBlockId(), type: "code", runs: [{ text: codeText }] });
      for (const entry of entries) {
        entry.richLength = codeText.length;
        lineMap.push(entry);
        imageTargets.push(null);
      }
      index = cursor;
      continue;
    }
    if (info.kind === "html") {
      const parsed = parseHtmlLine(text);
      if (parsed) {
        blocks.push(...parsed);
        lineMap.push(lineEntry(blocks.length - 1, 0, 0, text.length, blockLength(parsed[0]), true));
      } else {
        blocks.push(literalParagraph(text));
        lineMap.push(lineEntry(blocks.length - 1, 0, 0, text.length, text.length));
      }
      imageTargets.push(null);
      index += 1;
      continue;
    }
    blocks.push(richBlockFromLine(text, info));
    const prefixLength = text.length - toText(info.body).length;
    lineMap.push(
      lineEntry(blocks.length - 1, 0, prefixLength, toText(info.body).length, blockLength(blocks[blocks.length - 1])),
    );
    imageTargets.push(null);
    index += 1;
  }

  if (!blocks.length) {
    blocks.push(emptyParagraph());
  }

  return { blocks, lineMap, imageTargets };
}

function sourceLine(text) {
  const block = createBlock("p", text ? [{ text }] : []);
  block.source = true;
  return block;
}

function lineEntry(richIndex, lineOffset, prefixLength, length, richLength, html) {
  const entry = { richIndex, lineOffset, prefixLength, length, richLength };
  if (html) {
    entry.html = true;
  }
  return entry;
}

function isLoneEmptyParagraph(blocks) {
  if (blocks.length !== 1) {
    return false;
  }
  const block = blocks[0];
  if (!block || block.type !== "p" || blockLength(block) !== 0) {
    return false;
  }
  return blockAlignment(block) === "left" && blockIndent(block) === 0;
}

/* --------------------------------------------------------------------------
   One rich block -> its source lines
   -------------------------------------------------------------------------- */

function blockLinesFor(block, counters) {
  if (!block || block.type === "image") {
    return { lines: [], kind: "image", prefixLength: 0 };
  }

  if (block.type === "code") {
    const text = blockText(block);
    const fence = "`".repeat(fenceForCode(text));
    return { lines: [fence, ...text.split("\n"), fence], kind: "code", prefixLength: 0 };
  }

  const runs = safeRuns(block.runs);
  const markdown = inlineMarkdownFor(runs);
  const exact = markdown !== null && runsEquivalent(inlineToRuns(markdown), runs);
  const attributes = blockAttributes(block);

  if (!exact || attributes) {
    return { lines: [htmlLineFor(block, runs, attributes)], kind: "html", prefixLength: 0 };
  }

  switch (block.type) {
    case "h1":
    case "h2":
    case "h3": {
      const level = HEADING_LEVELS[block.type];
      return { lines: ["#".repeat(level) + " " + markdown], kind: "markdown", prefixLength: level + 1 };
    }
    case "quote":
      return { lines: ["> " + markdown], kind: "markdown", prefixLength: 2 };
    case "list": {
      const depth = depthOf(block);
      const ordered = Boolean(block.ordered);
      counters.length = depth + 1;
      let marker;
      if (ordered) {
        counters[depth] = (counters[depth] || 0) + 1;
        marker = counters[depth] + ". ";
      } else {
        marker = "- ";
      }
      const indent = "  ".repeat(depth);
      return {
        lines: [indent + marker + markdown],
        kind: "markdown",
        prefixLength: indent.length + marker.length,
      };
    }
    default: {
      if (!markdown) {
        // An empty paragraph is a blank source line, not an HTML escape: the
        // line the user sees and leaves in the source is a real line break.
        return { lines: [""], kind: "markdown", prefixLength: 0 };
      }
      const line = paragraphLineFor(markdown, runs);
      if (line === null) {
        return { lines: [htmlLineFor(block, runs, attributes)], kind: "html", prefixLength: 0 };
      }
      return { lines: [line], kind: "markdown", prefixLength: 0 };
    }
  }
}

// A paragraph line must not be readable as a heading, quote, list, fence, or
// HTML escape hatch. Escape the first structural character when it would be.
function paragraphLineFor(markdown, runs) {
  const direct = readLine(markdown);
  if (direct.kind === "p" && direct.body === markdown) {
    return markdown;
  }
  if (!markdown) {
    return null;
  }
  let escaped = null;
  if (markdown[0] === "#" || markdown[0] === ">" || markdown[0] === "-" || markdown[0] === "+") {
    escaped = "\\" + markdown;
  } else {
    escaped = markdown.replace(/^(\d+)\./, "$1\\.");
  }
  if (escaped === markdown) {
    return null;
  }
  const info = readLine(escaped);
  if (info.kind !== "p") {
    return null;
  }
  if (!runsEquivalent(inlineToRuns(escaped), runs)) {
    return null;
  }
  return escaped;
}

function blockAttributes(block) {
  let attributes = "";
  const align = blockAlignment(block);
  if (align !== "left") {
    attributes += ' data-align="' + align + '"';
  }
  const indent = blockIndent(block);
  if (indent > 0) {
    attributes += ' data-indent="' + indent + '"';
  }
  return attributes;
}

function htmlLineFor(block, runs, attributes) {
  const inner = serializeRuns(runs, { allowBreaks: true });
  switch (block.type) {
    case "quote":
      return "<blockquote><p" + attributes + ">" + inner + "</p></blockquote>";
    case "list": {
      const ordered = Boolean(block.ordered);
      const tag = ordered ? "ol" : "ul";
      const depth = depthOf(block);
      return (
        "<" +
        tag +
        ' data-depth="' +
        depth +
        '" data-ordered="' +
        (ordered ? "1" : "0") +
        '"><li' +
        attributes +
        ">" +
        inner +
        "</li></" +
        tag +
        ">"
      );
    }
    case "h1":
    case "h2":
    case "h3":
      return "<" + block.type + attributes + ">" + inner + "</" + block.type + ">";
    default:
      return "<p" + attributes + ">" + inner + "</p>";
  }
}

/* --------------------------------------------------------------------------
   Accepted HTML escape-hatch lines
   -------------------------------------------------------------------------- */

function parseBlockAttributes(attributes) {
  let rest = attributes;
  let align = null;
  let indent = null;
  while (rest) {
    let match = /^ data-align="([^"]*)"/.exec(rest);
    if (match) {
      if (align !== null || !ALIGNMENTS.has(match[1])) {
        return null;
      }
      align = match[1];
      rest = rest.slice(match[0].length);
      continue;
    }
    match = /^ data-indent="([^"]*)"/.exec(rest);
    if (match) {
      if (indent !== null || !/^[1-6]$/.test(match[1])) {
        return null;
      }
      indent = match[1];
      rest = rest.slice(match[0].length);
      continue;
    }
    return null;
  }
  return { align, indent };
}

function parseListAttributes(attributes) {
  let rest = attributes;
  let depth = null;
  let ordered = null;
  while (rest) {
    let match = /^ data-depth="([0-9])"/.exec(rest);
    if (match) {
      if (depth !== null || Number(match[1]) > LIST_DEPTH_LIMIT) {
        return null;
      }
      depth = Number(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }
    match = /^ data-ordered="([01])"/.exec(rest);
    if (match) {
      if (ordered !== null) {
        return null;
      }
      ordered = Number(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }
    return null;
  }
  return { depth, ordered };
}

// Accepts only inline content serializeRuns() can produce: text plus balanced
// b/i/u/s/code/a/br tags, the anchor with a validated http(s)/mailto href.
function isAcceptedInlineHtml(content) {
  const stack = [];
  let position = 0;
  while (position < content.length) {
    const open = content.indexOf("<", position);
    if (open === -1) {
      break;
    }
    const close = content.indexOf(">", open + 1);
    if (close === -1) {
      return false;
    }
    const token = content.slice(open, close + 1);
    position = close + 1;
    if (token === "<br>" || token === "<br/>") {
      continue;
    }
    const closing = /^<\/([a-z]+)>$/.exec(token);
    if (closing) {
      if (!INLINE_HTML_TAGS.has(closing[1]) || stack.pop() !== closing[1]) {
        return false;
      }
      continue;
    }
    const opening = /^<([a-z]+)([^<>]*)>$/.exec(token);
    if (!opening) {
      return false;
    }
    const name = opening[1];
    const attributes = opening[2];
    if (!INLINE_HTML_TAGS.has(name)) {
      return false;
    }
    if (name === "a") {
      const href = /^ href="([^"]*)"$/.exec(attributes);
      if (!href || !isSafeHref(href[1])) {
        return false;
      }
    } else if (attributes.length) {
      return false;
    }
    stack.push(name);
  }
  return stack.length === 0;
}

function classifyHtmlLine(line) {
  if (!line || line[0] !== "<") {
    return null;
  }
  let match = /^<h([1-3])([^<>]*)>/.exec(line);
  if (match) {
    const shape = "h" + match[1];
    if (!parseBlockAttributes(match[2])) {
      return null;
    }
    const closing = "</" + shape + ">";
    if (!line.endsWith(closing)) {
      return null;
    }
    const content = line.slice(match[0].length, line.length - closing.length);
    if (!isAcceptedInlineHtml(content)) {
      return null;
    }
    return { shape };
  }
  match = /^<p([^<>]*)>/.exec(line);
  if (match) {
    if (!parseBlockAttributes(match[1])) {
      return null;
    }
    const closing = "</p>";
    if (!line.endsWith(closing)) {
      return null;
    }
    const content = line.slice(match[0].length, line.length - closing.length);
    if (!isAcceptedInlineHtml(content)) {
      return null;
    }
    return { shape: "p" };
  }
  match = /^<blockquote([^<>]*)>/.exec(line);
  if (match) {
    if (match[1].trim()) {
      return null;
    }
    const closing = "</blockquote>";
    if (!line.endsWith(closing)) {
      return null;
    }
    const inner = line.slice(match[0].length, line.length - closing.length);
    const paragraph = /^<p([^<>]*)>/.exec(inner);
    if (!paragraph || !inner.endsWith("</p>")) {
      return null;
    }
    if (!parseBlockAttributes(paragraph[1])) {
      return null;
    }
    const content = inner.slice(paragraph[0].length, inner.length - "</p>".length);
    if (!isAcceptedInlineHtml(content)) {
      return null;
    }
    return { shape: "quote" };
  }
  match = /^<(ul|ol)([^<>]*)>/.exec(line);
  if (match) {
    const tag = match[1];
    const listAttributes = parseListAttributes(match[2]);
    if (!listAttributes) {
      return null;
    }
    const closing = "</" + tag + ">";
    if (!line.endsWith(closing)) {
      return null;
    }
    const inner = line.slice(match[0].length, line.length - closing.length);
    const item = /^<li([^<>]*)>/.exec(inner);
    if (!item || !inner.endsWith("</li>")) {
      return null;
    }
    if (!parseBlockAttributes(item[1])) {
      return null;
    }
    const content = inner.slice(item[0].length, inner.length - "</li>".length);
    if (!isAcceptedInlineHtml(content)) {
      return null;
    }
    const ordered = tag === "ol";
    if (listAttributes.ordered !== null && (listAttributes.ordered === 1) !== ordered) {
      return null;
    }
    return { shape: "list", ordered, depth: listAttributes.depth === null ? 0 : listAttributes.depth };
  }
  return null;
}

function parseHtmlLine(line) {
  const info = classifyHtmlLine(line);
  if (!info) {
    return null;
  }
  let blocks;
  try {
    blocks = parseDocument(line);
  } catch (error) {
    return null;
  }
  if (blocks.length !== 1) {
    return null;
  }
  if (info.shape === "list") {
    if (blocks[0].type !== "list") {
      return null;
    }
    blocks[0].ordered = Boolean(info.ordered);
    blocks[0].depth = clampNumber(info.depth, 0, LIST_DEPTH_LIMIT);
    return blocks;
  }
  return blocks[0].type === info.shape ? blocks : null;
}

/* --------------------------------------------------------------------------
   Caret maps
   -------------------------------------------------------------------------- */

function richEntryLength(entry) {
  if (!entry) {
    return 0;
  }
  if (Number.isFinite(entry.richLength)) {
    return Math.max(0, Math.floor(entry.richLength));
  }
  return Math.max(0, Math.floor(Number(entry.lineOffset) || 0) + Math.floor(Number(entry.length) || 0));
}

/**
 * Map a collapsed rich caret to a source caret after richToSource().
 *
 * @param {{lineMap: Array, richLines: Array}} conversion
 * @param {{block: number, offset: number}} caret rich caret
 * @returns {{block: number, offset: number}} source caret
 */
export function mapRichCaretToSource(conversion, caret) {
  const lineMap = conversion && Array.isArray(conversion.lineMap) ? conversion.lineMap : [];
  const richLines = conversion && Array.isArray(conversion.richLines) ? conversion.richLines : [];
  if (!richLines.length) {
    return { block: 0, offset: 0 };
  }
  const block = clampNumber(caret && caret.block, 0, richLines.length - 1);
  const offset = Math.max(0, Math.floor(Number(caret && caret.offset) || 0));
  const entry = richLines[block];

  if (entry === null || entry === undefined) {
    // Image blocks map to the image source block that carries them.
    let ordinal = 0;
    for (let index = 0; index < block; index += 1) {
      if (richLines[index] === null) {
        ordinal += 1;
      }
    }
    let seen = 0;
    for (let index = 0; index < lineMap.length; index += 1) {
      if (lineMap[index] !== null) {
        continue;
      }
      if (seen === ordinal) {
        return { block: index, offset: 0 };
      }
      seen += 1;
    }
    for (let index = 0; index < lineMap.length; index += 1) {
      const candidate = lineMap[index];
      if (candidate) {
        return { block: index, offset: Math.max(0, Math.floor(Number(candidate.prefixLength) || 0)) };
      }
    }
    return { block: 0, offset: 0 };
  }

  const richOffset = Math.min(offset, richEntryLength(entry));

  if (entry.code && Array.isArray(entry.segments) && entry.segments.length) {
    let segment = entry.segments[0];
    for (const candidate of entry.segments) {
      if (candidate.offsetStart <= richOffset) {
        segment = candidate;
      } else {
        break;
      }
    }
    const line = lineMap[segment.sourceIndex] || { prefixLength: 0, length: 0 };
    const prefix = Math.max(0, Math.floor(Number(line.prefixLength) || 0));
    const within = richOffset - segment.offsetStart;
    const clamped = Math.min(Math.max(0, within), Math.max(0, Math.floor(Number(line.length) || 0)));
    return { block: segment.sourceIndex, offset: prefix + clamped };
  }

  const sourceIndex = Math.min(Math.max(0, Math.floor(Number(entry.sourceIndex) || 0)), Math.max(0, lineMap.length - 1));
  if (entry.html) {
    return { block: sourceIndex, offset: 0 };
  }
  const line = lineMap[sourceIndex];
  if (!line) {
    return { block: sourceIndex, offset: 0 };
  }
  const prefix = Math.max(0, Math.floor(Number(line.prefixLength) || 0));
  const body = Math.min(Math.max(0, Math.floor(Number(line.length) || 0)), richOffset);
  return { block: sourceIndex, offset: prefix + body };
}

/**
 * Map a collapsed source caret to a rich caret after sourceToRich().
 *
 * @param {{lineMap: Array}} conversion
 * @param {{block: number, offset: number}} caret source caret
 * @returns {{block: number, offset: number}} rich caret
 */
export function mapSourceCaretToRich(conversion, caret) {
  const lineMap = conversion && Array.isArray(conversion.lineMap) ? conversion.lineMap : [];
  if (!lineMap.length) {
    return { block: 0, offset: 0 };
  }
  const index = clampNumber(caret && caret.block, 0, lineMap.length - 1);
  const offset = Math.max(0, Math.floor(Number(caret && caret.offset) || 0));

  if (!lineMap[index]) {
    // A source image keeps its caret on the rich image block that carries it.
    if (conversion && Array.isArray(conversion.imageTargets)) {
      const target = conversion.imageTargets[index];
      if (Number.isInteger(target) && target >= 0) {
        return { block: target, offset: 0 };
      }
    }
    // A blank line resolves to the nearest rich position: the end of the
    // previous block, else the start of the next one.
    for (let before = index - 1; before >= 0; before -= 1) {
      const previous = lineMap[before];
      if (previous) {
        return { block: Math.max(0, Math.floor(Number(previous.richIndex) || 0)), offset: richEntryLength(previous) };
      }
    }
    for (let after = index + 1; after < lineMap.length; after += 1) {
      const next = lineMap[after];
      if (next) {
        return {
          block: Math.max(0, Math.floor(Number(next.richIndex) || 0)),
          offset: Math.max(0, Math.floor(Number(next.lineOffset) || 0)),
        };
      }
    }
    return { block: 0, offset: 0 };
  }

  const entry = lineMap[index];
  const prefix = Math.max(0, Math.floor(Number(entry.prefixLength) || 0));
  const bodyLength = Math.max(0, Math.floor(Number(entry.length) || 0));
  const richTotal = richEntryLength(entry);
  const start = Math.max(0, Math.floor(Number(entry.lineOffset) || 0));
  const available = Math.min(bodyLength, Math.max(0, richTotal - start));
  const richOffset = Math.min(richTotal, start + Math.min(Math.max(offset - prefix, 0), available));
  return { block: Math.max(0, Math.floor(Number(entry.richIndex) || 0)), offset: richOffset };
}

/* --------------------------------------------------------------------------
   Visible text
   -------------------------------------------------------------------------- */

/**
 * Strip inline Markdown markers from a line body, keeping the visible text.
 * `<br>` stays a hard break; other inline HTML is removed with its tags.
 */
export function stripInline(text) {
  const source = toText(text);
  const stripped = stripInlineTags(source);
  return inlineToRuns(stripped)
    .map((run) => run.text)
    .join("");
}

// Removes inline HTML tags while keeping published text. Escapes and code spans
// are copied through untouched, so `\<b>` and `` `<b>` `` stay visible.
function stripInlineTags(text) {
  const index = buildInlineIndex(text);
  let out = "";
  let position = 0;
  while (position < text.length) {
    const char = text[position];
    if (char === "\\") {
      out += char;
      if (position + 1 < text.length) {
        out += text[position + 1];
        position += 2;
      } else {
        position += 1;
      }
      continue;
    }
    if (char === "`") {
      const runLength = countRun(text, position, text.length, "`");
      const close = firstDelimiterAtOrAfter(index["`"], position + runLength, runLength);
      if (close >= 0) {
        out += text.slice(position, close + runLength);
        position = close + runLength;
        continue;
      }
      out += "`".repeat(runLength);
      position += runLength;
      continue;
    }
    if (char === "<") {
      const close = text.indexOf(">", position + 1);
      if (close === -1) {
        out += char;
        position += 1;
        continue;
      }
      const tag = text.slice(position, close + 1);
      if (/^<br\s*\/?>$/i.test(tag)) {
        out += "\n";
      }
      position = close + 1;
      continue;
    }
    out += char;
    position += 1;
  }
  return out;
}
