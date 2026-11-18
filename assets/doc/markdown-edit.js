// Toolbar commands for Markdown mode.
//
// While Markdown mode is on the editor holds source blocks (paragraph blocks
// with `source: true` holding one Markdown line each, plus image blocks), so
// the normal rich-text commands (toggleMark, setBlockType, setAlignment, ...)
// do not apply. These functions edit the Markdown source directly instead and
// return the blocks and selection to commit. They are pure: no editor state,
// no DOM, no saving.
//
// Every action returns `{blocks, anchor, focus}` or null when nothing changed.
// The editor calls editor.commit(result.blocks, result.anchor, result.focus),
// which gives each toolbar action its own undo step and lets the save debounce
// handle persistence as usual. Blocks that change must get a new id from
// createBlockId() so the layout cache re-prepares them, and blocks that do not
// change keep their identity.

import {
  blockAlignment,
  blockLength,
  blockText,
  createBlock,
  createBlockId,
  marksAt,
  setHrefOnRuns,
  setMarkOnRuns,
} from "./model.js";
import {
  blockToLines,
  lineToBlocks,
  readLine,
  sourceLineInfo,
  stripInline,
} from "./markdown.js";

const STYLES = new Set(["p", "h1", "h2", "h3", "quote", "code"]);
const ALIGNMENTS = new Set(["left", "center", "right", "justify"]);
const MARK_KEYS = new Set(["b", "i", "u", "s", "code"]);
const FENCE_KINDS = new Set(["fenceOpen", "fenceClose", "codeContent"]);
const INLINE_KINDS = new Set(["p", "h1", "h2", "h3", "quote", "list", "blank"]);

/* --------------------------------------------------------------------------
   Small model helpers
   -------------------------------------------------------------------------- */

function lineText(block) {
  if (!block || block.type === "image") {
    return "";
  }
  return blockText(block);
}

function runsFor(text) {
  return text ? [{ text }] : [];
}

function sourceLine(text) {
  const block = createBlock("p", runsFor(text));
  block.source = true;
  return block;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function replaceLines(blocks, changed) {
  const next = blocks.slice();
  for (const [index, text] of changed) {
    next[index] = { ...blocks[index], id: createBlockId(), runs: runsFor(text) };
  }
  return next;
}

function styleOfBlock(block) {
  if (!block) {
    return "p";
  }
  if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
    return block.type;
  }
  if (block.type === "quote" || block.type === "code") {
    return block.type;
  }
  return "p";
}

function isInlineLine(info) {
  return Boolean(info) && INLINE_KINDS.has(info.kind);
}

function isFence(kind) {
  return FENCE_KINDS.has(kind);
}

function normalizeSelection(selection) {
  const clampPosition = (position) => ({
    block: Math.max(0, Math.floor(position.block)),
    offset: Math.max(0, Math.floor(position.offset)),
  });
  const anchor = clampPosition(selection.anchor || { block: 0, offset: 0 });
  const focus = clampPosition(selection.focus || anchor);
  const collapsed =
    Boolean(selection.collapsed) || (anchor.block === focus.block && anchor.offset === focus.offset);
  const forward =
    anchor.block < focus.block || (anchor.block === focus.block && anchor.offset <= focus.offset);
  return {
    anchor,
    focus,
    collapsed,
    from: forward ? anchor : focus,
    to: forward ? focus : anchor,
  };
}

function lineStart(sel, index) {
  return index === sel.from.block ? sel.from.offset : 0;
}

function lineEnd(sel, index, length) {
  return index === sel.to.block ? sel.to.offset : length;
}

// The Markdown marker prefix (a heading's hashes, a list marker, a quote's
// "> ") belongs to the line's structure, not to its inline text. Inline edits
// must stay in the body: wrapping a whole heading line, as a Ctrl+A selection
// used to, writes "**# Title**", which reparses as a paragraph whose visible
// text is literally "# Title".
function lineBodyStart(info, text) {
  if (!info || typeof info.body !== "string") {
    return 0;
  }
  return Math.max(0, text.length - info.body.length);
}

// A pair whose marker run or content overlaps the range. Adding markers next
// to an existing emphasis/code span would extend its delimiter run into a run
// the dialect reads literally ("*****" is text), so toolbar edits stay out of
// these spans instead of corrupting the line.
function pairTouching(pairs, start, end) {
  for (const pair of pairs) {
    if (start < pair.closeEnd && end > pair.openStart) {
      return pair;
    }
  }
  return null;
}

function pairAroundOffset(pairs, offset) {
  for (const pair of pairs) {
    if (offset >= pair.openEnd && offset <= pair.closeStart) {
      return pair;
    }
  }
  return null;
}

function linkTokenTouching(tokens, start, end) {
  for (const token of tokens) {
    if (token.kind !== "link") {
      continue;
    }
    if (start < token.end && end > token.start) {
      return token;
    }
  }
  return null;
}

// A collapsed caret may begin a new mark only in plain body text or inside a
// link's label (where nested inline formatting is valid). Inside an existing
// emphasis/code span, or inside a link's url syntax, the toolbar does nothing
// rather than injecting ambiguous markers.
function canBeginInlineMark(text, offset, info) {
  if (!info || !INLINE_KINDS.has(info.kind)) {
    return false;
  }
  if (offset < lineBodyStart(info, text)) {
    return false;
  }
  const { tokens, pairs } = tokenizeMarkdown(text);
  if (pairAroundOffset(pairs, offset)) {
    return false;
  }
  const link = linkTokenTouching(tokens, offset, offset + 1);
  if (link && !(offset >= link.labelStart && offset <= link.labelEnd)) {
    return false;
  }
  return true;
}

// The body-only range a selection may wrap on one line, or null when the
// selection cuts through an existing delimiter span or link syntax (wrapping
// it would corrupt the line).
function wrappableSelectionRange(text, info, start, end) {
  const bodyStart = lineBodyStart(info, text);
  const safeStart = Math.max(start, bodyStart);
  if (end <= safeStart) {
    return null;
  }
  const { tokens, pairs } = tokenizeMarkdown(text);
  if (pairTouching(pairs, safeStart, end)) {
    return null;
  }
  const link = linkTokenTouching(tokens, safeStart, end);
  if (link && !(safeStart >= link.labelStart && end <= link.labelEnd)) {
    return null;
  }
  return { start: safeStart, end };
}

// Map an offset through a set of non-overlapping edits to one line. Each edit
// replaces [start, end) with `text`; `mapInside` maps an offset that fell
// inside the replaced range (relative to its start) into the replacement.
function mapOffsetThroughEdits(offset, edits) {
  const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let shift = 0;
  for (const edit of sorted) {
    if (offset <= edit.start) {
      return offset + shift;
    }
    if (offset >= edit.end) {
      shift += edit.text.length - (edit.end - edit.start);
      continue;
    }
    const inner = offset - edit.start;
    const mapped = edit.mapInside ? edit.mapInside(inner) : Math.min(inner, edit.text.length);
    return edit.start + shift + mapped;
  }
  return offset + shift;
}

