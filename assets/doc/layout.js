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
import { blockText } from "./model.js";

const READER = "Literata";
const MONO = '"Cascadia Code", Consolas, "Liberation Mono", monospace';
const IMAGE_GAP = 24;
const DOC_TOP = 29;

export function contentTop() {
  return DOC_TOP;
}

const STYLES = {
  p: { size: 17.5, weight: 400, italic: false, lineHeight: 1.82, before: 0, after: 18.4 },
  h1: { size: 33.25, weight: 500, italic: false, lineHeight: 1.23, before: 51.5, after: 18.3 },
  h2: { size: 26.25, weight: 500, italic: false, lineHeight: 1.23, before: 40.7, after: 14.4 },
  h3: { size: 21.7, weight: 500, italic: false, lineHeight: 1.23, before: 33.6, after: 11.9 },
  h4: { size: 18.9, weight: 500, italic: false, lineHeight: 1.23, before: 29.3, after: 10.4 },
  quote: { size: 19.25, weight: 400, italic: true, lineHeight: 1.72, before: 28.9, after: 28.9, indent: 26 },
  list: { size: 17.5, weight: 400, italic: false, lineHeight: 1.82, before: 4.4, after: 4.4 },
  code: {
    size: 13.5,
    weight: 400,
    italic: false,
    lineHeight: 1.65,
    before: 24.5,
    after: 24.5,
    padding: 17,
    paddingX: 19,
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
  return STYLES[block.type] || STYLES.p;
}

export function fontFor(block, marks) {
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
  let current = { items: [] };
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
          marks: run,
          start: offset,
          runIndex,
        });
        offset += index - start;
      }
      segments.push(current);
      current = { items: [] };
      offset += 1;
      start = index + 1;
    }
    if (start < run.text.length) {
      const text = run.text.slice(start);
      current.items.push({
        text,
        font: fontFor(block, run),
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
    segment.items.length ? prepareRichInline(segment.items) : null,
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
  if (block.type === "quote") {
    return STYLES.quote.indent;
  }
  if (block.type === "list") {
    return 28 + Math.min(block.depth, 4) * 21;
  }
  return 0;
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
    gap: fragment.gapBefore,
    gapRunIndex: fragment.gapItemIndex >= 0 ? items[fragment.gapItemIndex].runIndex : -1,
  };
  line.fragments.push(entry);
  return x + fragment.gapBefore + fragment.occupiedWidth;
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
    const items = rawSegments[index].items;
    const isLast = index === preparedAll.length - 1;

    // A hard break at the very end of a block opens a new segment that holds
    // nothing; HTML draws one line for it, not two.
    if (!prepared && isLast && index > 0) {
      break;
    }

    if (!prepared) {
      lines.push({ y, x: indent, width: 0, height: lineHeight, fragments: [] });
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
      const line = { y, x, width: available, height: lineHeight, fragments: [] };
      let cursorX = x;
      for (const fragment of materialized.fragments) {
        cursorX = pushFragment(line, fragment, items, cursorX);
      }
      lines.push(line);
      y += lineHeight;
      cursor = range.end;
    }
  }

  return lines;
}

function layoutCodeBlock(block, columnWidth, top, style, obstacles) {
  const prepared = preparedCode(block);
  const lineHeight = style.size * style.lineHeight;
  const innerWidth = Math.max(40, columnWidth - style.paddingX * 2);
  const lines = [];
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  let y = top + style.padding;
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
    lines.push({
      y,
      x: band.x,
      width: available,
      height: lineHeight,
      text: line.text,
      fragments: [],
      code: true,
    });
    y += lineHeight;
    cursor = range.end;
  }

  if (!lines.length) {
    lines.push({
      y: top + style.padding,
      x: style.paddingX,
      width: innerWidth,
      height: lineHeight,
      text: "",
      fragments: [],
      code: true,
    });
    y += lineHeight;
  }

  return { lines, height: y - top + style.padding };
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
      marker: block.type === "list" ? { x: indentFor(block) - 14, y: lines.length ? lines[0].y : y } : null,
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
  if (!line || !line.fragments.length) {
    return 0;
  }

  let best = { offset: line.fragments[0].start, distance: Infinity };
  for (const fragment of line.fragments) {
    const offset = offsetAtX(fragment, x);
    const caretX = xForOffset(fragment, offset);
    const distance = Math.abs(caretX - x);
    if (distance < best.distance) {
      best = { offset, distance };
    }
  }
  return best.offset;
}

function offsetAtX(fragment, x) {
  if (x <= fragment.x) {
    return fragment.start;
  }
  if (x >= fragment.x + fragment.width) {
    return fragment.end;
  }
  const boundaries = graphemeBoundaries(fragment.text);
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const width = textWidth(fragment.text.slice(0, boundaries[middle]), fragment.font);
    if (fragment.x + width <= x) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return fragment.start + boundaries[low];
}

function xForOffset(fragment, offset) {
  const cut = Math.max(0, Math.min(fragment.text.length, offset - fragment.start));
  return fragment.x + textWidth(fragment.text.slice(0, cut), fragment.font);
}

export function caretPoint(entry, offset) {
  if (!entry || entry.block.type === "image" || !entry.lines.length) {
    return null;
  }

  let fallback = null;

  for (const line of entry.lines) {
    if (!line.fragments.length) {
      if (offset === 0 || offset === entryOffsetEnd(entry)) {
        fallback = { x: line.x, y: line.y, height: line.height, line };
      }
      continue;
    }

    const first = line.fragments[0];
    const last = line.fragments[line.fragments.length - 1];
    if (offset < first.start) {
      fallback = fallback || { x: first.x, y: line.y, height: line.height, line };
      continue;
    }
    if (offset > last.end) {
      fallback = { x: last.x + last.width, y: line.y, height: line.height, line };
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
  return last.x + last.width;
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
