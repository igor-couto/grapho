// PDF export: lays the document out for A4 and writes a small, selectable
// PDF with the standard PDF fonts, so it needs no font files or libraries.

import {
  cacheImageSize,
  codeFont,
  fragmentTextWidth,
  layoutDocument,
  styleFor,
  textWidth,
} from "./layout.js";
import { imageRadius } from "./model.js";
import { FONT_WIDTHS } from "./pdf-fonts.js";

const PAGE_WIDTH = 794; // A4 at 96 dpi, in layout pixels.
const PAGE_HEIGHT = 1123;
const MARGIN = 72;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const POINT = 0.75; // Layout pixels (96 dpi) to PDF points (72 dpi).
const BASELINE = 0.375; // Half-leading plus ascent, as a share of the font size.
const OVERFLOW = 48; // A page may run this far into the bottom margin.

const FONTS = [
  ["Times-Roman", "F1"],
  ["Times-Bold", "F2"],
  ["Times-Italic", "F3"],
  ["Times-BoldItalic", "F4"],
  ["Courier", "F5"],
  ["Courier-Bold", "F6"],
];
const FONT_RESOURCE = Object.fromEntries(FONTS);

// The light palette, like the HTML export: a PDF is a printed page even when
// the editor is in dark mode.
const INK = [0.161, 0.173, 0.141]; // #292c24
const INK_SOFT = [0.29, 0.306, 0.263]; // #4a4e43
const ACCENT = [0.098, 0.404, 0.824]; // #1967d2
const PAPER = [1, 0.992, 0.976]; // #fffdf9
const CODE_BG = [0.969, 0.953, 0.918]; // #f7f3ea
const CODE_BORDER = [0.886, 0.863, 0.812]; // #e2dccf

const IGNORED = new Set(["\u200b", "\u200c", "\u200d", "\ufeff"]);

export async function buildPdf(blocks, title) {
  const images = await prepareImages(blocks);
  // The title is not part of the block model; a heading block renders it with
  // the same wrapping and spacing as any other h1.
  const heading = { type: "h1", runs: [{ text: title }] };
  const layout = layoutDocument([heading, ...blocks], CONTENT_WIDTH);
  const pages = paginate(layout);
  keepFreeImagesWithTheirText(layout, pages);
  mergeShortLastPage(layout, pages);

  const freePages = new Map();
  for (const entry of layout.blocks) {
    if (entry.image && entry.block.mode === "free") {
      freePages.set(entry, pageCovering(entry.image, pages));
    }
  }

  const names = new Map();
  for (const src of images.keys()) {
    names.set(src, "Im" + (names.size + 1));
  }

  const contents = pages.map((page, index) => {
    return renderPage(layout, page, index, freePages, images, names);
  });
  return writePdf(contents, images, names, title);
}

/* --------------------------------------------------------------------------
   Pagination
   -------------------------------------------------------------------------- */

function paginate(layout) {
  const starts = [0];
  let start = 0;
  let previous = null;

  const breakAt = (top, keepWithHeading) => {
    let at = top;
    // A heading followed by a block that will not fit should not be left
    // alone at the foot of the page.
    if (keepWithHeading && previous && isHeading(previous.block) && previous.top > start + 0.5) {
      at = previous.top;
    }
    if (at <= start + 0.5) {
      return;
    }
    starts.push(at);
    start = at;
  };

  for (const entry of layout.blocks) {
    if (entry.image) {
      // Free images are positioned independently of the flow; they are drawn
      // on whichever pages they cross rather than moving the page break.
      if (entry.block.mode === "free") {
        continue;
      }
      if (entry.image.y + entry.image.height - start > CONTENT_HEIGHT + 0.5) {
        breakAt(entry.image.y, true);
      }
      previous = entry;
      continue;
    }

    if (entry.box) {
      if (entry.box.height <= CONTENT_HEIGHT + 0.5) {
        if (entry.box.y + entry.box.height - start > CONTENT_HEIGHT + 0.5) {
          breakAt(entry.box.y, true);
        }
      } else {
        // A code block taller than a page has to split at line boundaries.
        for (const line of entry.lines) {
          if (line.y + line.height - start > CONTENT_HEIGHT + 0.5) {
            breakAt(line.y, line === entry.lines[0]);
          }
        }
      }
      previous = entry;
      continue;
    }

    for (const line of entry.lines) {
      if (line.y + line.height - start > CONTENT_HEIGHT + 0.5) {
        breakAt(line.y, line === entry.lines[0]);
      }
    }
    previous = entry;
  }

  // Content after the flow, such as a free image, still needs pages.
  let bottom = layout.height;
  for (const entry of layout.blocks) {
    if (entry.image) {
      bottom = Math.max(bottom, entry.image.y + entry.image.height);
    }
  }
  while (starts[starts.length - 1] + CONTENT_HEIGHT < bottom - 0.5) {
    starts.push(starts[starts.length - 1] + CONTENT_HEIGHT);
  }

  return starts.map((pageStart, index) => ({
    start: pageStart,
    end: index + 1 < starts.length ? starts[index + 1] : pageStart + CONTENT_HEIGHT,
  }));
}