function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let result = "";
  let cursor = 0;
  for (const edit of sorted) {
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

// Build the result for commands that only rewrite line contents in place.
function mapLineChanges(blocks, sel, changed, editsByBlock) {
  const next = replaceLines(blocks, changed);
  const mapPosition = (position) => {
    const edits = editsByBlock.get(position.block);
    if (!edits || !edits.length) {
      return { ...position };
    }
    const text = changed.get(position.block);
    const mapped = mapOffsetThroughEdits(position.offset, edits);
    return { block: position.block, offset: clamp(mapped, 0, text.length) };
  };
  return { blocks: next, anchor: mapPosition(sel.anchor), focus: mapPosition(sel.focus) };
}

/* --------------------------------------------------------------------------
   Inline scanning: visible text, marker pairs, and links
   -------------------------------------------------------------------------- */

function countRun(text, start, char) {
  let end = start;
  while (end < text.length && text[end] === char) {
    end += 1;
  }
  return end - start;
}

function validHref(value) {
  const href = String(value || "").trim();
  if (!href) {
    return false;
  }
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return true;
    }
    return url.protocol === "mailto:" && href.toLowerCase().startsWith("mailto:");
  } catch (error) {
    return false;
  }
}

// The dialect's own href rule, for finding existing links exactly the way the
// parser does (setLink() gets an already-normalized url from the page). Stored
// documents can also carry relative and fragment links, so those are found and
// editable even though the link dialog only creates absolute ones.
function isDialectHref(value) {
  const href = String(value || "").trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href) || href.includes("\\")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return /^(?:https?:\/\/\S+|mailto:\S+)$/i.test(href);
  }
  return !href.startsWith("//");
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

function findLabelEnd(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

function findParenEnd(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

// One Markdown link at `start` ("["), or null. Mirrors the dialect parser: the
// label and url may nest brackets and parentheses, and the url is trimmed.
function parseLinkAt(text, start) {
  const labelEnd = findLabelEnd(text, start + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") {
    return null;
  }
  const close = findParenEnd(text, labelEnd + 2);
  if (close < 0) {
    return null;
  }
  const href = text.slice(labelEnd + 2, close).trim();
  if (!isDialectHref(href)) {
    return null;
  }
  return {
    start,
    end: close + 1,
    labelStart: start + 1,
    labelEnd,
    urlStart: labelEnd + 2,
    urlEnd: close,
    href,
  };
}

function tokenizeMarkdown(text) {
  const tokens = [];
  const pairs = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const escaped = index + 1 < text.length && isAsciiPunctuation(text[index + 1]);
      tokens.push({ kind: "text", start: index, end: index + (escaped ? 2 : 1), visible: 1 });
      index += escaped ? 2 : 1;
      continue;
    }
    if (char === "`") {
      const run = countRun(text, index, "`");
      let scan = index + run;
      let close = -1;
      while (scan < text.length) {
        if (text[scan] === "`") {
          const other = countRun(text, scan, "`");
          if (other === run) {
            close = scan;
            break;
          }
          scan += other;
        } else {
          scan += 1;
        }
      }
      if (close >= 0) {
        tokens.push({
          kind: "code",
          start: index,
          end: close + run,
          contentStart: index + run,
          contentEnd: close,
          visible: close - (index + run),
        });
        pairs.push({
          family: "`",
          openStart: index,
          openEnd: index + run,
          closeStart: close,
          closeEnd: close + run,
          runLength: run,
        });
        index = close + run;
      } else {
        tokens.push({ kind: "mark", family: "`", start: index, end: index + run, visible: run, runLength: run });
        index += run;
      }
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      const run = countRun(text, index, char);
      tokens.push({ kind: "mark", family: char, start: index, end: index + run, visible: 0, runLength: run });
      index += run;
      continue;
    }
    if (char === "<") {
      if (text.startsWith("<u>", index)) {
        tokens.push({ kind: "u", role: "open", start: index, end: index + 3, visible: 0, rawLength: 3 });
        index += 3;
        continue;
      }
      if (text.startsWith("</u>", index)) {
        tokens.push({ kind: "u", role: "close", start: index, end: index + 4, visible: 0, rawLength: 4 });
        index += 4;
        continue;
      }
      const br = /^<br\s*\/?>/i.exec(text.slice(index, index + 8));
      if (br) {
        tokens.push({ kind: "text", start: index, end: index + br[0].length, visible: 1 });
        index += br[0].length;
        continue;
      }
      tokens.push({ kind: "text", start: index, end: index + 1, visible: 1 });
      index += 1;
      continue;
    }
    // "![alt](url)" is image syntax the dialect cannot store: it stays literal
    // text, so its bracket must never start a link.
    if (char === "!" && text[index + 1] === "[") {
      tokens.push({ kind: "text", start: index, end: index + 1, visible: 1 });
      tokens.push({ kind: "text", start: index + 1, end: index + 2, visible: 1 });
      index += 2;
      continue;
    }
    if (char === "[") {
      const link = parseLinkAt(text, index);
      if (link) {
        const label = text.slice(link.labelStart, link.labelEnd);
        const labelTokens = tokenizeMarkdown(label).tokens;
        tokens.push({
          kind: "link",
          start: index,
          end: link.end,
          labelStart: link.labelStart,
          labelEnd: link.labelEnd,
          urlStart: link.urlStart,
          urlEnd: link.urlEnd,
          href: link.href,
          visible: sumVisible(labelTokens, label.length),
        });
        index = link.end;
        continue;
      }
      tokens.push({ kind: "text", start: index, end: index + 1, visible: 1 });
      index += 1;
      continue;
    }
    tokens.push({ kind: "text", start: index, end: index + 1, visible: 1 });
    index += 1;
  }

  pairMarkers(tokens, pairs);
  return { tokens, pairs };
}

