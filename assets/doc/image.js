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

export const IMAGE_MAX_DATA_URL = 1500000;

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

  return encodeTransformed(canvas, src);
}

export function encodeCanvas(canvas, quality) {
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
