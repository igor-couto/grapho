// Layout: turns blocks into positioned lines with pretext, and answers
// geometry questions about carets, selections, and images.

import {
  prepareRichInline,
  layoutNextRichInlineLineRange,
  materializeRichInlineLineRange,
} from "../pretext/rich-inline.js";
import {
  prepareWithSegments,
  layoutNextLineRange,
  materializeLineRange,
} from "../pretext/layout.js";
import { getGraphemeEnds } from "../pretext/line-text.js";
import { blockAlignment, blockIndent, blockText } from "./model.js";

// These stacks must match --font-reading and --font-mono in app.css: Canvas
// and the DOM have to resolve to the same font when a bundled face is missing.
const READER = '"Literata", "Iowan Old Style", "Palatino Linotype", Georgia, serif';
const MONO = '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace';
const IMAGE_GAP = 24;
const DOC_TOP = 29;
const INDENT_STEP = 24;

export function contentTop() {
  return DOC_TOP;
}

const STYLES = {
  p: { size: 17.5, weight: 400, italic: false, lineHeight: 1.82, before: 0, after: 18.4, tracking: 0 },
  // One Markdown source line per block in Markdown mode. Zero spacing lets
  // consecutive lines read as one continuous block of text.
  source: { size: 15, weight: 400, italic: false, lineHeight: 1.7, before: 0, after: 0, tracking: 0 },
  h1: { size: 33.25, weight: 500, italic: false, lineHeight: 1.23, before: 51.5, after: 18.3, tracking: -0.03 },
  h2: { size: 26.25, weight: 500, italic: false, lineHeight: 1.23, before: 40.7, after: 14.4, tracking: -0.03 },
  h3: { size: 21.7, weight: 500, italic: false, lineHeight: 1.23, before: 33.6, after: 11.9, tracking: -0.025 },
  quote: { size: 19.25, weight: 400, italic: true, lineHeight: 1.72, before: 28.9, after: 28.9, indent: 26, tracking: 0 },
  list: { size: 17.5, weight: 400, italic: false, lineHeight: 1.82, before: 4.4, after: 4.4, tracking: 0 },
  code: {
    size: 13.5,
    weight: 400,
    italic: false,
    lineHeight: 1.65,
    before: 24.5,
    after: 24.5,
    padding: 17,
    paddingX: 19,
    tracking: 0,
  },
};

let preparedByBlock = new WeakMap();
let segmentsByBlock = new WeakMap();
let measureContext = null;
let measureCache = new Map();
const imageSizes = new Map();

export function resetCaches() {
  preparedByBlock = new WeakMap();
  segmentsByBlock = new WeakMap();
  measureCache = new Map();
}

export function notifyFontsReady() {
  resetCaches();
}

export function styleFor(block) {
  if (block.source === true) {
    return STYLES.source;
  }
  return STYLES[block.type] || STYLES.p;
}

export function trackingFor(block) {
  const style = styleFor(block);
  return style.tracking ? style.tracking * style.size : 0;
}

export function fontFor(block, marks) {
  if (block.source === true) {
    // Markdown source is painted in the mono face at the source size, with no
    // bold or italic: one raw line, exactly what the DOM paints.
    return `400 ${STYLES.source.size}px ${MONO}`;
  }
  const style = styleFor(block);
  const bold = Boolean(marks && marks.b);
  const italic = Boolean(marks && marks.i) || style.italic;
  const prefix = (italic ? "italic " : "") + (bold ? "700" : String(style.weight));
  if (marks && marks.code) {
    return `${prefix} 14.35px ${MONO}`;
  }
  return `${prefix} ${style.size}px ${READER}`;
}

export function codeFont() {
  return `400 13.5px ${MONO}`;
}

function context() {
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  return measureContext;
}

export function textWidth(text, font) {
  const key = font + "\u0000" + text;
  const cached = measureCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const ctx = context();
  ctx.font = font;
  const width = ctx.measureText(text).width;
  if (measureCache.size > 6000) {
    measureCache.clear();
  }
  measureCache.set(key, width);
  return width;
}