/* --------------------------------------------------------------------------
   Page rendering
   -------------------------------------------------------------------------- */

// A free image is drawn on the page that covers most of it. If the page ends
// just above the image bottom, the lines wrapped beside the image would be
// pushed to the next page and look indented for no reason. Extend that page to
// the next text line, within the bottom margin, so the image and its text stay
// together.
function keepFreeImagesWithTheirText(layout, pages) {
  const tops = safeTops(layout);

  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const entry of layout.blocks) {
      if (!entry.image || entry.block.mode !== "free") {
        continue;
      }
      const bottom = entry.image.y + entry.image.height;
      const index = pageCovering(entry.image, pages);
      const page = pages[index];
      if (bottom <= page.end || index + 1 >= pages.length) {
        continue;
      }

      const candidate = smallestSafeTop(tops, bottom);
      if (
        candidate === null ||
        candidate <= page.end ||
        candidate >= pages[index + 1].end - 0.5 ||
        candidate - page.start > CONTENT_HEIGHT + OVERFLOW
      ) {
        continue;
      }

      page.end = candidate;
      pages[index + 1].start = candidate;
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
}

function safeTops(layout) {
  const tops = [];
  for (const entry of layout.blocks) {
    if (entry.image) {
      tops.push(entry.image.y);
    } else if (entry.box) {
      tops.push(entry.box.y);
    } else {
      for (const line of entry.lines) {
        tops.push(line.y);
      }
    }
  }
  tops.sort((a, b) => a - b);
  return tops;
}

// A single line on a page of its own is a poor ending. If it fits in the
// bottom margin, let the previous page carry it.
function mergeShortLastPage(layout, pages) {
  if (pages.length < 2) {
    return;
  }
  const last = pages[pages.length - 1];
  const previous = pages[pages.length - 2];
  const spill = layout.height - last.start;
    if (
      spill <= 0 ||
      spill > OVERFLOW ||
      layout.height - previous.start > CONTENT_HEIGHT + OVERFLOW
    ) {
      return;
    }
  previous.end = layout.height;
  pages.pop();
}

function smallestSafeTop(tops, value) {
  for (const top of tops) {
    if (top >= value - 0.5) {
      return top;
    }
  }
  return null;
}

function pageCovering(image, pages) {
  const top = image.y;
  const bottom = top + image.height;
  let best = 0;
  let overlap = -Infinity;
  for (let index = 0; index < pages.length; index += 1) {
    const covered = Math.min(bottom, pages[index].end) - Math.max(top, pages[index].start);
    if (covered > overlap) {
      overlap = covered;
      best = index;
    }
  }
  return best;
}