// Pair marker runs in order (nesting different lengths works because a run can
// only close a run of its own length) and collapse empty marker pairs, which
// the canonical toolbar inserts next to each other ("****", "<u></u>", "``").
function pairMarkers(tokens, pairs) {
  for (const family of ["*", "_", "~", "`"]) {
    const list = tokens.filter((token) => token.kind === "mark" && token.family === family);
    const paired = new Set();
    const stack = [];
    for (const token of list) {
      // The dialect only reads "~~" as strike and only runs of one to three
      // markers as emphasis; longer runs are literal text.
      const pairable = family === "~" ? token.runLength === 2 : token.runLength <= 3;
      if (!pairable) {
        continue;
      }
      const top = stack[stack.length - 1];
      if (top && top.runLength === token.runLength) {
        stack.pop();
        paired.add(top);
        paired.add(token);
        token.visible = 0;
        top.visible = 0;
        pairs.push({
          family,
          openStart: top.start,
          openEnd: top.end,
          closeStart: token.start,
          closeEnd: token.end,
          runLength: token.runLength,
        });
      } else {
        stack.push(token);
      }
    }
    for (const token of list) {
      if (paired.has(token)) {
        continue;
      }
      // The toolbar inserts an empty marker pair as one adjacent run ("****",
      // "<u></u>", "``"); that run is both delimiters of an empty pair.
      const emptyPair =
        token.runLength % 2 === 0 && token.runLength >= (family === "`" ? 2 : 4);
      if (emptyPair) {
        token.visible = 0;
        const half = token.runLength / 2;
        pairs.push({
          family,
          openStart: token.start,
          openEnd: token.start + half,
          closeStart: token.start + half,
          closeEnd: token.end,
          runLength: half,
          synthetic: true,
        });
      } else {
        token.visible = token.runLength;
      }
    }
  }

  const underline = [];
  for (const token of tokens) {
    if (token.kind !== "u") {
      continue;
    }
    if (token.role === "open") {
      underline.push(token);
      continue;
    }
    if (underline.length) {
      const open = underline.pop();
      open.visible = 0;
      token.visible = 0;
      pairs.push({
        family: "u",
        openStart: open.start,
        openEnd: open.end,
        closeStart: token.start,
        closeEnd: token.end,
        runLength: 3,
      });
    } else {
      token.visible = token.rawLength;
    }
  }
  for (const token of underline) {
    token.visible = token.rawLength;
  }
}