export async function ensureFonts(sample) {
  const text = sample || "Harbour morning light 0123";
  const faces = [];
  for (const style of Object.values(STYLES)) {
    for (const italic of [false, true]) {
      for (const weight of [style.weight, 700]) {
        faces.push(`${italic ? "italic " : ""}${weight} ${style.size}px ${READER}`);
      }
    }
  }
  faces.push(`400 13.5px ${MONO}`);
  faces.push(`700 13.5px ${MONO}`);
  // Source lines carry their own mono size; load it so the first paint measures
  // with the same face the DOM uses.
  faces.push(`400 ${STYLES.source.size}px ${MONO}`);
  await Promise.all(
    Array.from(new Set(faces)).map((font) => document.fonts.load(font, text).catch(() => null)),
  );
  await document.fonts.ready;
  resetCaches();
}

export function cacheImageSize(src, size) {
  imageSizes.set(src, size);
}

export function imageSize(src) {
  return imageSizes.get(src) || null;
}

export function loadMissingImages(blocks, onReady) {
  let requested = false;
  for (const block of blocks) {
    if (block.type !== "image" || !block.src || imageSizes.has(block.src)) {
      continue;
    }
    if (block.width > 0 && block.height > 0) {
      imageSizes.set(block.src, { width: block.width, height: block.height });
      continue;
    }
    imageSizes.set(block.src, null);
    requested = true;
    const image = new Image();
    image.onload = () => {
      imageSizes.set(block.src, { width: image.naturalWidth, height: image.naturalHeight });
      onReady();
    };
    image.onerror = () => {
      imageSizes.set(block.src, { width: 0, height: 0 });
      onReady();
    };
    image.src = block.src;
  }
  return requested;
}

/* --------------------------------------------------------------------------
   Inline segmentation
   -------------------------------------------------------------------------- */

function segmentsFor(block) {
  const cached = segmentsByBlock.get(block);
  if (cached) {
    return cached;
  }

  const segments = [];
  const tracking = trackingFor(block);
  let current = { items: [], start: 0 };
  let offset = 0;
  let runIndex = 0;

  for (const run of block.runs) {
    let start = 0;
    for (let index = 0; index < run.text.length; index += 1) {
      if (run.text[index] !== "\n") {
        continue;
      }
      if (index > start) {
        current.items.push({
          text: run.text.slice(start, index),
          font: fontFor(block, run),
          letterSpacing: tracking,
          marks: run,
          start: offset,
          runIndex,
        });
        offset += index - start;
      }
      segments.push(current);
      offset += 1;
      current = { items: [], start: offset };
      start = index + 1;
    }
    if (start < run.text.length) {
      const text = run.text.slice(start);
      current.items.push({
        text,
        font: fontFor(block, run),
        letterSpacing: tracking,
        marks: run,
        start: offset,
        runIndex,
      });
      offset += text.length;
    }
    runIndex += 1;
  }

  segments.push(current);
  segmentsByBlock.set(block, segments);
  return segments;
}

function preparedSegments(block) {
  let prepared = preparedByBlock.get(block);
  if (prepared) {
    return prepared;
  }
  prepared = segmentsFor(block).map((segment) =>
    segment.items.length
      ? prepareRichInline(segment.items, { whiteSpace: "pre-wrap" })
      : null,
  );
  preparedByBlock.set(block, prepared);
  return prepared;
}

function preparedCode(block) {
  let prepared = preparedByBlock.get(block);
  if (prepared) {
    return prepared;
  }
  prepared = prepareWithSegments(blockText(block), codeFont(), { whiteSpace: "pre-wrap" });
  preparedByBlock.set(block, prepared);
  return prepared;
}

/* --------------------------------------------------------------------------
   Geometry
   -------------------------------------------------------------------------- */

function indentFor(block) {
  let indent = blockIndent(block) * INDENT_STEP;
  if (block.type === "quote") {
    indent += STYLES.quote.indent;
  } else if (block.type === "list") {
    indent += 28 + Math.min(block.depth, 4) * 21;
  }
  return indent;
}