function renderPage(layout, page, pageIndex, freePages, images, names) {
  const { start, end } = page;
  const over = Math.max(end - start - CONTENT_HEIGHT, 0);
  const extension = over > 0 ? Math.min(over + 2, OVERFLOW) : 0;
  const clipHeight = CONTENT_HEIGHT + extension;
  const ops = [
    fillColor(PAPER),
    `0 0 ${number(PAGE_WIDTH * POINT)} ${number(PAGE_HEIGHT * POINT)} re f`,
    "q",
    `${number(MARGIN * POINT)} ${number((MARGIN - extension) * POINT)} ` +
      `${number(CONTENT_WIDTH * POINT)} ${number(clipHeight * POINT)} re W n`,
  ];

  for (const entry of layout.blocks) {
    const block = entry.block;
    const free = Boolean(entry.image) && block.mode === "free";

    if (entry.quote) {
      const top = entry.top;
      const height = Math.max(entry.height, 20);
      if (top + height > start && top < end) {
        ops.push(fillColor(ACCENT), `${rectAt(0, top, 2, height, start)} f`);
      }
    }

    if (entry.box) {
      const box = entry.box;
      if (box.y + box.height > start && box.y < end) {
        ops.push(fillColor(CODE_BG), `${rectAt(box.x, box.y, box.width, box.height, start)} f`);
        ops.push(strokeColor(CODE_BORDER), "0.75 w");
        ops.push(`${rectAt(box.x, box.y, box.width, box.height, start)} S`);
      }
    }

    if (entry.image && !free) {
      const image = images.get(block.src);
      if (!image) {
        continue;
      }
      const top = entry.image.y;
      const bottom = top + entry.image.height;
      if (bottom <= start || top >= end) {
        continue;
      }
      drawImage(ops, entry.image, names.get(block.src), start, imageRadius(block));
      continue;
    }

    for (const line of entry.lines) {
      if (line.y < start || line.y >= end) {
        continue;
      }
      if (line.code) {
        drawCodeLine(ops, line, start);
      } else {
        drawTextLine(ops, block, line, start);
      }
    }

    if (entry.marker && entry.marker.y >= start && entry.marker.y < end) {
      drawMarker(ops, layout, entry, start);
    }
  }

  ops.push("Q");

  // Free images are positioned independently of the text, so a page break can
  // cross one. Draw each whole on the page that covers most of it, even if it
  // reaches a little into the margin, rather than cutting it in two.
  ops.push("q", `0 0 ${number(PAGE_WIDTH * POINT)} ${number(PAGE_HEIGHT * POINT)} re W n`);
  for (const entry of layout.blocks) {
    if (!entry.image || entry.block.mode !== "free" || freePages.get(entry) !== pageIndex) {
      continue;
    }
    const image = images.get(entry.block.src);
    if (image) {
      drawImage(ops, entry.image, names.get(entry.block.src), start, imageRadius(entry.block));
    }
  }
  ops.push("Q");
  return ops.join("\n");
}

function drawImage(ops, image, name, start, radius) {
  const x = (MARGIN + image.x) * POINT;
  const y = pageY(image.y + image.height, start);
  const width = image.width * POINT;
  const height = image.height * POINT;
  const round = radius > 0;

  if (round) {
    // The image is drawn in a rotated space, so the clip is laid down first, in
    // page points, and stays in force until the matching Q.
    ops.push("q", roundedRectPath(x, y, width, height, radius * POINT), "W n");
  }

  ops.push(
    "q",
    `${number(width)} 0 0 ${number(height)} ${number(x)} ${number(y)} cm`,
    `/${name} Do`,
    "Q",
  );

  if (round) {
    ops.push("Q");
  }
}

function drawTextLine(ops, block, line, start) {
  for (const fragment of line.fragments) {
    const marks = fragment.marks || {};
    const font = fontFor(block, marks);
    const size = marks.code ? 14.35 : styleFor(block).size;
    const color = marks.href ? ACCENT : block.type === "quote" ? INK_SOFT : INK;
    const baseline = line.y + line.height / 2 + size * BASELINE;

    appendText(ops, {
      text: fragment.text,
      font,
      size,
      color,
      x: fragment.x,
      baseline,
      targetWidth: fragmentTextWidth(fragment, fragment.text),
      spaceExtra: fragment.spaceExtra || 0,
      underline: Boolean(marks.u || marks.href),
      strike: Boolean(marks.s),
      start,
    });
  }
}