function tokenizeHtml(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "<") {
      const slice = text.slice(index, index + 512);
      const br = /^<br\s*\/?>/i.exec(slice);
      if (br) {
        tokens.push({ kind: "text", start: index, end: index + br[0].length, visible: 1 });
        index += br[0].length;
        continue;
      }
      const tag = /^<\/?[a-zA-Z][^>]*>/.exec(slice);
      if (tag) {
        tokens.push({ kind: "tag", start: index, end: index + tag[0].length, visible: 0 });
        index += tag[0].length;
        continue;
      }
    }
    if (char === "&") {
      const entity = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(
        text.slice(index, index + 40),
      );
      if (entity) {
        tokens.push({ kind: "entity", start: index, end: index + entity[0].length, visible: 1 });
        index += entity[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", start: index, end: index + 1, visible: 1 });
    index += 1;
  }
  return { tokens, pairs: [] };
}

function tokenize(text, htmlMode) {
  return htmlMode ? tokenizeHtml(text) : tokenizeMarkdown(text);
}

function sumVisible(tokens, limit) {
  let count = 0;
  for (const token of tokens) {
    if (token.start >= limit) {
      break;
    }
    if (token.end <= limit) {
      count += token.visible;
    } else {
      break;
    }
  }
  return count;
}

function rawIndexForVisible(text, tokens, target) {
  let count = 0;
  for (const token of tokens) {
    if (token.visible === 0) {
      continue;
    }
    if (count === target) {
      return token.start;
    }
    if (count + token.visible <= target) {
      count += token.visible;
      continue;
    }
    if (token.kind === "link") {
      const label = text.slice(token.labelStart, token.labelEnd);
      const labelTokens = tokenizeMarkdown(label).tokens;
      return token.labelStart + rawIndexForVisible(label, labelTokens, target - count);
    }
    if (token.kind === "code") {
      return token.contentStart + Math.min(target - count, token.visible);
    }
    return token.start + Math.max(0, target - count);
  }
  return text.length;
}

// Visible character count before a raw offset of one source line. Rich block
// offsets count visible text only, so this maps a source caret to a rich one.
function visibleOffsetForInfo(text, offset, info) {
  if (!info) {
    return 0;
  }
  if (info.kind === "html") {
    return sumVisible(tokenizeHtml(text).tokens, clamp(offset, 0, text.length));
  }
  const body = info.body === undefined ? "" : info.body;
  const prefix = Math.max(0, text.length - body.length);
  const bodyOffset = clamp(offset - prefix, 0, body.length);
  return sumVisible(tokenizeMarkdown(body).tokens, bodyOffset);
}

function rawOffsetForInfo(text, visible, info) {
  if (!info) {
    return clamp(visible, 0, text.length);
  }
  if (info.kind === "html") {
    return clamp(rawIndexForVisible(text, tokenizeHtml(text).tokens, visible), 0, text.length);
  }
  const body = info.body === undefined ? "" : info.body;
  const prefix = Math.max(0, text.length - body.length);
  const offset = rawIndexForVisible(body, tokenizeMarkdown(body).tokens, visible);
  return clamp(prefix + offset, 0, text.length);
}

// Map a caret offset through a line rewrite that keeps the visible text.
function mapLineOffset(oldText, newText, offset) {
  if (oldText === newText) {
    return clamp(offset, 0, newText.length);
  }
  const oldInfo = readLine(oldText);
  const newInfo = readLine(newText);
  const visible = visibleOffsetForInfo(oldText, offset, oldInfo);
  return rawOffsetForInfo(newText, visible, newInfo);
}

function canonicalPairsFor(pairs, key) {
  if (key === "code") {
    return pairs.filter((pair) => pair.family === "`");
  }
  if (key === "u") {
    return pairs.filter((pair) => pair.family === "u");
  }
  const family = key === "b" || key === "i" ? "*" : "~";
  const markerLength = key === "i" ? 1 : 2;
  return pairs.filter(
    (pair) =>
      pair.family === family &&
      pair.openEnd - pair.openStart === markerLength &&
      pair.closeEnd - pair.closeStart === markerLength,
  );
}

function pairContaining(pairs, offset) {
  for (const pair of pairs) {
    if (offset > pair.openStart && offset < pair.closeEnd) {
      return pair;
    }
  }
  return null;
}

function pairEnclosingSelection(pairs, start, end) {
  for (const pair of pairs) {
    if (pair.openEnd === start && pair.closeStart === end) {
      return pair;
    }
    if (pair.openStart === start && pair.closeEnd === end) {
      return pair;
    }
  }
  return null;
}

function removalEdits(pair) {
  return [
    { start: pair.openStart, end: pair.openEnd, text: "" },
    { start: pair.closeStart, end: pair.closeEnd, text: "" },
  ];
}

function longestRun(text, char) {
  let longest = 0;
  for (const match of String(text).matchAll(new RegExp("\\" + char + "+", "g"))) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function markerPairFor(key, selected) {
  if (key === "b") {
    return { open: "**", close: "**" };
  }
  if (key === "i") {
    return { open: "*", close: "*" };
  }
  if (key === "u") {
    return { open: "<u>", close: "</u>" };
  }
  if (key === "s") {
    return { open: "~~", close: "~~" };
  }
  const run = "`".repeat(1 + longestRun(selected, "`"));
  return { open: run, close: run };
}

function linkTokens(text) {
  return tokenizeMarkdown(text).tokens.filter((token) => token.kind === "link");
}

function linkContaining(text, offset) {
  for (const link of linkTokens(text)) {
    if (offset >= link.start && offset <= link.end) {
      return link;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   Rich-only lines carried as serialized HTML
   --------------------------------------------------------------------------
   A line with alignment (or any other rich-only attribute) is stored in the
   source as the app's serialized HTML rather than as Markdown, so its inline
   marks and links are HTML tags. Editing Markdown markers inside that line
   would corrupt it; instead these helpers rewrite the line's rich block and
   let blockToLines() decide the canonical source form again. */

function richLineBlock(text) {
  const parsed = lineToBlocks(text);
  return parsed.length === 1 ? parsed[0] : null;
}

function rewriteEscapeLine(text, block) {
  const lines = blockToLines(block);
  if (lines.length !== 1) {
    return null;
  }
  const newText = lines[0];
  if (newText === text) {
    return null;
  }
  return {
    newText,
    edit: {
      start: 0,
      end: text.length,
      text: newText,
      mapInside: (inner) => mapLineOffset(text, newText, inner),
    },
  };
}

function runsAllMarked(block, start, end, key) {
  let position = 0;
  let found = false;
  for (const run of block.runs) {
    const runEnd = position + run.text.length;
    const from = Math.max(start, position);
    const to = Math.min(end, runEnd);
    if (to > from) {
      found = true;
      if (!run[key]) {
        return false;
      }
    }
    position = runEnd;
  }
  return found;
}

function enclosingRunRange(block, offset, predicate) {
  const runs = block.runs;
  let position = 0;
  let target = -1;
  for (let index = 0; index < runs.length; index += 1) {
    const end = position + runs[index].text.length;
    if (offset < end || (offset === end && index === runs.length - 1)) {
      target = index;
      break;
    }
    position = end;
  }
  if (target < 0 || !predicate(runs[target])) {
    return null;
  }
  let first = target;
  let last = target;
  while (first > 0 && predicate(runs[first - 1])) {
    first -= 1;
  }
  while (last < runs.length - 1 && predicate(runs[last + 1])) {
    last += 1;
  }
  let start = 0;
  for (let index = 0; index < first; index += 1) {
    start += runs[index].text.length;
  }
  let end = start;
  for (let index = first; index <= last; index += 1) {
    end += runs[index].text.length;
  }
  return { start, end };
}

function hrefRangeAt(block, offset) {
  const runs = block.runs;
  let position = 0;
  let target = -1;
  for (let index = 0; index < runs.length; index += 1) {
    const end = position + runs[index].text.length;
    if (offset < end || (offset === end && index === runs.length - 1)) {
      target = index;
      break;
    }
    position = end;
  }
  if (target < 0 || !runs[target].href) {
    return null;
  }
  const href = runs[target].href;
  let first = target;
  let last = target;
  while (first > 0 && runs[first - 1].href === href) {
    first -= 1;
  }
  while (last < runs.length - 1 && runs[last + 1].href === href) {
    last += 1;
  }
  let start = 0;
  for (let index = 0; index < first; index += 1) {
    start += runs[index].text.length;
  }
  let end = start;
  for (let index = first; index <= last; index += 1) {
    end += runs[index].text.length;
  }
  return { start, end, href };
}

function hrefRangeIn(block, start, end) {
  let position = 0;
  for (const run of block.runs) {
    const runEnd = position + run.text.length;
    if (runEnd > start && position < end && run.href) {
      return hrefRangeAt(block, position);
    }
    position = runEnd;
  }
  return null;
}

function escapeMarkCollapsed(blocks, index, text, info, offset, key) {
  const block = richLineBlock(text);
  if (!block || !block.runs.length) {
    return null;
  }
  const visible = clamp(visibleOffsetForInfo(text, offset, info), 0, blockLength(block));
  const marks = marksAt(block, visible);
  if (!marks[key]) {
    return null;
  }
  const range = enclosingRunRange(block, visible, (run) => Boolean(run[key]));
  if (!range) {
    return null;
  }
  const rewrite = rewriteEscapeLine(text, {
    ...block,
    id: createBlockId(),
    runs: setMarkOnRuns(block.runs, range.start, range.end, key, false),
  });
  if (!rewrite) {
    return null;
  }
  const caret = clamp(mapLineOffset(text, rewrite.newText, offset), 0, rewrite.newText.length);
  const next = replaceLines(blocks, new Map([[index, rewrite.newText]]));
  return {
    blocks: next,
    anchor: { block: index, offset: caret },
    focus: { block: index, offset: caret },
  };
}

function escapeMarkSelection(block, visibleStart, visibleEnd, key) {
  const value = !runsAllMarked(block, visibleStart, visibleEnd, key);
  return setMarkOnRuns(block.runs, visibleStart, visibleEnd, key, value);
}

/* --------------------------------------------------------------------------
   Toolbar state
   -------------------------------------------------------------------------- */

/**
 * Describe the current source selection for the toolbar: pressed marks, the
 * paragraph style label, alignment, list kind, and whether the caret is in a
 * link. Mirrors what DocEditor.sync() reports for rich mode.
 *
 * @param {Array} blocks source blocks
 * @param {{anchor: {block: number, offset: number}, focus: {block: number, offset: number}, collapsed: boolean}} selection
 * @returns {{
 *   marks: {b: boolean, i: boolean, u: boolean, s: boolean, code: boolean, href: string},
 *   style: "p"|"h1"|"h2"|"h3"|"quote"|"code",
 *   align: "left"|"center"|"right"|"justify",
 *   ordered: boolean|null,
 *   href: string
 * }}
 */
export function inspect(blocks, selection) {
  const emptyMarks = { b: false, i: false, u: false, s: false, code: false, href: "" };
  const result = { marks: emptyMarks, style: "p", align: "left", ordered: null, href: "" };
  if (!blocks || !blocks.length) {
    return result;
  }

  const sel = normalizeSelection(selection);
  const focusIndex = clamp(sel.focus.block, 0, blocks.length - 1);
  const markPosition = sel.collapsed ? sel.focus : sel.from;
  const markIndex = clamp(markPosition.block, 0, blocks.length - 1);
  // Selecting inside a fence needs fence context, but only up to the lines the
  // toolbar reports on: a caret near the top of a long document must not
  // classify the whole document on every caret move.
  const infos = sourceLineInfo(blocks.slice(0, Math.max(focusIndex, markIndex) + 1));
  const focusInfo = infos[focusIndex];
  const focusBlock = blocks[focusIndex];

  if (focusInfo && isFence(focusInfo.kind)) {
    result.style = "code";
  } else if (focusInfo && focusInfo.kind !== "image" && focusInfo.kind !== "blank") {
    const parsed = lineToBlocks(lineText(focusBlock));
    const block = parsed[0];
    if (block) {
      result.style = styleOfBlock(block);
      result.align = blockAlignment(block);
      result.ordered = block.type === "list" ? Boolean(block.ordered) : null;
    }
  }

  const markInfo = infos[markIndex];
  const markBlock = blocks[markIndex];
  if (markInfo && !isFence(markInfo.kind) && markInfo.kind !== "image" && markInfo.kind !== "blank") {
    const parsed = lineToBlocks(lineText(markBlock));
    if (parsed[0]) {
      const visible = visibleOffsetForInfo(lineText(markBlock), markPosition.offset, markInfo);
      const richOffset = clamp(visible, 0, blockLength(parsed[0]));
      result.marks = { ...emptyMarks, ...marksAt(parsed[0], richOffset) };
    }
    if (markInfo.kind !== "html") {
      const link = linkContaining(lineText(markBlock), markPosition.offset);
      if (link) {
        result.marks.href = link.href;
      }
    }
  }
  result.href = result.marks.href || "";
  return result;
}

/* --------------------------------------------------------------------------
   Inline formatting
   -------------------------------------------------------------------------- */

/**
 * Toggle one inline mark around the selection. Supported keys: "b", "i", "u",
 * "s", "code".
 *
 * A selection exactly enclosed by the canonical marker pair is unwrapped.
 * A collapsed caret removes the pair it sits inside; otherwise it returns
 * `{pending: key}` so the editor can arm the next typed text instead of
 * inserting an empty "****" run (which the dialect would store as literal
 * text). Inside existing emphasis/code spans, or on a rich-only HTML line, it
 * returns null: the edit would corrupt the line.
 *
 * @returns {{blocks: Array, anchor: Object, focus: Object}|{pending: string}|null}
 */
export function setMark(blocks, selection, key) {
  if (!MARK_KEYS.has(key) || !blocks || !blocks.length) {
    return null;
  }
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);

  if (sel.collapsed) {
    const index = clamp(sel.focus.block, 0, last);
    const info = infos[index];
    if (!info || isFence(info.kind) || info.kind === "image") {
      return null;
    }
    const block = blocks[index];
    const text = lineText(block);
    const offset = clamp(sel.focus.offset, 0, text.length);
    if (info.kind === "html") {
      return escapeMarkCollapsed(blocks, index, text, info, offset, key);
    }
    const pairs = canonicalPairsFor(tokenizeMarkdown(text).pairs, key);
    const pair = pairContaining(pairs, offset);
    if (pair) {
      const edits = removalEdits(pair);
      const newText = applyEdits(text, edits);
      const caret = clamp(mapOffsetThroughEdits(offset, edits), 0, newText.length);
      const changed = new Map([[index, newText]]);
      const next = replaceLines(blocks, changed);
      return { blocks: next, anchor: { block: index, offset: caret }, focus: { block: index, offset: caret } };
    }
    if (!canBeginInlineMark(text, offset, info)) {
      return null;
    }
    return { pending: key };
  }

  const changed = new Map();
  const editsByBlock = new Map();
  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info || isFence(info.kind)) {
      continue;
    }
    const text = lineText(block);
    const start = Math.max(clamp(lineStart(sel, index), 0, text.length), lineBodyStart(info, text));
    const end = clamp(lineEnd(sel, index, text.length), 0, text.length);
    if (end <= start) {
      continue;
    }
    if (info.kind === "html") {
      const rich = richLineBlock(text);
      if (!rich) {
        continue;
      }
      const length = blockLength(rich);
      const visibleStart = clamp(visibleOffsetForInfo(text, start, info), 0, length);
      const visibleEnd = clamp(visibleOffsetForInfo(text, end, info), 0, length);
      if (visibleEnd <= visibleStart) {
        continue;
      }
      const runs = escapeMarkSelection(rich, visibleStart, visibleEnd, key);
      const rewrite = rewriteEscapeLine(text, { ...rich, id: createBlockId(), runs });
      if (!rewrite) {
        continue;
      }
      changed.set(index, rewrite.newText);
      editsByBlock.set(index, [rewrite.edit]);
      continue;
    }
    const pairs = canonicalPairsFor(tokenizeMarkdown(text).pairs, key);
    const pair = pairEnclosingSelection(pairs, start, end);
    let edits;
    if (pair) {
      edits = removalEdits(pair);
    } else {
      const safe = wrappableSelectionRange(text, info, start, end);
      if (!safe) {
        continue;
      }
      const marker = markerPairFor(key, text.slice(safe.start, safe.end));
      edits = [
        {
          start: safe.start,
          end: safe.end,
          text: marker.open + text.slice(safe.start, safe.end) + marker.close,
          mapInside: (inner) => marker.open.length + inner,
        },
      ];
    }
    const newText = applyEdits(text, edits);
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, edits);
  }
  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}

/**
 * Point the selection at an existing Markdown link, or turn the selected text
 * into `[text](href)`. Replaces the url when the selection is already a link.
 *
 * @returns {{blocks: Array, anchor: Object, focus: Object}|null}
 */
export function setLink(blocks, selection, href) {
  if (!blocks || !blocks.length || !validHref(href)) {
    return null;
  }
  const value = String(href).trim();
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);
  const changed = new Map();
  const editsByBlock = new Map();

  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info) {
      continue;
    }
    if (!isInlineLine(info) && info.kind !== "html") {
      continue;
    }
    if (isFence(info.kind) || info.kind === "blank") {
      continue;
    }
    const text = lineText(block);
    if (info.kind === "html") {
      const rich = richLineBlock(text);
      if (!rich) {
        continue;
      }
      const length = blockLength(rich);
      let range = null;
      if (sel.collapsed) {
        if (index !== clamp(sel.focus.block, 0, last)) {
          continue;
        }
        const visible = clamp(visibleOffsetForInfo(text, sel.focus.offset, info), 0, length);
        range = hrefRangeAt(rich, visible);
      } else {
        const start = clamp(lineStart(sel, index), 0, text.length);
        const end = clamp(lineEnd(sel, index, text.length), 0, text.length);
        if (end <= start) {
          continue;
        }
        const visibleStart = clamp(visibleOffsetForInfo(text, start, info), 0, length);
        const visibleEnd = clamp(visibleOffsetForInfo(text, end, info), 0, length);
        if (visibleEnd > visibleStart) {
          range = { start: visibleStart, end: visibleEnd };
        }
      }
      if (!range) {
        continue;
      }
      const runs = setHrefOnRuns(rich.runs, range.start, range.end, value);
      const rewrite = rewriteEscapeLine(text, { ...rich, id: createBlockId(), runs });
      if (!rewrite) {
        continue;
      }
      changed.set(index, rewrite.newText);
      editsByBlock.set(index, [rewrite.edit]);
      continue;
    }
    const links = linkTokens(text);
    let existing = null;
    let start = 0;
    let end = 0;
    if (sel.collapsed) {
      if (index !== clamp(sel.focus.block, 0, last)) {
        continue;
      }
      const offset = clamp(sel.focus.offset, 0, text.length);
      existing = links.find((link) => offset >= link.start && offset <= link.end) || null;
      if (!existing) {
        continue;
      }
    } else {
      start = Math.max(clamp(lineStart(sel, index), 0, text.length), lineBodyStart(info, text));
      end = clamp(lineEnd(sel, index, text.length), 0, text.length);
      if (end <= start) {
        continue;
      }
      existing = links.find((link) => link.start < end && link.end > start) || null;
    }

    let edit;
    if (existing) {
      edit = { start: existing.urlStart, end: existing.urlEnd, text: value };
    } else {
      const safe = wrappableSelectionRange(text, info, start, end);
      if (!safe) {
        continue;
      }
      const label = text.slice(safe.start, safe.end);
      edit = {
        start: safe.start,
        end: safe.end,
        text: "[" + label + "](" + value + ")",
        mapInside: (inner) => 1 + inner,
      };
    }
    const newText = applyEdits(text, [edit]);
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, [edit]);
  }

  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}