export function imageWidthFor(block, columnWidth) {
  if (Number.isFinite(block.displayWidth) && block.displayWidth > 0) {
    return Math.max(48, Math.min(block.displayWidth, columnWidth));
  }

  const size = imageSize(block.src);
  const natural = size && size.width ? size.width : 0;

  if (block.mode !== "block") {
    const share = columnWidth * 0.42;
    const width = natural ? Math.min(natural, share) : share;
    return Math.max(96, Math.min(width, columnWidth - 120));
  }

  if (natural) {
    return Math.min(natural, columnWidth);
  }
  return Math.min(columnWidth, 560);
}

function imageHeightFor(block, width) {
  const size = imageSize(block.src);
  if (size && size.width && size.height) {
    return Math.round((width * size.height) / size.width);
  }
  return Math.round(width * 0.66);
}

const MIN_TEXT_WIDTH = 110;

function bandFor(obstacles, y, height, indent, columnWidth) {
  const hits = [];
  for (const obstacle of obstacles) {
    if (y + height <= obstacle.y || y >= obstacle.y + obstacle.height) {
      continue;
    }
    hits.push(obstacle);
  }

  if (hits.length === 0) {
    return { x: indent, width: Math.max(48, columnWidth - indent) };
  }

  // Two images meeting a line at once: move the line below both of them.
  if (hits.length > 1) {
    let bottom = 0;
    for (const obstacle of hits) {
      bottom = Math.max(bottom, obstacle.y + obstacle.height);
    }
    return { clearTo: bottom + IMAGE_GAP };
  }

  const obstacle = hits[0];
  const leftWidth = obstacle.x - IMAGE_GAP - indent;
  const rightStart = obstacle.x + obstacle.width + IMAGE_GAP;
  const rightWidth = columnWidth - rightStart;
  const preferRight = rightWidth >= leftWidth;

  if (preferRight) {
    if (rightWidth >= MIN_TEXT_WIDTH) {
      return { x: rightStart, width: rightWidth };
    }
    if (leftWidth >= MIN_TEXT_WIDTH) {
      return { x: indent, width: leftWidth };
    }
  } else {
    if (leftWidth >= MIN_TEXT_WIDTH) {
      return { x: indent, width: leftWidth };
    }
    if (rightWidth >= MIN_TEXT_WIDTH) {
      return { x: rightStart, width: rightWidth };
    }
  }

  // No room beside the image: the line clears it and continues below.
  return { clearTo: obstacle.y + obstacle.height + IMAGE_GAP };
}

function pushFragment(line, fragment, items, x) {
  const item = items[fragment.itemIndex];
  const entry = {
    text: fragment.text,
    x: x + fragment.gapBefore,
    width: fragment.occupiedWidth,
    start: item.start + fragment.sourceStart,
    end: item.start + fragment.sourceEnd,
    runIndex: item.runIndex,
    marks: item.marks,
    font: item.font,
    letterSpacing: item.letterSpacing || 0,
    tabStopAdvance: 0,
    gap: fragment.gapBefore,
    gapRunIndex: fragment.gapItemIndex >= 0 ? items[fragment.gapItemIndex].runIndex : -1,
    lineStartX: line.x,
    spaceExtra: 0,
  };
  line.fragments.push(entry);
  return x + fragment.gapBefore + fragment.occupiedWidth;
}

// A tab advances to the next tab stop, counted from the line's start, exactly
// as the browser paints it. Canvas measures "\t" as nothing, so a caret
// measured with plain text width would sit on the wrong side of every tab.
function textAdvance(fragment, text) {
  const tracking = fragment.letterSpacing || 0;
  const hasTab = text.indexOf("\t") !== -1;
  if (!hasTab) {
    // The common case: one Canvas measurement, and no grapheme walk on every
    // pointer move through a long paragraph.
    return tracking === 0
      ? textWidth(text, fragment.font)
      : textWidth(text, fragment.font) + tracking * graphemeCount(text);
  }

  let position = fragment.x - (fragment.lineStartX || 0);
  const start = position;
  let index = 0;

  while (index < text.length) {
    const tab = text.indexOf("\t", index);
    const end = tab === -1 ? text.length : tab;
    if (end > index) {
      const run = text.slice(index, end);
      const advance = textWidth(run, fragment.font) + tracking * graphemeCount(run);
      position += advance;
    }
    if (tab === -1) {
      break;
    }
    const stop = tabStopAdvance(fragment);
    if (stop > 0) {
      position += stop - (position - Math.floor(position / stop) * stop);
    }
    index = tab + 1;
  }

  return position - start;
}