function drawCodeLine(ops, line, start) {
  const size = styleFor({ type: "code" }).size;
  const width = textWidth(line.text, codeFont());

  appendText(ops, {
    text: line.text,
    font: "Courier",
    size,
    color: INK_SOFT,
    x: line.x,
    baseline: line.y + line.height / 2 + size * BASELINE,
    targetWidth: width,
    spaceExtra: 0,
    underline: false,
    strike: false,
    start,
  });
}

function drawMarker(ops, layout, entry, start) {
  const text = markerText(layout, entry.index);
  const size = 17.5;
  const width = measure(encodeText(text), "Times-Roman", size * POINT) / POINT;

  appendText(ops, {
    text,
    font: "Times-Roman",
    size,
    color: ACCENT,
    x: entry.marker.x - width,
    baseline: entry.marker.y + 31.85 / 2 + size * BASELINE,
    targetWidth: width,
    spaceExtra: 0,
    underline: false,
    strike: false,
    start,
  });
}

function markerText(layout, index) {
  const block = layout.blocks[index].block;
  if (!block.ordered) {
    return "\u2022";
  }

  let number = 1;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = layout.blocks[cursor].block;
    if (
      !previous ||
      previous.type !== "list" ||
      previous.depth !== block.depth ||
      !previous.ordered
    ) {
      break;
    }
    number += 1;
  }
  return number + ".";
}

function appendText(ops, run) {
  const bytes = encodeText(run.text);
  if (!bytes.length) {
    return;
  }

  // Literata and the standard PDF Times have different glyph widths. Scale
  // each run to the width the editor measured, so lines keep their breaks,
  // alignment, and justification without embedding a font.
  const size = run.size * POINT;
  const spaces = countSpaces(bytes);
  const natural = measure(bytes, run.font, size) + run.spaceExtra * POINT * spaces;
  const scale = natural > 0.0001 ? (run.targetWidth * POINT * 100) / natural : 100;

  ops.push(
    "BT",
    `/${FONT_RESOURCE[run.font]} ${number(size)} Tf`,
    fillColor(run.color),
    `${number(clamp(scale, 10, 1000))} Tz`,
    `${number(run.spaceExtra * POINT)} Tw`,
    `1 0 0 1 ${number((MARGIN + run.x) * POINT)} ${number(pageY(run.baseline, run.start))} Tm`,
    `${pdfString(bytes)} Tj`,
    "ET",
  );

  if (run.underline || run.strike) {
    ops.push(strokeColor(run.color), "0.75 w");
    const from = number((MARGIN + run.x) * POINT);
    const to = number((MARGIN + run.x + run.targetWidth) * POINT);
    if (run.underline) {
      const y = number(pageY(run.baseline + 3, run.start));
      ops.push(`${from} ${y} m ${to} ${y} l S`);
    }
    if (run.strike) {
      const y = number(pageY(run.baseline - run.size * 0.3, run.start));
      ops.push(`${from} ${y} m ${to} ${y} l S`);
    }
  }
}

function fontFor(block, marks) {
  if (marks.code) {
    return marks.b ? "Courier-Bold" : "Courier";
  }

  const bold = Boolean(marks.b) || isHeading(block);
  const italic = Boolean(marks.i) || block.type === "quote";

  if (bold && italic) {
    return "Times-BoldItalic";
  }
  if (bold) {
    return "Times-Bold";
  }
  if (italic) {
    return "Times-Italic";
  }
  return "Times-Roman";
}

function isHeading(block) {
  return block.type === "h1" || block.type === "h2" || block.type === "h3" || block.type === "h4";
}

/* --------------------------------------------------------------------------
   Images
   -------------------------------------------------------------------------- */