/**
 * Remove the Markdown link around the selection, keeping its label text.
 *
 * @returns {{blocks: Array, anchor: Object, focus: Object}|null}
 */
export function removeLink(blocks, selection) {
  if (!blocks || !blocks.length) {
    return null;
  }
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);
  const changed = new Map();
  const editsByBlock = new Map();

  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info) {
      continue;
    }
    if (!isInlineLine(info) && info.kind !== "html") {
      continue;
    }
    if (isFence(info.kind) || info.kind === "blank") {
      continue;
    }
    const text = lineText(block);
    if (info.kind === "html") {
      const rich = richLineBlock(text);
      if (!rich) {
        continue;
      }
      const length = blockLength(rich);
      let range = null;
      if (sel.collapsed) {
        if (index !== clamp(sel.focus.block, 0, last)) {
          continue;
        }
        const visible = clamp(visibleOffsetForInfo(text, sel.focus.offset, info), 0, length);
        range = hrefRangeAt(rich, visible);
      } else {
        const start = clamp(lineStart(sel, index), 0, text.length);
        const end = clamp(lineEnd(sel, index, text.length), 0, text.length);
        if (end > start) {
          const visibleStart = clamp(visibleOffsetForInfo(text, start, info), 0, length);
          const visibleEnd = clamp(visibleOffsetForInfo(text, end, info), 0, length);
          if (visibleEnd > visibleStart) {
            range = { start: visibleStart, end: visibleEnd };
          }
        }
      }
      if (!range) {
        continue;
      }
      const runs = setHrefOnRuns(rich.runs, range.start, range.end, "");
      const rewrite = rewriteEscapeLine(text, { ...rich, id: createBlockId(), runs });
      if (!rewrite) {
        continue;
      }
      changed.set(index, rewrite.newText);
      editsByBlock.set(index, [rewrite.edit]);
      continue;
    }
    const links = linkTokens(text);
    let targets = [];
    if (sel.collapsed) {
      if (index !== clamp(sel.focus.block, 0, last)) {
        continue;
      }
      const offset = clamp(sel.focus.offset, 0, text.length);
      const link = links.find((candidate) => offset >= candidate.start && offset <= candidate.end);
      if (link) {
        targets = [link];
      }
    } else {
      const start = clamp(lineStart(sel, index), 0, text.length);
      const end = clamp(lineEnd(sel, index, text.length), 0, text.length);
      if (end <= start) {
        continue;
      }
      targets = links.filter((link) => link.start < end && link.end > start);
    }
    if (!targets.length) {
      continue;
    }
    const edits = targets.map((link) => {
      const label = text.slice(link.labelStart, link.labelEnd);
      const labelStart = link.labelStart - link.start;
      return {
        start: link.start,
        end: link.end,
        text: label,
        mapInside: (inner) => {
          if (inner <= labelStart) {
            return 0;
          }
          if (inner >= labelStart + label.length) {
            return label.length;
          }
          return inner - labelStart;
        },
      };
    });
    const newText = applyEdits(text, edits);
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, edits);
  }

  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}