function tabStopAdvance(fragment) {
  if (fragment.tabStopAdvance) {
    return fragment.tabStopAdvance;
  }
  return (textWidth(" ", fragment.font) + (fragment.letterSpacing || 0)) * 8;
}

function countSpaces(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === " ") {
      count += 1;
    }
  }
  return count;
}

export function fragmentTextWidth(fragment, text) {
  const extra = (fragment.spaceExtra || 0) * countSpaces(text);
  if (text === fragment.text) {
    return fragment.width + extra;
  }
  // A heading's letter-spacing is painted between its graphemes, so a caret
  // inside a fragment sits one tracking step per grapheme before the width of
  // its text alone would suggest. Tabs need their own tab stops.
  return textAdvance(fragment, text) + extra;
}

function graphemeCount(text) {
  return Math.max(0, graphemeBoundaries(text).length - 1);
}

function paintedFragmentWidth(fragment) {
  return (
    textWidth(fragment.text, fragment.font) +
    (fragment.letterSpacing || 0) * graphemeCount(fragment.text) +
    (fragment.spaceExtra || 0) * countSpaces(fragment.text)
  );
}

function trailingSpaces(text) {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === " ") {
    count += 1;
  }
  return count;
}

function justifyLine(line) {
  const extra = line.width - line.contentWidth;
  if (extra <= 0.01) {
    return;
  }

  let slots = 0;
  for (const fragment of line.fragments) {
    slots += fragment.gap > 0 ? 1 : 0;
    slots += countSpaces(fragment.text);
  }
  // Trailing spaces hang at the line end; they are not expansion opportunities.
  const lastFragment = line.fragments[line.fragments.length - 1];
  if (lastFragment) {
    slots -= trailingSpaces(lastFragment.text);
  }
  if (!slots) {
    return;
  }

  const spaceExtra = extra / slots;
  let shift = 0;
  for (const fragment of line.fragments) {
    if (fragment.gap > 0) {
      fragment.gap += spaceExtra;
      shift += spaceExtra;
    }
    fragment.x += shift;
    fragment.spaceExtra = spaceExtra;
    shift += countSpaces(fragment.text) * spaceExtra;
  }
  line.contentWidth = line.width;
  line.spaceExtra = spaceExtra;
}

function alignLine(line, align) {
  if (!line.fragments.length) {
    if (align === "center") {
      line.x += line.width / 2;
    } else if (align === "right") {
      line.x += line.width;
    }
    return;
  }

  if (align === "center" || align === "right") {
    const shift = Math.max(0, line.width - line.contentWidth) * (align === "center" ? 0.5 : 1);
    if (shift > 0) {
      line.x += shift;
      for (const fragment of line.fragments) {
        fragment.x += shift;
      }
    }
    return;
  }

  if (align === "justify" && !line.lastOfSegment) {
    justifyLine(line);
  }
}