async function prepareImages(blocks) {
  const sources = [];
  const seen = new Set();
  for (const block of blocks) {
    if (block.type !== "image" || !block.src || seen.has(block.src)) {
      continue;
    }
    seen.add(block.src);
    sources.push(block.src);
  }

  const loaded = new Map();
  await Promise.all(
    sources.map(async (src) => {
      try {
        const image = await loadImage(src);
        cacheImageSize(src, { width: image.naturalWidth, height: image.naturalHeight });
        loaded.set(src, await encodeImage(image));
      } catch (error) {
        cacheImageSize(src, { width: 0, height: 0 });
      }
    }),
  );

  // Keep the source order so resource names and file output are stable.
  const images = new Map();
  for (const src of sources) {
    if (loaded.has(src)) {
      images.set(src, loaded.get(src));
    }
  }
  return images;
}

async function encodeImage(image) {
  // PDF only carries JPEG directly. Drawing every image onto a canvas
  // flattens transparency, applies EXIF orientation, and converts CMYK or
  // WebP pixels to the RGB JPEG that PDF expects.
  const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fffdf9";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  return { width, height, bytes: dataUrlBytes(canvas.toDataURL("image/jpeg", 0.9)) };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be decoded"));
    image.src = src;
  });
}

function dataUrlBytes(source) {
  const comma = source.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid image data URL");
  }
  const binary = atob(source.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/* --------------------------------------------------------------------------
   PDF file
   -------------------------------------------------------------------------- */

function writePdf(contents, images, names, title) {
  // Index 0 is unused so an object's id is also its array index; ids 1 and 2
  // are reserved for the catalog and the page tree.
  const objects = [null, null, null];
  const add = (data) => {
    const id = objects.length;
    objects.push(typeof data === "string" ? ascii(data) : data);
    return id;
  };

  const fontIds = new Map();
  for (const [name] of FONTS) {
    fontIds.set(
      name,
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
    );
  }

  const imageIds = new Map();
  for (const [src, image] of images) {
    const header =
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${image.bytes.length} >>\nstream\n`;
    imageIds.set(src, add(concat([ascii(header), image.bytes, ascii("\nendstream")])));
  }

  const fontResources = FONTS.map(([name, resource]) => {
    return `/${resource} ${fontIds.get(name)} 0 R`;
  }).join(" ");
  const xobjectResources = Array.from(images.keys())
    .map((src) => `/${names.get(src)} ${imageIds.get(src)} 0 R`)
    .join(" ");
  const resources =
    `/Font << ${fontResources} >>` +
    (xobjectResources ? ` /XObject << ${xobjectResources} >>` : "");

  const pageIds = [];
  for (const content of contents) {
    const bytes = ascii(content);
    const contentId = add(
      concat([ascii(`<< /Length ${bytes.length} >>\nstream\n`), bytes, ascii("\nendstream")]),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${number(PAGE_WIDTH * POINT)} ${number(PAGE_HEIGHT * POINT)}] ` +
          `/Resources << ${resources} >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[1] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = ascii(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  const infoId = add(`<< /Title ${metadataText(title)} /Producer (Grapho) >>`);

  return serialize(objects, infoId);
}

function serialize(objects, infoId) {
  const chunks = [];
  let offset = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  push(ascii("%PDF-1.4\n"));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = offset;
    push(ascii(`${id} 0 obj\n`));
    push(objects[id]);
    push(ascii("\nendobj\n"));
  }

  const xref = offset;
  push(ascii(`xref\n0 ${objects.length}\n`));
  push(ascii("0000000000 65535 f \n"));
  for (let id = 1; id < objects.length; id += 1) {
    push(ascii(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`));
  }
  push(
    ascii(
      `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\n` +
        `startxref\n${xref}\n%%EOF\n`,
    ),
  );

  return concat(chunks);
}

/* --------------------------------------------------------------------------
   Text encoding
   -------------------------------------------------------------------------- */

const WIN_ANSI = (() => {
  const cp1252 = {
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x0192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x02c6,
    0x89: 0x2030,
    0x8a: 0x0160,
    0x8b: 0x2039,
    0x8c: 0x0152,
    0x8e: 0x017d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x02dc,
    0x99: 0x2122,
    0x9a: 0x0161,
    0x9b: 0x203a,
    0x9c: 0x0153,
    0x9e: 0x017e,
    0x9f: 0x0178,
  };
  const map = new Map();
  for (let code = 0x20; code <= 0xff; code += 1) {
    if (code === 0x7f) {
      continue;
    }
    const unicode = code >= 0x80 && code <= 0x9f ? cp1252[code] : code;
    if (unicode && !map.has(String.fromCharCode(unicode))) {
      map.set(String.fromCharCode(unicode), code);
    }
  }
  // Characters that common documents use but cp1252 has no code for.
  map.set("\u2010", 0x2d);
  map.set("\u2011", 0x2d);
  map.set("\u2212", 0x2d);
  map.set("\u2009", 0x20);
  map.set("\u202f", 0x20);
  return map;
})();