/**
 * The Markdown link containing the caret or selection, or null.
 *
 * @returns {{href: string, from: number, to: number}|null}
 */
export function linkAt(blocks, selection) {
  if (!blocks || !blocks.length) {
    return null;
  }
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const position = sel.collapsed ? sel.focus : sel.from;
  const index = clamp(position.block, 0, last);
  const info = infos[index];
  const block = blocks[index];
  if (!block || block.type === "image" || !info) {
    return null;
  }
  const text = lineText(block);
  if (info.kind === "html") {
    const rich = richLineBlock(text);
    if (!rich) {
      return null;
    }
    const length = blockLength(rich);
    let range = null;
    if (sel.collapsed) {
      const visible = clamp(visibleOffsetForInfo(text, position.offset, info), 0, length);
      range = hrefRangeAt(rich, visible);
    } else {
      const from = clamp(sel.from.offset, 0, text.length);
      const to = sel.to.block === index ? clamp(sel.to.offset, 0, text.length) : text.length;
      const visibleStart = clamp(visibleOffsetForInfo(text, from, info), 0, length);
      const visibleEnd = clamp(visibleOffsetForInfo(text, to, info), 0, length);
      if (visibleEnd > visibleStart) {
        range = hrefRangeIn(rich, visibleStart, visibleEnd);
      }
    }
    if (!range) {
      return null;
    }
    return {
      href: range.href,
      from: rawOffsetForInfo(text, range.start, info),
      to: rawOffsetForInfo(text, range.end, info),
    };
  }
  if (!isInlineLine(info)) {
    return null;
  }
  const links = linkTokens(text);
  let link = null;
  if (sel.collapsed) {
    link = links.find((candidate) => position.offset >= candidate.start && position.offset <= candidate.end) || null;
  } else {
    const from = clamp(sel.from.offset, 0, text.length);
    const to = sel.to.block === index ? clamp(sel.to.offset, 0, text.length) : text.length;
    link = links.find((candidate) => candidate.start < to && candidate.end > from) || null;
  }
  return link ? { href: link.href, from: link.start, to: link.end } : null;
}

/* --------------------------------------------------------------------------
   Block formatting
   -------------------------------------------------------------------------- */

function fenceRegions(infos) {
  const regions = [];
  let open = -1;
  for (let index = 0; index < infos.length; index += 1) {
    const kind = infos[index] && infos[index].kind;
    if (kind === "fenceOpen") {
      if (open < 0) {
        open = index;
      }
    } else if (kind === "fenceClose") {
      if (open >= 0) {
        regions.push({ open, close: index });
        open = -1;
      }
    }
  }
  if (open >= 0) {
    regions.push({ open, close: -1 });
  }
  return regions;
}