function layoutRichBlock(block, columnWidth, top, obstacles, style) {
  const rawSegments = segmentsFor(block);
  const preparedAll = preparedSegments(block);
  const lineHeight = style.size * style.lineHeight;
  const indent = indentFor(block);
  const lines = [];
  let y = top;

  for (let index = 0; index < preparedAll.length; index += 1) {
    const prepared = preparedAll[index];
    const segment = rawSegments[index];
    const items = segment.items;
    const isLast = index === preparedAll.length - 1;
    const segmentStart = lines.length;

    // A hard break at the very end of a block opens a new segment that holds
    // nothing; HTML draws one line for it, not two.
    if (!prepared && isLast && index > 0) {
      break;
    }

    if (!prepared) {
      lines.push({
        y,
        x: indent,
        boxX: indent,
        boxRight: indent + Math.max(48, columnWidth - indent),
        width: Math.max(48, columnWidth - indent),
        height: lineHeight,
        fragments: [],
        contentWidth: 0,
        offsetStart: segment.start,
        offsetEnd: segment.start,
      });
      lines[lines.length - 1].lastOfSegment = true;
      y += lineHeight;
      continue;
    }

    let cursor = { itemIndex: 0, segmentIndex: 0, graphemeIndex: 0 };
    let guard = 0;

    while (guard < 4000) {
      guard += 1;

      let band = bandFor(obstacles, y, lineHeight, indent, columnWidth);
      let clears = 0;
      while (band.clearTo !== undefined && clears < 6) {
        y = Math.max(y, band.clearTo);
        band = bandFor(obstacles, y, lineHeight, indent, columnWidth);
        clears += 1;
      }
      if (band.clearTo !== undefined) {
        y = Math.max(y, band.clearTo);
        band = { x: indent, width: Math.max(48, columnWidth - indent) };
      }

      const x = band.x;
      const available = Math.max(48, band.width);
      const range = layoutNextRichInlineLineRange(prepared, available, cursor);
      if (!range) {
        break;
      }
      const materialized = materializeRichInlineLineRange(prepared, range);
      const line = {
        y,
        x,
        boxX: x,
        boxRight: x + available,
        width: available,
        height: lineHeight,
        fragments: [],
        contentWidth: 0,
        offsetStart: segment.start,
        offsetEnd: segment.start,
        softWrapped: lines.length > segmentStart,
      };
      let cursorX = x;
      for (const fragment of materialized.fragments) {
        cursorX = pushFragment(line, fragment, items, cursorX);
      }
      line.contentWidth = cursorX - x;
      if (line.fragments.length) {
        line.offsetStart = line.fragments[0].start;
        line.offsetEnd = line.fragments[line.fragments.length - 1].end;
        const last = line.fragments[line.fragments.length - 1];
        // Pretext hangs spaces at a soft wrap and leaves their advance out of
        // the line's width. The view paints each line as its own block, where
        // the browser does charge for that space, so keep the painted width
        // for carets and clicks. Alignment still uses the visible width, so a
        // right-aligned line ends its glyphs at the margin, not one space
        // before it.
        if (last.text.endsWith(" ")) {
          const painted = paintedFragmentWidth(last);
          if (painted > last.width + 0.5) {
            // Pretext already hung this line's trailing space, so the width it
            // reported is the visible one. Keep it for alignment, but paint the
            // full fragment so the caret after the space sits where the browser
            // puts it.
            last.width = painted;
          } else {
            // The final line's trailing space is still in the reported width.
            // Hang it for alignment without losing it from the caret width.
            const trailing = trailingSpaces(last.text);
            line.contentWidth =
              cursorX -
              x -
              (textWidth(" ".repeat(trailing), last.font) + (last.letterSpacing || 0) * trailing);
            last.width = painted;
          }
        }
      }
      lines.push(line);
      y += lineHeight;
      cursor = range.end;
    }

    if (lines.length > segmentStart) {
      lines[lines.length - 1].lastOfSegment = true;
    }
  }

  const align = blockAlignment(block);
  for (const line of lines) {
    alignLine(line, align);
  }
  return lines;
}