function encodeText(text) {
  const bytes = [];
  for (const character of String(text)) {
    if (character === "\n" || character === "\r" || IGNORED.has(character)) {
      continue;
    }
    if (character === "\t") {
      bytes.push(0x20);
      continue;
    }
    const code = WIN_ANSI.get(character);
    bytes.push(code === undefined ? 0x3f : code);
  }
  return bytes;
}

function countSpaces(bytes) {
  let total = 0;
  for (const byte of bytes) {
    if (byte === 0x20) {
      total += 1;
    }
  }
  return total;
}

function measure(bytes, font, size) {
  if (font === "Courier" || font === "Courier-Bold") {
    return (bytes.length * 600 * size) / 1000;
  }

  const widths = FONT_WIDTHS[font];
  let total = 0;
  for (const byte of bytes) {
    const index = byte - 32;
    total += index >= 0 && index < widths.length ? widths[index] : 500;
  }
  return (total * size) / 1000;
}

function pdfString(bytes) {
  let out = "(";
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      out += "\\" + String.fromCharCode(byte);
    } else if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += "\\" + byte.toString(8).padStart(3, "0");
    }
  }
  return out + ")";
}

function metadataText(text) {
  let out = "FEFF";
  for (let index = 0; index < text.length; index += 1) {
    out += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  }
  return "<" + out + ">";
}

/* --------------------------------------------------------------------------
   Geometry and small helpers
   -------------------------------------------------------------------------- */

function rectAt(x, top, width, height, start) {
  return (
    `${number((MARGIN + x) * POINT)} ` +
    `${number((PAGE_HEIGHT - MARGIN - (top - start) - height) * POINT)} ` +
    `${number(width * POINT)} ${number(height * POINT)} re`
  );
}

function pageY(y, start) {
  return (PAGE_HEIGHT - MARGIN - (y - start)) * POINT;
}

// A rounded rectangle as PDF path operators in page points. Each corner is a
// cubic curve through the circle approximation that PDF and canvas both use;
// the radius never exceeds half of the shorter side.
const KAPPA = 0.5522847498;

export function roundedRectPath(x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r < 0.01) {
    return `${number(x)} ${number(y)} ${number(width)} ${number(height)} re`;
  }

  const right = x + width;
  const top = y + height;
  const k = r * KAPPA;
  const at = (px, py) => `${number(px)} ${number(py)}`;
  const curve = (c1x, c1y, c2x, c2y, px, py) =>
    `${at(c1x, c1y)} ${at(c2x, c2y)} ${at(px, py)} c`;

  return [
    `${at(x + r, y)} m`,
    `${at(right - r, y)} l`,
    curve(right - r + k, y, right, y + r - k, right, y + r),
    `${at(right, top - r)} l`,
    curve(right, top - r + k, right - r + k, top, right - r, top),
    `${at(x + r, top)} l`,
    curve(x + r - k, top, x, top - r + k, x, top - r),
    `${at(x, y + r)} l`,
    curve(x, y + r - k, x + r - k, y, x + r, y),
    "h",
  ].join("\n");
}

function fillColor([red, green, blue]) {
  return `${number(red)} ${number(green)} ${number(blue)} rg`;
}

function strokeColor([red, green, blue]) {
  return `${number(red)} ${number(green)} ${number(blue)} RG`;
}

function number(value) {
  return String(Math.round(value * 1000) / 1000);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function ascii(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) {
      throw new Error("PDF text must be ASCII");
    }
    bytes[index] = code;
  }
  return bytes;
}

function concat(parts) {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