function removeFences(blocks, sel, regions) {
  const removed = new Set();
  for (const region of regions) {
    removed.add(region.open);
    if (region.close >= 0) {
      removed.add(region.close);
    }
  }
  const keptBefore = new Array(blocks.length + 1);
  const next = [];
  for (let index = 0; index < blocks.length; index += 1) {
    keptBefore[index] = next.length;
    if (!removed.has(index)) {
      next.push(blocks[index]);
    }
  }
  keptBefore[blocks.length] = next.length;

  const mapPosition = (position) => {
    const index = position.block;
    if (!removed.has(index)) {
      return { block: clamp(keptBefore[index], 0, Math.max(0, next.length - 1)), offset: position.offset };
    }
    const region = regions.find((candidate) => candidate.open === index || candidate.close === index);
    if (!region) {
      return { block: clamp(keptBefore[index], 0, Math.max(0, next.length - 1)), offset: 0 };
    }
    if (index === region.open) {
      if (!removed.has(region.open + 1) && region.open + 1 < blocks.length) {
        return { block: keptBefore[region.open + 1], offset: 0 };
      }
      return { block: clamp(keptBefore[region.open], 0, Math.max(0, next.length - 1)), offset: 0 };
    }
    const lastContent = region.close - 1;
    if (lastContent > region.open) {
      const offset = lineText(blocks[lastContent]).length;
      return { block: keptBefore[lastContent], offset };
    }
    return { block: clamp(keptBefore[region.close], 0, Math.max(0, next.length - 1)), offset: 0 };
  };

  if (!next.length) {
    next.push(sourceLine(""));
    return { blocks: next, anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 0 } };
  }
  return { blocks: next, anchor: mapPosition(sel.anchor), focus: mapPosition(sel.focus) };
}

function visibleTextOfLine(blocks, index, info) {
  const text = lineText(blocks[index]);
  if (info && info.kind === "html") {
    const parsed = lineToBlocks(text);
    if (!parsed.length) {
      return "";
    }
    return parsed.map((block) => blockText(block)).join("\n");
  }
  const body = info && info.body !== undefined ? info.body : text;
  return stripInline(body);
}

function visibleOffsetInLine(blocks, index, info, offset) {
  const text = lineText(blocks[index]);
  if (info && info.kind === "html") {
    return sumVisible(tokenizeHtml(text).tokens, clamp(offset, 0, text.length));
  }
  const body = info && info.body !== undefined ? info.body : text;
  const prefix = Math.max(0, text.length - body.length);
  const bodyOffset = clamp(offset - prefix, 0, body.length);
  return sumVisible(tokenizeMarkdown(body).tokens, bodyOffset);
}

// Map a visible position (inside the stripped text of one source line) to a
// content line and offset in a fenced group.
function contentPosition(segments, visibleOffset) {
  let remaining = Math.max(0, visibleOffset);
  for (let index = 0; index < segments.length; index += 1) {
    const length = segments[index].length;
    if (remaining <= length) {
      return { index, offset: remaining };
    }
    remaining -= length + 1;
  }
  const last = segments.length - 1;
  return { index: Math.max(0, last), offset: segments[Math.max(0, last)].length };
}

function fenceSelection(blocks, sel, infos) {
  const from = clamp(sel.from.block, 0, blocks.length - 1);
  const to = clamp(sel.to.block, 0, blocks.length - 1);
  const out = blocks.slice(0, from);
  const mapped = new Map();
  let index = from;
  let wrapped = false;

  while (index <= to) {
    if (blocks[index].type === "image") {
      mapped.set(index, { block: out.length, offset: 0 });
      out.push(blocks[index]);
      index += 1;
      continue;
    }
    const runStart = index;
    let runEnd = index;
    while (runEnd + 1 <= to && blocks[runEnd + 1].type !== "image") {
      runEnd += 1;
    }

    const pieces = [];
    let longest = 0;
    for (let line = runStart; line <= runEnd; line += 1) {
      const text = visibleTextOfLine(blocks, line, infos[line]);
      for (const match of text.matchAll(/`+/g)) {
        longest = Math.max(longest, match[0].length);
      }
      pieces.push({ line, text, segments: text.split("\n") });
    }
    const fence = "`".repeat(Math.max(3, longest + 1));
    out.push(sourceLine(fence));
    const contentStart = out.length;
    for (const piece of pieces) {
      for (const segment of piece.segments) {
        out.push(sourceLine(segment));
      }
    }
    out.push(sourceLine(fence));
    wrapped = true;

    const mapPositionFor = (position) => {
      const line = position.block;
      const piece = pieces[line - runStart];
      const visible = visibleOffsetInLine(blocks, line, infos[line], position.offset);
      const content = contentPosition(piece.segments, visible);
      const linesBefore = pieces
        .slice(0, line - runStart)
        .reduce((sum, item) => sum + item.segments.length, 0);
      return { block: contentStart + linesBefore + content.index, offset: content.offset };
    };
    for (const position of [sel.anchor, sel.focus]) {
      if (position.block >= runStart && position.block <= runEnd) {
        mapped.set(position.block, mapPositionFor(position));
      }
    }
    index = runEnd + 1;
  }

  out.push(...blocks.slice(to + 1));
  if (!wrapped) {
    return null;
  }
  const mapPosition = (position) => {
    const direct = mapped.get(position.block);
    if (direct) {
      return direct;
    }
    if (position.block < from) {
      return { ...position };
    }
    if (position.block > to) {
      return { block: position.block + (out.length - blocks.length), offset: position.offset };
    }
    return { block: clamp(position.block, 0, out.length - 1), offset: 0 };
  };
  return { blocks: out, anchor: mapPosition(sel.anchor), focus: mapPosition(sel.focus) };
}

/**
 * Set the paragraph style of every line the selection touches. Styles are the
 * menu's values: "p", "h1", "h2", "h3", "quote", "code". Code wraps the
 * selected lines in a fence and toggles an enclosing fence off again.
 *
 * @returns {{blocks: Array, anchor: Object, focus: Object}|null}
 */
export function setBlockStyle(blocks, selection, style) {
  if (!STYLES.has(style) || !blocks || !blocks.length) {
    return null;
  }
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);

  if (style === "code") {
    const regions = fenceRegions(infos).filter((region) => {
      const end = region.close >= 0 ? region.close : last;
      return from <= end && to >= region.open;
    });
    if (regions.length) {
      return removeFences(blocks, sel, regions);
    }
    return fenceSelection(blocks, sel, infos);
  }

  const changed = new Map();
  const editsByBlock = new Map();
  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info) {
      continue;
    }
    if (info.kind === "blank" || isFence(info.kind)) {
      continue;
    }
    const text = lineText(block);
    const parsed = lineToBlocks(text);
    if (parsed.length !== 1) {
      continue;
    }
    const targetType = style === "quote" ? "quote" : style;
    if (
      parsed[0].type === targetType &&
      blockAlignment(parsed[0]) === "left" &&
      !parsed[0].indent
    ) {
      continue;
    }
    const target = { ...parsed[0], id: createBlockId(), type: targetType };
    delete target.ordered;
    delete target.depth;
    const lines = blockToLines(target);
    if (lines.length !== 1) {
      continue;
    }
    const newText = lines[0];
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, [
      {
        start: 0,
        end: text.length,
        text: newText,
        mapInside: (inner) => mapLineOffset(text, newText, inner),
      },
    ]);
  }
  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}

/**
 * Toggle a Markdown list marker on every line the selection touches.
 *
 * @param {boolean} ordered true for "1. ", false for "- "
 * @returns {{blocks: Array, anchor: Object, focus: Object}|null}
 */