function layoutCodeBlock(block, columnWidth, top, style, obstacles) {
  const prepared = preparedCode(block);
  const font = codeFont();
  const lineHeight = style.size * style.lineHeight;
  const innerWidth = Math.max(40, columnWidth - style.paddingX * 2);
  const lines = [];
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  let y = top + style.padding;
  let previousEnd = 0;
  let guard = 0;

  while (guard < 4000) {
    guard += 1;

    let band = bandFor(obstacles, y, lineHeight, style.paddingX, columnWidth);
    let clears = 0;
    while (band.clearTo !== undefined && clears < 6) {
      y = Math.max(y, band.clearTo);
      band = bandFor(obstacles, y, lineHeight, style.paddingX, columnWidth);
      clears += 1;
    }
    if (band.clearTo !== undefined) {
      y = Math.max(y, band.clearTo);
      band = { x: style.paddingX, width: innerWidth };
    }

    const available = Math.max(40, band.width);
    const range = layoutNextLineRange(prepared, available, cursor);
    if (!range) {
      break;
    }
    const line = materializeLineRange(prepared, range);
    const offsetStart = codeOffset(prepared, range.start);
    // A hard break's newline is consumed between two lines, so the line owns
    // only its visible text, not the line feed after it.
    const offsetEnd = offsetStart + line.text.length;
    const width = Math.max(range.width, textWidth(line.text, font));
    lines.push({
      y,
      x: band.x,
      width: available,
      height: lineHeight,
      text: line.text,
      contentWidth: width,
      offsetStart,
      offsetEnd,
      softWrapped: lines.length > 0 && offsetStart === previousEnd,
      code: true,
      fragments: [
        {
          text: line.text,
          x: band.x,
          width,
          start: offsetStart,
          end: offsetEnd,
          font,
          letterSpacing: 0,
          tabStopAdvance: prepared.tabStopAdvance || 0,
          gap: 0,
          spaceExtra: 0,
          marks: {},
          lineStartX: band.x,
        },
      ],
    });
    y += lineHeight;
    cursor = range.end;
    previousEnd = offsetEnd;
  }

  if (!lines.length) {
    lines.push({
      y: top + style.padding,
      x: style.paddingX,
      width: innerWidth,
      height: lineHeight,
      text: "",
      contentWidth: 0,
      offsetStart: 0,
      offsetEnd: 0,
      code: true,
      fragments: [
        {
          text: "",
          x: style.paddingX,
          width: 0,
          start: 0,
          end: 0,
          font,
          letterSpacing: 0,
          tabStopAdvance: prepared.tabStopAdvance || 0,
          gap: 0,
          spaceExtra: 0,
          marks: {},
          lineStartX: style.paddingX,
        },
      ],
    });
    y += lineHeight;
  }

  return { lines, height: y - top + style.padding };
}

function codeOffset(prepared, cursor) {
  const starts = prepared.sourceStarts || (prepared.sourceStarts = segmentStarts(prepared.segments));
  if (cursor.segmentIndex >= starts.length) {
    const last = starts.length ? starts[starts.length - 1] + prepared.segments[prepared.segments.length - 1].length : 0;
    return last;
  }
  let offset = starts[cursor.segmentIndex];
  if (cursor.graphemeIndex > 0) {
    const ends = getGraphemeEnds(prepared, cursor.segmentIndex);
    offset += ends[Math.min(cursor.graphemeIndex, ends.length) - 1] || 0;
  }
  return offset;
}

function segmentStarts(segments) {
  const starts = [];
  let offset = 0;
  for (const segment of segments) {
    starts.push(offset);
    offset += segment.length;
  }
  return starts;
}

/* --------------------------------------------------------------------------
   Document layout
   -------------------------------------------------------------------------- */

export function layoutDocument(blocks, columnWidth) {
  let obstacles = [];
  let layout = null;

  // Text widths depend on where the images are, and an image is anchored to
  // the flow position of its block, which depends on the text. Two or three
  // passes settle it; the last one is the layout we keep.
  for (let pass = 0; pass < 3; pass += 1) {
    layout = layoutPass(blocks, columnWidth, obstacles, false);
    const next = collectObstacles(layout);
    if (sameObstacles(next, obstacles)) {
      layout.obstacles = next;
      return layout;
    }
    obstacles = next;
  }

  // Not settled (usually several wrapped images whose anchors keep moving):
  // lay the text out against the last positions and keep the images there, so
  // no line can end up under an image.
  layout = layoutPass(blocks, columnWidth, obstacles, true);
  layout.obstacles = obstacles;
  return layout;
}

