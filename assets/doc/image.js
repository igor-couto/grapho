// Bitmap changes for image blocks: rotating and flipping.
//
// The stored HTML holds the only copy of an image, as a base64 data URL, so a
// turn or a flip rewrites those pixels and leaves a new data URL behind. The
// alternative, storing a transform next to the image, would have to be painted
// by the view, measured by the layout, redrawn by the PDF writer, and repeated
// by the HTML export; the stored format stays unchanged this way, and every
// reader of the document sees the picture as it was left.
//
// A 90-degree turn swaps the natural width and height, so the block that owns
// the image has to take the new numbers from here rather than keep its old ones.

const IMAGE_MAX_DATA_URL = 1500000;
const IMAGE_MAX_EDGE = 1600;
const IMAGE_PASSTHROUGH_BYTES = 600 * 1024;
const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif|avif)$/;

const IMAGE_TRANSFORMS = {
  "rotate-90-clockwise": { quarterTurns: 1 },
  "flip-horizontal": { flipX: true },
  "flip-vertical": { flipY: true },
};

export async function transformImage(src, action) {
  const transform = IMAGE_TRANSFORMS[action];
  if (!transform || !src) {
    throw new Error("That image can't be changed.");
  }

  const image = await decode(src);
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (!width || !height) {
    throw new Error("That image couldn't be read.");
  }

  const quarterTurns = transform.quarterTurns || 0;
  const swapped = quarterTurns % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = swapped ? height : width;
  canvas.height = swapped ? width : height;

  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.translate(canvas.width / 2, canvas.height / 2);
  if (quarterTurns) {
    // Positive angles turn clockwise in the canvas's y-down space.
    context.rotate((quarterTurns * Math.PI) / 2);
  } else {
    context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  }
  context.drawImage(image, -width / 2, -height / 2, width, height);

  // A turn swaps the picture's sides; a flip only mirrors its pixels. The block
  // that owns it needs to know which one happened to keep its rendered size.
  return { ...encodeTransformed(canvas, src), turned: swapped };
}

function encodeCanvas(canvas, quality) {
  const src = canvas.toDataURL("image/webp", quality);
  if (src.indexOf("data:image/webp") === 0) {
    return src;
  }
  return canvas.toDataURL("image/jpeg", quality);
}

function encodeTransformed(canvas, source) {
  // A lossless source stays lossless while it fits, so turning a screenshot or
  // a diagram does not make its text soft. An animated GIF keeps only the frame
  // the canvas drew.
  if (/^data:image\/(png|gif);/.test(source)) {
    const png = canvas.toDataURL("image/png");
    if (png.length <= IMAGE_MAX_DATA_URL) {
      return { src: png, width: canvas.width, height: canvas.height };
    }
  }

  let current = canvas;
  let width = canvas.width;
  let height = canvas.height;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const src = encodeCanvas(current, 0.92);
    if (src.length <= IMAGE_MAX_DATA_URL) {
      return { src, width, height };
    }
    // Encoded size follows the pixel count, so one measured step is enough to
    // land just under the limit; the loop covers the remaining overshoot.
    const scale = Math.max(0.3, Math.min(0.9, Math.sqrt(IMAGE_MAX_DATA_URL / src.length) * 0.95));
    const nextWidth = Math.max(1, Math.round(width * scale));
    const nextHeight = Math.max(1, Math.round(height * scale));
    if (nextWidth === width && nextHeight === height) {
      break;
    }
    width = nextWidth;
    height = nextHeight;
    current = scaleCanvas(current, width, height);
  }

  throw new Error("That image is too large to change.");
}

function scaleCanvas(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

function decode(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image couldn't be read."));
    image.src = src;
  });
}

function checkImageType(file) {
  if (!IMAGE_TYPE.test(file.type)) {
    throw new Error("Use a PNG, JPEG, WebP, GIF, or AVIF image.");
  }
}

export async function prepareImage(file) {
  checkImageType(file);
  const alt = imageAltFromName(file.name);
  let image;
  try {
    image = await decodeImage(file);
  } catch (error) {
    throw new Error("That image couldn't be read.");
  }

  // A large file is drawn into a canvas before it is stored, and a closed
  // ImageBitmap cannot be drawn: Chrome throws "The image source is detached".
  // Read the size and finish every draw while the bitmap is still alive.
  const naturalWidth = image.width || image.naturalWidth || 0;
  const naturalHeight = image.height || image.naturalHeight || 0;
  try {
    if (!naturalWidth || !naturalHeight) throw new Error("That image couldn't be read.");
    if (file.size <= IMAGE_PASSTHROUGH_BYTES) {
      return {
        src: await readImageFile(file),
        alt,
        width: naturalWidth,
        height: naturalHeight,
      };
    }

    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
    let width = Math.max(1, Math.round(naturalWidth * scale));
    let height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);

    let src = encodeCanvas(canvas, 0.82);
    if (src.length > IMAGE_MAX_DATA_URL) {
      width = Math.max(1, Math.round(width * 0.72));
      height = Math.max(1, Math.round(height * 0.72));
      const smaller = scaleCanvas(canvas, width, height);
      src = encodeCanvas(smaller, 0.7);
    }
    if (src.length > IMAGE_MAX_DATA_URL) {
      throw new Error("That image is too large to embed, even after shrinking.");
    }

    return { src, alt, width, height };
  } finally {
    if (image.close) {
      image.close();
    }
  }
}

async function originalImage(src, alt) {
  const image = await decode(src);
  return { src, alt, width: image.naturalWidth, height: image.naturalHeight };
}

const DRAWING_SIZE_ERROR = "This image would exceed the drawing's 24 MiB save limit.";

export async function prepareDrawingImage(file, maxDataUrlLength) {
  checkImageType(file);
  const prefixLength = `data:${file.type};base64,`.length;
  if (prefixLength + 4 * Math.ceil(file.size / 3) > maxDataUrlLength) {
    throw new Error(DRAWING_SIZE_ERROR);
  }
  return originalImage(await readImageFile(file), imageAltFromName(file.name));
}

export function prepareClipboardImage(clipboard, maxDataUrlLength) {
  const file = [...clipboard.files].find(item => item.type.startsWith("image/"));
  if (file) return prepareDrawingImage(file, maxDataUrlLength);

  const html = clipboard.getData("text/html");
  if (!html) return null;
  // Clipboard HTML stays inert. Only a bounded, embedded bitmap is decoded.
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src");
    const match = /^data:(image\/[a-z]+);base64,/.exec(src);
    if (!match || !IMAGE_TYPE.test(match[1])) continue;
    if (src.length > maxDataUrlLength) return Promise.reject(new Error(DRAWING_SIZE_ERROR));
    const data = src.slice(match[0].length);
    try {
      if (!data || btoa(atob(data)) !== data) continue;
    } catch {
      continue;
    }
    const alt = Array.from(image.alt.trim()).slice(0, 160).join("") || "Image";
    return originalImage(src, alt);
  }
  return null;
}

function decodeImage(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file).catch(() => decodeImageElement(file));
  }
  return decodeImageElement(file);
}

function decodeImageElement(file) {
  return readImageFile(file).then(decode);
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.indexOf("data:image/") === 0) {
        resolve(reader.result);
      } else {
        reject(new Error("That image couldn't be read."));
      }
    };
    reader.onerror = () => reject(new Error("That image couldn't be read."));
    reader.readAsDataURL(file);
  });
}

function imageAltFromName(name) {
  const base = String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(base).slice(0, 160).join("") || "Image";
}