export function toggleList(blocks, selection, ordered) {
  if (!blocks || !blocks.length) {
    return null;
  }
  const wantOrdered = Boolean(ordered);
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);
  const entries = [];
  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info) {
      continue;
    }
    if (info.kind === "blank" || isFence(info.kind)) {
      continue;
    }
    const text = lineText(block);
    if (info.kind === "html") {
      // A paragraph carrying rich-only attributes lives as serialized HTML;
      // list toggling goes through the rich block and the emitter instead of
      // editing markers inside the escape line.
      const parsed = lineToBlocks(text);
      if (parsed.length !== 1) {
        continue;
      }
      entries.push({ index, text, info, block: parsed[0], html: true });
    } else {
      entries.push({ index, text, info, html: false });
    }
  }
  if (!entries.length) {
    return null;
  }

  const isList = (entry) => (entry.html ? entry.block.type === "list" : entry.info.kind === "list");
  const isOrdered = (entry) =>
    entry.html ? Boolean(entry.block.ordered) : Boolean(entry.info.ordered);
  const allSame = entries.every((entry) => isList(entry) && isOrdered(entry) === wantOrdered);
  const marker = wantOrdered ? "1. " : "- ";
  const changed = new Map();
  const editsByBlock = new Map();

  for (const entry of entries) {
    const { index, text, info } = entry;
    if (entry.html) {
      let target;
      if (allSame) {
        target = { ...entry.block, type: "p" };
        delete target.ordered;
        delete target.depth;
      } else {
        if (isList(entry) && isOrdered(entry) === wantOrdered) {
          continue;
        }
        target = isList(entry)
          ? { ...entry.block, ordered: wantOrdered }
          : { ...entry.block, type: "list", ordered: wantOrdered, depth: 0 };
      }
      const lines = blockToLines(target);
      if (lines.length !== 1) {
        continue;
      }
      const newText = lines[0];
      if (newText === text) {
        continue;
      }
      changed.set(index, newText);
      editsByBlock.set(index, [
        {
          start: 0,
          end: text.length,
          text: newText,
          mapInside: (inner) => mapLineOffset(text, newText, inner),
        },
      ]);
      continue;
    }

    const body = info.body === undefined ? text : info.body;
    const prefixLength = Math.max(0, text.length - body.length);
    let edit;
    if (allSame) {
      edit = { start: 0, end: prefixLength, text: "" };
    } else if (info.kind === "list") {
      if (Boolean(info.ordered) === wantOrdered) {
        continue;
      }
      const leading = /^[ \t]*/.exec(text.slice(0, prefixLength))[0].length;
      edit = { start: leading, end: prefixLength, text: marker };
    } else {
      edit = { start: 0, end: prefixLength, text: marker };
    }
    const newText = applyEdits(text, [edit]);
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, [edit]);
  }

  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}

/**
 * Set the alignment of every paragraph line the selection touches. Markdown
 * has no alignment, so the line is carried as its serialized HTML (the
 * app's documented escape hatch) when it is not left aligned.
 *
 * @param {"left"|"center"|"right"|"justify"} align
 * @returns {{blocks: Array, anchor: Object, focus: Object}|null}
 */
export function setAlign(blocks, selection, align) {
  if (!ALIGNMENTS.has(align) || !blocks || !blocks.length) {
    return null;
  }
  const sel = normalizeSelection(selection);
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);
  const changed = new Map();
  const editsByBlock = new Map();

  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info) {
      continue;
    }
    if (info.kind === "blank" || isFence(info.kind)) {
      continue;
    }
    const text = lineText(block);
    const parsed = lineToBlocks(text);
    if (parsed.length !== 1 || parsed[0].type === "code") {
      continue;
    }
    if (blockAlignment(parsed[0]) === align) {
      continue;
    }
    const target = { ...parsed[0], id: createBlockId() };
    if (align === "left") {
      delete target.align;
    } else {
      target.align = align;
    }
    const lines = blockToLines(target);
    if (lines.length !== 1) {
      continue;
    }
    const newText = lines[0];
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, [
      {
        start: 0,
        end: text.length,
        text: newText,
        mapInside: (inner) => mapLineOffset(text, newText, inner),
      },
    ]);
  }

  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}

/**
 * Clear inline formatting on the selected text, keeping the text itself and
 * the line's block style. Mirrors the rich editor's Clear formatting.
 *
 * @returns {{blocks: Array, anchor: Object, focus: Object}|null}
 */
export function clearFormatting(blocks, selection) {
  if (!blocks || !blocks.length) {
    return null;
  }
  const sel = normalizeSelection(selection);
  if (sel.collapsed) {
    return null;
  }
  const infos = sourceLineInfo(blocks);
  const last = blocks.length - 1;
  const from = clamp(sel.from.block, 0, last);
  const to = clamp(sel.to.block, 0, last);
  const changed = new Map();
  const editsByBlock = new Map();

  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!block || block.type === "image" || !info) {
      continue;
    }
    if (info.kind === "blank" || isFence(info.kind)) {
      continue;
    }
    const text = lineText(block);
    const start = Math.max(clamp(lineStart(sel, index), 0, text.length), lineBodyStart(info, text));
    const end = clamp(lineEnd(sel, index, text.length), 0, text.length);
    if (end <= start) {
      continue;
    }
    if (info.kind === "html") {
      const rich = richLineBlock(text);
      if (!rich) {
        continue;
      }
      const length = blockLength(rich);
      const visibleStart = clamp(visibleOffsetForInfo(text, start, info), 0, length);
      const visibleEnd = clamp(visibleOffsetForInfo(text, end, info), 0, length);
      if (visibleEnd <= visibleStart) {
        continue;
      }
      let runs = rich.runs;
      for (const markKey of MARK_KEYS) {
        runs = setMarkOnRuns(runs, visibleStart, visibleEnd, markKey, false);
      }
      runs = setHrefOnRuns(runs, visibleStart, visibleEnd, "");
      const rewrite = rewriteEscapeLine(text, { ...rich, id: createBlockId(), runs });
      if (!rewrite) {
        continue;
      }
      changed.set(index, rewrite.newText);
      editsByBlock.set(index, [rewrite.edit]);
      continue;
    }
    const selected = text.slice(start, end);
    const stripped = stripInline(selected);
    if (stripped === selected) {
      continue;
    }
    const edit = {
      start,
      end,
      text: stripped,
      mapInside: (inner) => {
        const visible = sumVisible(tokenizeMarkdown(selected).tokens, clamp(inner, 0, selected.length));
        return rawIndexForVisible(stripped, tokenizeMarkdown(stripped).tokens, visible);
      },
    };
    const newText = applyEdits(text, [edit]);
    if (newText === text) {
      continue;
    }
    changed.set(index, newText);
    editsByBlock.set(index, [edit]);
  }

  if (!changed.size) {
    return null;
  }
  return mapLineChanges(blocks, sel, changed, editsByBlock);
}