function layoutPass(blocks, columnWidth, obstacles, pinned) {
  const laid = [];
  let y = DOC_TOP;
  let previousAfter = 0;
  let maxImageBottom = 0;
  let obstacleIndex = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const style = styleFor(block);

    if (block.type === "image") {
      const width = imageWidthFor(block, columnWidth);
      const height = imageHeightFor(block, width);

      if (block.mode !== "block") {
        const anchorTop = y;
        const preferredX = Number.isFinite(block.x) ? block.x : (columnWidth - width) / 2;
        const presetX =
          block.mode === "left" ? 0 : block.mode === "right" ? columnWidth - width : clamp(preferredX, 0, Math.max(0, columnWidth - width));
        // A free image keeps the document position it was dropped at, so text
        // around it can be laid out once and cannot chase the image. Presets
        // still sit at the flow position of their block.
        let preferredY =
          block.mode === "free" && Number.isFinite(block.y) ? Math.max(DOC_TOP, block.y) : anchorTop;
        let imageX = presetX;

        const fixed = pinned ? obstacles[obstacleIndex] : null;
        if (fixed) {
          imageX = fixed.x;
          preferredY = fixed.y;
        }
        obstacleIndex += 1;

        maxImageBottom = Math.max(maxImageBottom, preferredY + height);
        laid.push({
          block,
          index,
          top: anchorTop,
          height: 0,
          lines: [],
          image: { x: imageX, y: preferredY, width, height },
        });
        previousAfter = 0;
        continue;
      }

      y += Math.max(previousAfter, 26);
      laid.push({
        block,
        index,
        top: y,
        height,
        lines: [],
        image: { x: (columnWidth - width) / 2, y, width, height },
      });
      y += height;
      previousAfter = 26;
      continue;
    }

    y += Math.max(previousAfter, index === 0 ? 0 : style.before);

    if (block.type === "code") {
      const code = layoutCodeBlock(block, columnWidth, y, style, obstacles);
      laid.push({
        block,
        index,
        top: y,
        height: code.height,
        lines: code.lines,
        box: { x: 0, y, width: columnWidth, height: code.height },
      });
      y += code.height;
      previousAfter = style.after;
      continue;
    }

    const lines = layoutRichBlock(block, columnWidth, y, obstacles, style);
    const height = lines.length ? lines[lines.length - 1].y + lines[lines.length - 1].height - y : 0;
    laid.push({
      block,
      index,
      top: y,
      height,
      lines,
      quote: block.type === "quote",
      list: block.type === "list",
      marker: block.type === "list"
        ? { x: (lines.length ? lines[0].x : indentFor(block)) - 14, y: lines.length ? lines[0].y : y }
        : null,
    });
    y += height;
    previousAfter = style.after;
  }

  return { blocks: laid, height: Math.max(y, maxImageBottom), width: columnWidth };
}

function collectObstacles(layout) {
  const obstacles = [];
  for (const entry of layout.blocks) {
    if (entry.block.type === "image" && entry.block.mode !== "block" && entry.image) {
      obstacles.push({
        x: entry.image.x,
        y: entry.image.y,
        width: entry.image.width,
        height: entry.image.height,
      });
    }
  }
  return obstacles;
}

function sameObstacles(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index].x - b[index].x) > 0.5 || Math.abs(a[index].y - b[index].y) > 0.5) {
      return false;
    }
  }
  return true;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* --------------------------------------------------------------------------
   Queries
   -------------------------------------------------------------------------- */

export function blockEntry(layout, index) {
  return layout.blocks[index] || layout.blocks[layout.blocks.length - 1] || null;
}

export function entryAtY(layout, y) {
  for (const entry of layout.blocks) {
    if (y < entry.top + entry.height) {
      return entry;
    }
  }
  return layout.blocks[layout.blocks.length - 1] || null;
}

export function lineAtY(entry, y) {
  if (!entry || !entry.lines.length) {
    return null;
  }
  for (const line of entry.lines) {
    if (y < line.y + line.height) {
      return line;
    }
  }
  return entry.lines[entry.lines.length - 1];
}

export function pointToOffset(entry, x, y) {
  if (!entry || entry.block.type === "image") {
    return 0;
  }
  const line = lineAtY(entry, y);
  if (!line) {
    return 0;
  }
  if (!line.fragments.length) {
    return line.offsetStart || 0;
  }

  let best = { offset: line.fragments[0].start, distance: Infinity };
  for (const fragment of line.fragments) {
    for (const offset of offsetCandidates(fragment, x)) {
      const distance = Math.abs(xForOffset(fragment, offset) - x);
      if (distance < best.distance || (distance === best.distance && offset < best.offset)) {
        best = { offset, distance };
      }
    }
  }
  return best.offset;
}

// The boundaries on either side of a click inside a fragment, plus the
// fragment's own edges. Choosing between them by distance makes a click on the
// right half of a glyph put the caret after it, as every text editor does.
function offsetCandidates(fragment, x) {
  const boundaries = graphemeBoundaries(fragment.text);
  const offsets = [fragment.start, fragment.end];
  if (x > fragment.x && x < fragment.x + fragmentTextWidth(fragment, fragment.text)) {
    let low = 0;
    let high = boundaries.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const width = fragmentTextWidth(fragment, fragment.text.slice(0, boundaries[middle]));
      if (fragment.x + width <= x) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    offsets.push(fragment.start + boundaries[low]);
    if (low + 1 < boundaries.length) {
      offsets.push(fragment.start + boundaries[low + 1]);
    }
  }
  return offsets;
}

function xForOffset(fragment, offset) {
  const cut = Math.max(0, Math.min(fragment.text.length, offset - fragment.start));
  return fragment.x + fragmentTextWidth(fragment, fragment.text.slice(0, cut));
}

export function caretPoint(entry, offset, hintLine) {
  if (!entry || entry.block.type === "image" || !entry.lines.length) {
    return null;
  }

  let fallback = null;
  const lastLine = entry.lines[entry.lines.length - 1];

  for (let index = 0; index < entry.lines.length; index += 1) {
    const line = entry.lines[index];
    if (!line.fragments.length) {
      // An empty line owns the offset it starts at. The very end of a block
      // that stops on a hard break belongs to its last painted empty line,
      // because the final empty segment opens no further line.
      if (offset === line.offsetStart || (line === lastLine && offset === entryOffsetEnd(entry))) {
        fallback = { x: line.x, y: line.y, height: line.height, line };
      }
      continue;
    }

    const first = line.fragments[0];
    const last = line.fragments[line.fragments.length - 1];

    // A soft wrap shares one offset between the end of a line and the start of
    // the next. The caller's hint decides which side shows the caret: moving
    // down or clicking onto the new line works at its start, while typing a
    // space at the end of a line keeps the caret at that line's end.
    const next = entry.lines[index + 1];
    if (
      hintLine === next &&
      next &&
      next.fragments.length &&
      offset === line.offsetEnd &&
      next.offsetStart === offset
    ) {
      continue;
    }

    if (offset < first.start) {
      fallback = fallback || { x: first.x, y: line.y, height: line.height, line };
      continue;
    }
    if (offset > last.end) {
      fallback = { x: last.x + fragmentTextWidth(last, last.text), y: line.y, height: line.height, line };
      continue;
    }

    for (const fragment of line.fragments) {
      if (offset <= fragment.end) {
        return {
          x: xForOffset(fragment, offset),
          y: line.y,
          height: line.height,
          line,
        };
      }
    }
  }

  return fallback;
}

export function entryOffsetEnd(entry) {
  if (!entry || !entry.block || entry.block.type === "image") {
    return 0;
  }
  return blockText(entry.block).length;
}

export function selectionRects(entry, start, end) {
  const rects = [];
  if (!entry || entry.block.type === "image") {
    return rects;
  }
  for (const line of entry.lines) {
    if (!line.fragments.length) {
      continue;
    }
    const lineStart = line.fragments[0].start;
    const lineEnd = line.fragments[line.fragments.length - 1].end;
    if (end <= lineStart || start >= lineEnd) {
      continue;
    }
    const from = xClamp(line, Math.max(start, lineStart));
    const to = xClamp(line, Math.min(end, lineEnd));
    if (to > from) {
      rects.push({ x: from, y: line.y, width: to - from, height: line.height });
    }
  }
  return rects;
}

function xClamp(line, offset) {
  for (const fragment of line.fragments) {
    if (offset <= fragment.end) {
      return xForOffset(fragment, offset);
    }
  }
  const last = line.fragments[line.fragments.length - 1];
  return last.x + fragmentTextWidth(last, last.text);
}

let segmenter = null;
let segmenterChecked = false;

export function graphemeBoundaries(text) {
  if (!text) {
    return [0];
  }
  if (!segmenterChecked) {
    segmenterChecked = true;
    try {
      segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    } catch (error) {
      segmenter = null;
    }
  }
  if (!segmenter) {
    const points = [];
    for (let index = 0; index <= text.length; index += 1) {
      points.push(index);
    }
    return points;
  }
  const points = [0];
  for (const part of segmenter.segment(text)) {
    points.push(part.index + part.segment.length);
  }
  return points;
}
