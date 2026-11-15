// Grapho's editor page: loads a document, owns the pretext-backed editor, and
// handles saving, formatting, links, images, and export.

import { blockText, parseDocument, serializeDocument } from "./doc/model.js";
import { DocEditor } from "./doc/input.js";
import { cacheImageSize, ensureFonts, loadMissingImages } from "./doc/layout.js";

const state = {
  documentId: null,
  loaded: false,
  dirty: false,
  saving: false,
  deleting: false,
  saveTimer: null,
  retryTimer: null,
  savePromise: null,
  saveErrorNotified: false,
  imageEntry: null,
  toastTimer: null,
};

const els = {};
let editor = null;

const IMAGE_MAX_EDGE = 1600;
const IMAGE_MAX_DATA_URL = 1500000;
const IMAGE_PASSTHROUGH_BYTES = 600 * 1024;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  els.saveStatus = document.getElementById("saveStatus");
  els.backToLibrary = document.getElementById("backToLibrary");
  els.documentMenuButton = document.getElementById("documentMenuButton");
  els.documentMenu = document.getElementById("documentMenu");
  els.formatToolbar = document.getElementById("formatToolbar");
  els.blockStyle = document.getElementById("blockStyle");
  els.linkButton = document.getElementById("linkButton");
  els.imageButton = document.getElementById("imageButton");
  els.imageInput = document.getElementById("imageInput");
  els.imageMenu = document.getElementById("imageMenu");
  els.paper = document.getElementById("paper");
  els.documentTitle = document.getElementById("documentTitle");
  els.editor = document.getElementById("editor");
  els.docInput = document.getElementById("docInput");
  els.loadError = document.getElementById("loadError");
  els.toast = document.getElementById("toast");

  els.linkDialog = document.getElementById("linkDialog");
  els.linkForm = document.getElementById("linkForm");
  els.linkTitle = document.getElementById("linkTitle");
  els.linkDescription = document.getElementById("linkDescription");
  els.linkInput = document.getElementById("linkInput");
  els.linkError = document.getElementById("linkError");
  els.linkApply = document.getElementById("linkApply");
  els.linkRemove = document.getElementById("linkRemove");
  els.linkCancel = document.getElementById("linkCancel");

  els.deleteDialog = document.getElementById("deleteDialog");
  els.deleteForm = document.getElementById("deleteForm");
  els.deleteConfirm = document.getElementById("deleteConfirm");
  els.deleteCancel = document.getElementById("deleteCancel");

  editor = new DocEditor({
    root: els.editor,
    textarea: els.docInput,
    onChange: handleEditorChange,
    onSelection: handleSelectionChange,
    onImageSelect: openImageMenu,
    onSave: () => saveNow(),
    onLink: openLinkDialog,
    onPasteImages: (files) => addImages(files),
  });
  editor.bind();

  bindEvents();
  await loadDocument();
}

/* --------------------------------------------------------------------------
   Loading and saving
   -------------------------------------------------------------------------- */

async function loadDocument() {
  state.documentId = documentIdFromPath();
  if (!state.documentId) {
    showLoadFailure({ status: 404 });
    return;
  }

  try {
    const document = await request("/api/documents/" + encodeURIComponent(state.documentId));
    await applyDocument(document);
  } catch (error) {
    console.error(error);
    showLoadFailure(error);
  }
}

async function applyDocument(document) {
  const blocks = parseDocument(document.content || "");
  const sample = blocks.map(blockText).join(" ").slice(0, 200);
  await ensureFonts(sample);

  state.loaded = true;
  state.dirty = false;

  els.documentTitle.value = document.title || "Untitled document";
  els.documentTitle.disabled = false;
  els.paper.setAttribute("aria-busy", "false");

  loadMissingImages(blocks, () => {
    editor.relayout();
    editor.sync();
  });
  editor.setDocument(blocks);

  setToolbarEnabled(true);
  els.documentMenuButton.disabled = false;
  els.saveStatus.disabled = false;

  updatePageTitle();
  updateEditorPlaceholder();
  hideSaveStatus();

  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") {
    window.history.replaceState(null, "", window.location.pathname);
    els.documentTitle.focus();
    els.documentTitle.select();
  }
}

function showLoadFailure(error) {
  const notFound = error && error.status === 404;
  const titleNode = els.loadError.querySelector("h1");
  const textNode = els.loadError.querySelector("p");
  const markNode = els.loadError.querySelector(".load-error-mark");

  els.paper.setAttribute("aria-busy", "false");
  els.paper.querySelector(".paper-head").hidden = true;
  els.editor.hidden = true;
  els.loadError.hidden = false;

  markNode.textContent = notFound ? "404" : "!";
  titleNode.textContent = notFound ? "This page isn't here." : "Couldn't open this document.";
  textNode.textContent = notFound
    ? "It may have been deleted, or the link might be incomplete."
    : "Grapho couldn't reach the document. Check the server, then refresh the page.";

  hideSaveStatus();
  els.saveStatus.disabled = true;
  els.documentTitle.disabled = true;
  els.documentMenuButton.disabled = true;
  setToolbarEnabled(false);
  document.title = notFound ? "Document not found — Grapho" : "Couldn't open document — Grapho";
}

function documentIdFromPath() {
  const match = window.location.pathname.match(/^\/doc\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return null;
  }
}

function setToolbarEnabled(enabled) {
  els.formatToolbar.querySelectorAll("button, select").forEach((control) => {
    control.disabled = !enabled;
  });
  els.imageButton.disabled = !enabled;
}

function handleEditorChange() {
  if (!state.loaded) {
    return;
  }
  updateEditorPlaceholder();
  markDirty();
}

function markDirty() {
  if (!state.loaded) {
    return;
  }
  state.dirty = true;
  scheduleSave();
}

function normalizeTitle(raw) {
  let cleaned = String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(cleaned);
  if (characters.length > 200) {
    cleaned = characters.slice(0, 200).join("");
  }
  return cleaned || "Untitled document";
}

function normalizeTitleField() {
  if (!state.loaded) {
    return;
  }
  const normalized = normalizeTitle(els.documentTitle.value);
  if (els.documentTitle.value !== normalized) {
    els.documentTitle.value = normalized;
    updatePageTitle();
    markDirty();
  }
}

function updatePageTitle() {
  const title = String(els.documentTitle.value || "").trim() || "Untitled document";
  document.title = title + " — Grapho";
}

function updateEditorPlaceholder() {
  const blocks = editor ? editor.getDocument() : [];
  const hasText = blocks.some((block) => {
    if (block.type === "image") {
      return true;
    }
    return blockText(block).trim().length > 0;
  });
  els.editor.dataset.empty = hasText ? "false" : "true";
}

function buildPayload() {
  const blocks = editor ? editor.getDocument() : [];
  const hasContent = blocks.some((block) => block.type === "image" || blockText(block).trim().length > 0);
  return {
    title: normalizeTitle(els.documentTitle.value),
    content: hasContent ? serializeDocument(blocks) : "",
  };
}

function scheduleSave(delay) {
  if (!state.loaded) {
    return;
  }
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(
    () => {
      state.saveTimer = null;
      saveNow();
    },
    typeof delay === "number" ? delay : 900,
  );
}

function saveNow() {
  if (!state.loaded) {
    return Promise.resolve(false);
  }
  if (state.saving) {
    return state.savePromise || Promise.resolve(false);
  }

  window.clearTimeout(state.saveTimer);
  window.clearTimeout(state.retryTimer);
  state.saveTimer = null;
  state.retryTimer = null;

  if (!state.dirty) {
    return Promise.resolve(true);
  }

  const payload = buildPayload();
  state.dirty = false;
  state.saving = true;

  state.savePromise = (async () => {
    try {
      await request("/api/documents/" + encodeURIComponent(state.documentId), {
        method: "PUT",
        body: payload,
      });

      state.saving = false;
      state.saveErrorNotified = false;
      hideSaveStatus();

      if (state.dirty) {
        scheduleSave(350);
      }
      return true;
    } catch (error) {
      state.saving = false;
      state.dirty = true;
      showSaveStatus();

      if (!state.saveErrorNotified) {
        showToast(
          error.userMessage || "Your latest changes couldn't be saved. Grapho will keep trying.",
          true,
        );
        state.saveErrorNotified = true;
      }

      window.clearTimeout(state.retryTimer);
      state.retryTimer = window.setTimeout(() => {
        if (state.dirty && !state.saving) {
          saveNow();
        }
      }, 5000);
      return false;
    } finally {
      state.savePromise = null;
    }
  })();

  return state.savePromise;
}

async function flushBeforeLeaving() {
  if (!state.loaded) {
    return true;
  }
  let attempts = 0;
  while ((state.dirty || state.saving) && attempts < 2) {
    await saveNow();
    attempts += 1;
  }
  return !state.dirty && !state.saving;
}

function handleHomeLink(event) {
  if (
    !state.loaded ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  if (!state.dirty && !state.saving) {
    return;
  }

  event.preventDefault();
  flushBeforeLeaving().then((saved) => {
    if (saved) {
      window.location.assign("/");
    } else {
      showToast("Your latest changes couldn't be saved. Try once more before leaving.", true);
    }
  });
}

function persistBeforeLeaving() {
  if (!state.loaded || !state.dirty || state.saving) {
    return;
  }
  const payload = buildPayload();
  try {
    fetch("/api/documents/" + encodeURIComponent(state.documentId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (error) {
    // keepalive is best effort
  }
}

function hideSaveStatus() {
  els.saveStatus.hidden = true;
}

function showSaveStatus() {
  els.saveStatus.hidden = false;
}

/* --------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */

function bindEvents() {
  els.documentTitle.addEventListener("input", () => {
    if (!state.loaded) {
      return;
    }
    updatePageTitle();
    markDirty();
  });

  els.documentTitle.addEventListener("blur", normalizeTitleField);
  els.documentTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.loaded) {
      event.preventDefault();
      editor.focusEditor();
      editor.moveToDocumentEdge(true);
    }
  });

  els.saveStatus.addEventListener("click", () => {
    if (!state.loaded || state.saving) {
      return;
    }
    if (state.dirty) {
      saveNow();
    }
  });

  els.formatToolbar.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) {
      event.preventDefault();
    }
  });

  els.formatToolbar.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button || button.disabled) {
      return;
    }
    runCommand(button.dataset.command);
  });

  els.blockStyle.addEventListener("change", () => {
    if (!state.loaded) {
      return;
    }
    const type = els.blockStyle.value;
    if (type === "blockquote") {
      editor.setBlockType("quote");
    } else {
      editor.setBlockType(type);
    }
    editor.focusEditor();
  });

  els.linkButton.addEventListener("click", openLinkDialog);
  els.imageButton.addEventListener("click", openImagePicker);
  els.imageInput.addEventListener("change", handleImagePicked);

  els.imageMenu.addEventListener("click", handleImageMenuClick);
  els.imageMenu.addEventListener("keydown", (event) => {
    if (!state.imageEntry) {
      return;
    }
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const index = state.imageEntry.index;
      editor.nudgeImage(event.key, event.shiftKey ? 24 : 4);
      const entry = editor.entryFor(index);
      if (entry) {
        state.imageEntry = entry;
        updateImageMenuChecks(entry);
        positionImageMenu(entry);
      }
      return;
    }
    if (event.key !== "Backspace" && event.key !== "Delete") {
      return;
    }
    event.preventDefault();
    const index = state.imageEntry.index;
    closeImageMenu();
    editor.deleteBlockAt(index);
    editor.focusEditor();
  });
  document.addEventListener("mousedown", handleDocumentPointer);
  window.addEventListener("scroll", closeImageMenu, { passive: true });
  window.addEventListener("resize", closeImageMenu);

  els.editor.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  els.editor.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = imageFilesFrom(event.dataTransfer && event.dataTransfer.files);
    if (!files.length) {
      showToast("Only image files can be dropped into a document.", true);
      return;
    }
    editor.focusEditor();
    editor.collapseTo(editor.positionFromEvent(event));
    addImages(files);
  });

  els.documentMenuButton.addEventListener("click", toggleDocumentMenu);
  els.documentMenu.addEventListener("click", handleDocumentMenuAction);

  els.backToLibrary.addEventListener("click", handleHomeLink);

  els.linkForm.addEventListener("submit", applyLink);
  els.linkCancel.addEventListener("click", () => {
    closeLinkDialog();
    editor.focusEditor();
  });
  els.linkRemove.addEventListener("click", removeLink);

  els.deleteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    deleteDocument();
  });
  els.deleteCancel.addEventListener("click", closeDeleteDialog);

  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("beforeunload", persistBeforeLeaving);
}

function runCommand(command) {
  if (!state.loaded || !command) {
    return;
  }
  switch (command) {
    case "undo":
      editor.undo();
      break;
    case "redo":
      editor.redo();
      break;
    case "bold":
      editor.toggleMark("b");
      break;
    case "italic":
      editor.toggleMark("i");
      break;
    case "underline":
      editor.toggleMark("u");
      break;
    case "strikeThrough":
      editor.toggleMark("s");
      break;
    case "insertUnorderedList":
      editor.toggleList(false);
      break;
    case "insertOrderedList":
      editor.toggleList(true);
      break;
    case "removeFormat":
      editor.clearFormatting();
      break;
    default:
      break;
  }
  editor.focusEditor();
}

function handleSelectionChange(info) {
  if (!state.loaded) {
    return;
  }

  const marks = info.marks || {};
  setPressed("bold", Boolean(marks.b));
  setPressed("italic", Boolean(marks.i));
  setPressed("underline", Boolean(marks.u));
  setPressed("strikeThrough", Boolean(marks.s));

  const undoButton = els.formatToolbar.querySelector('[data-command="undo"]');
  const redoButton = els.formatToolbar.querySelector('[data-command="redo"]');
  if (undoButton) {
    undoButton.disabled = !info.canUndo;
  }
  if (redoButton) {
    redoButton.disabled = !info.canRedo;
  }

  if (els.linkButton) {
    els.linkButton.setAttribute("aria-pressed", marks.href ? "true" : "false");
  }

  const type = info.blockType || "p";
  const options = Array.from(els.blockStyle.options).map((option) => option.value);
  els.blockStyle.value = options.includes(type) ? type : "p";

  if (info.image) {
    state.imageEntry = info.image;
  }
}

function setPressed(command, pressed) {
  const button = els.formatToolbar.querySelector('[data-command="' + command + '"]');
  if (button) {
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }
}

/* --------------------------------------------------------------------------
   Links
   -------------------------------------------------------------------------- */

function openLinkDialog() {
  if (!state.loaded) {
    return;
  }
  closeDocumentMenu();
  closeImageMenu();

  const selection = editor.getSelection();
  const existing = editor.linkAtCaret();
  if (selection.collapsed && !existing) {
    showToast("Select a word or phrase first, then add a link.");
    return;
  }

  els.linkInput.value = existing ? existing.href : "";
  els.linkTitle.textContent = existing ? "Edit link" : "Add a link";
  els.linkDescription.textContent = existing
    ? "Change where this link points, or remove it entirely."
    : "Link the selected text to a web address.";
  els.linkApply.textContent = existing ? "Update link" : "Add link";
  els.linkRemove.hidden = !existing;
  els.linkError.hidden = true;

  if (!els.linkDialog.open) {
    els.linkDialog.showModal();
  }
  window.requestAnimationFrame(() => {
    els.linkInput.focus();
    els.linkInput.select();
  });
}

function closeLinkDialog() {
  if (els.linkDialog.open) {
    els.linkDialog.close();
  }
}

function normalizeLink(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
      return null;
    }
    if (url.protocol === "mailto:" && !value.toLowerCase().startsWith("mailto:")) {
      return null;
    }
    return url.href;
  } catch (error) {
    return null;
  }
}

function applyLink(event) {
  event.preventDefault();
  if (!state.loaded) {
    return;
  }
  const url = normalizeLink(els.linkInput.value);
  if (!url) {
    els.linkError.hidden = false;
    els.linkInput.focus();
    return;
  }
  closeLinkDialog();
  editor.setLink(url);
  editor.focusEditor();
}

function removeLink() {
  closeLinkDialog();
  const hadLink = editor.linkAtCaret();
  if (hadLink) {
    editor.removeLinkAtCaret();
  } else {
    editor.setLink(null);
  }
  editor.focusEditor();
}

/* --------------------------------------------------------------------------
   Images
   -------------------------------------------------------------------------- */

function openImagePicker() {
  if (!state.loaded) {
    return;
  }
  els.imageInput.value = "";
  els.imageInput.click();
}

function handleImagePicked() {
  const files = Array.from(els.imageInput.files || []);
  els.imageInput.value = "";
  if (files.length) {
    addImages(files);
  }
}

function imageFilesFrom(list) {
  return Array.from(list || []).filter((file) => file && /^image\//.test(file.type));
}

async function addImages(files) {
  const images = imageFilesFrom(files);
  if (!images.length) {
    showToast("Only image files can go in a document.", true);
    return;
  }

  let added = 0;
  for (const file of images) {
    try {
      const prepared = await prepareImage(file);
      const block = editor.getDocument()[editor.getSelection().focus.block];
      const offset = editor.getSelection().focus.offset;
      const tail = block && block.type !== "image" ? blockText(block).slice(offset).trim() : "";
      const mode = tail ? "right" : "block";
      cacheImageSize(prepared.src, { width: prepared.width, height: prepared.height });
      editor.insertImage({
        type: "image",
        mode,
        src: prepared.src,
        alt: prepared.alt,
        width: prepared.width,
        height: prepared.height,
      });
      added += 1;
    } catch (error) {
      showToast(error && error.message ? error.message : "That image couldn't be added.", true);
    }
  }

  if (added > 0) {
    showToast(added === 1 ? "Image added." : added + " images added.");
  }
  editor.focusEditor();
}

async function prepareImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    throw new Error("Use a PNG, JPEG, WebP, or GIF image.");
  }

  const alt = imageAltFromName(file.name);
  let image;
  try {
    image = await decodeImage(file);
  } catch (error) {
    throw new Error("That image couldn't be read.");
  }

  const naturalWidth = image.width || image.naturalWidth || 0;
  const naturalHeight = image.height || image.naturalHeight || 0;
  if (image.close) {
    image.close();
  }

  if (file.size <= IMAGE_PASSTHROUGH_BYTES) {
    return {
      src: await readImageFile(file),
      alt,
      width: naturalWidth,
      height: naturalHeight,
    };
  }

  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);

  let src = encodeCanvas(canvas, 0.82);
  if (src.length > IMAGE_MAX_DATA_URL) {
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(1, Math.round(width * 0.72));
    smaller.height = Math.max(1, Math.round(height * 0.72));
    smaller.getContext("2d").drawImage(canvas, 0, 0, smaller.width, smaller.height);
    src = encodeCanvas(smaller, 0.7);
  }
  if (src.length > IMAGE_MAX_DATA_URL) {
    throw new Error("That image is too large to embed, even after shrinking.");
  }

  return { src, alt, width, height };
}

function encodeCanvas(canvas, quality) {
  const src = canvas.toDataURL("image/webp", quality);
  if (src.indexOf("data:image/webp") === 0) {
    return src;
  }
  return canvas.toDataURL("image/jpeg", quality);
}

function decodeImage(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file).catch(() => decodeImageElement(file));
  }
  return decodeImageElement(file);
}

function decodeImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image couldn't be read."));
    };
    image.src = url;
  });
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
  return base.slice(0, 160) || "Image";
}

function openImageMenu(entry) {
  if (!entry || !entry.image) {
    return;
  }
  state.imageEntry = entry;
  updateImageMenuChecks(entry);
  els.imageMenu.hidden = false;
  positionImageMenu(entry);

  const current = els.imageMenu.querySelector('[aria-checked="true"]') || els.imageMenu.querySelector("button");
  if (current) {
    current.focus({ preventScroll: true });
  }
}

function positionImageMenu(entry) {
  const rootRect = els.editor.getBoundingClientRect();
  const menuRect = els.imageMenu.getBoundingClientRect();
  const margin = 12;
  const gap = 10;

  const imageLeft = rootRect.left + entry.image.x;
  const imageTop = rootRect.top + entry.image.y;
  const imageBottom = imageTop + entry.image.height;
  const imageRight = imageLeft + entry.image.width;

  let left = Math.min(imageRight - menuRect.width, window.innerWidth - menuRect.width - margin);
  left = Math.max(margin, left);

  let top = imageTop - menuRect.height - gap;
  if (top < margin) {
    top = Math.min(imageBottom + gap, window.innerHeight - menuRect.height - margin);
    top = Math.max(margin, top);
  }

  els.imageMenu.style.left = Math.round(left) + "px";
  els.imageMenu.style.top = Math.round(top) + "px";
}

function updateImageMenuChecks(entry) {
  const block = entry && entry.block ? entry.block : null;
  const mode = block ? block.mode : "block";
  els.imageMenu.querySelectorAll("[data-image-align]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.imageAlign === mode ? "true" : "false");
  });
  const original = els.imageMenu.querySelector('[data-image-action="original"]');
  if (original) {
    const resized = Boolean(
      block &&
        Number.isFinite(block.displayWidth) &&
        (!block.width || Math.abs(block.displayWidth - block.width) > 0.5),
    );
    original.hidden = !resized;
  }
}

function handleImageMenuClick(event) {
  const button = event.target.closest("button");
  if (!button || !state.imageEntry) {
    return;
  }
  const index = state.imageEntry.index;

  if (button.dataset.imageAction === "remove") {
    closeImageMenu();
    editor.deleteBlockAt(index);
    editor.focusEditor();
    return;
  }

  if (button.dataset.imageAction === "original") {
    const natural = state.imageEntry.block.width;
    closeImageMenu();
    editor.updateImageBlock(index, { displayWidth: natural > 0 ? natural : null });
    editor.focusEditor();
    return;
  }

  const mode = button.dataset.imageAlign;
  if (!mode) {
    return;
  }
  closeImageMenu();
  editor.updateImageBlock(index, { mode });
  editor.focusEditor();
}

function closeImageMenu() {
  if (els.imageMenu.hidden) {
    return;
  }
  els.imageMenu.hidden = true;
  state.imageEntry = null;
}

function handleDocumentPointer(event) {
  if (!els.imageMenu.hidden && !els.imageMenu.contains(event.target) && !event.target.closest(".doc-image")) {
    closeImageMenu();
  }
  if (!els.documentMenu.hidden && !els.documentMenu.contains(event.target) && !event.target.closest("#documentMenuButton")) {
    closeDocumentMenu();
  }
}

/* --------------------------------------------------------------------------
   Document menu, export, and delete
   -------------------------------------------------------------------------- */

function toggleDocumentMenu() {
  if (els.documentMenuButton.disabled) {
    return;
  }
  const willOpen = els.documentMenu.hidden;
  if (!willOpen) {
    closeDocumentMenu(true);
    return;
  }
  els.documentMenu.hidden = false;
  els.documentMenuButton.setAttribute("aria-expanded", "true");
}

function closeDocumentMenu(restoreFocus) {
  if (els.documentMenu.hidden) {
    return;
  }
  els.documentMenu.hidden = true;
  els.documentMenuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    els.documentMenuButton.focus();
  }
}

function handleDocumentMenuAction(event) {
  const item = event.target.closest("[data-doc-action]");
  if (!item) {
    return;
  }
  closeDocumentMenu();

  switch (item.dataset.docAction) {
    case "export-html":
      exportHtml();
      els.documentMenuButton.focus();
      break;
    case "export-markdown":
      exportMarkdown();
      els.documentMenuButton.focus();
      break;
    case "export-text":
      exportText();
      els.documentMenuButton.focus();
      break;
    case "delete":
      openDeleteDialog();
      break;
    default:
      break;
  }
}

function exportHtml() {
  if (!state.loaded) {
    return;
  }
  const title = normalizeTitle(els.documentTitle.value);
  const escapedTitle = escapeHtml(title);
  const body = serializeDocument(editor.getDocument());
  const exported = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>" + escapedTitle + "</title>",
    "<style>",
    "body{max-width:720px;margin:8vh auto;padding:0 28px;color:#272a23;",
    "background:#fbf8f1;font-family:Georgia,'Times New Roman',serif;",
    "font-size:18px;line-height:1.8;}",
    "h1{font-size:2.3em;line-height:1.15;letter-spacing:-.03em;margin:0 0 1.1em;}",
    "h2{font-size:1.55em;line-height:1.3;}h3{font-size:1.25em;}",
    "p{margin:0 0 1em;}blockquote{margin:1.4em 0;padding-left:1.2em;",
    "border-left:2px solid #1967d2;font-style:italic;color:#4a4e43;}",
    "pre{padding:16px;background:#f1ece1;border-radius:8px;white-space:pre-wrap;",
    "font-family:ui-monospace,Consolas,monospace;font-size:.8em;}",
    "code{font-family:ui-monospace,Consolas,monospace;font-size:.84em;}",
    "img{display:block;max-width:100%;height:auto;margin:1.6em auto;border-radius:6px;}",
    "img.wrap-left{float:left;max-width:42%;margin:.35em 1.35em 0 0;}",
    "img.wrap-right{float:right;max-width:42%;margin:.35em 0 0 1.35em;}",
    "h2,h3,h4,blockquote,pre{clear:both;}",
    "a{color:#185abc;}footer{margin-top:3em;padding-top:1em;border-top:1px solid #ddd6c8;",
    "color:#8c8b7e;font:12px system-ui,sans-serif;}",
    "</style>",
    "</head>",
    "<body>",
    "<article>",
    "<h1>" + escapedTitle + "</h1>",
    body,
    "</article>",
    "<footer>Exported from Grapho</footer>",
    "</body>",
    "</html>",
  ].join("\n");

  downloadFile(slugify(title) + ".html", exported, "text/html;charset=utf-8");
  showToast("HTML download started.");
}

function exportText() {
  if (!state.loaded) {
    return;
  }
  const title = normalizeTitle(els.documentTitle.value);
  const blocks = editor.getDocument();
  const parts = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "list") {
      const lines = [];
      while (index < blocks.length && blocks[index].type === "list") {
        const item = blocks[index];
        const marker = item.ordered ? "1. " : "- ";
        lines.push("  ".repeat(item.depth || 0) + marker + blockText(item));
        index += 1;
      }
      index -= 1;
      parts.push(lines.join("\n"));
      continue;
    }
    if (block.type === "image") {
      parts.push(block.alt ? "[" + block.alt + "]" : "");
      continue;
    }
    parts.push(blockText(block));
  }

  const text = parts.filter((part) => part.length).join("\n\n").trim();
  const exported = title + "\n\n" + text + (text ? "\n" : "");
  downloadFile(slugify(title) + ".txt", exported, "text/plain;charset=utf-8");
  showToast("Text download started.");
}

function exportMarkdown() {
  if (!state.loaded) {
    return;
  }
  const title = normalizeTitle(els.documentTitle.value);
  const blocks = editor.getDocument();
  const parts = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];

    if (block.type === "list") {
      const group = [];
      while (index < blocks.length && blocks[index].type === "list") {
        group.push(blocks[index]);
        index += 1;
      }
      index -= 1;
      parts.push(listMarkdown(group));
      continue;
    }

    if (block.type === "image") {
      parts.push(markdownImage(block));
      continue;
    }
    if (block.type === "code") {
      parts.push("```\n" + blockText(block).replace(/\s+$/, "") + "\n```");
      continue;
    }
    if (block.type === "quote") {
      const quoted = markdownRuns(block.runs).trim();
      parts.push(quoted.split("\n").map((line) => (line ? "> " + line : ">")).join("\n"));
      continue;
    }
    if (block.type === "h1" || block.type === "h2" || block.type === "h3" || block.type === "h4") {
      const level = Number(block.type.slice(1));
      parts.push("#".repeat(level) + " " + markdownRuns(block.runs).trim());
      continue;
    }
    parts.push(markdownRuns(block.runs).trim());
  }

  const body = parts.filter((part) => part.length).join("\n\n");
  const exported = "# " + title + (body ? "\n\n" + body : "") + "\n";
  downloadFile(slugify(title) + ".md", exported, "text/markdown;charset=utf-8");
  showToast("Markdown download started.");
}

function listMarkdown(items) {
  const counters = [];
  const lines = [];

  for (const item of items) {
    const depth = Math.min(item.depth || 0, 5);
    counters.length = depth + 1;
    const indent = "  ".repeat(depth);
    if (item.ordered) {
      counters[depth] = (counters[depth] || 0) + 1;
      lines.push(indent + counters[depth] + ". " + markdownRuns(item.runs).trim());
    } else {
      lines.push(indent + "- " + markdownRuns(item.runs).trim());
    }
  }

  return lines.join("\n");
}

function markdownRuns(runs) {
  let out = "";
  for (const run of runs) {
    let text = escapeMarkdown(run.text).replace(/\n/g, "  \n");
    if (run.code) {
      text = inlineCode(text);
    }
    if (run.s) {
      text = wrapMark(text, "~~");
    }
    if (run.u) {
      text = wrapMark(text, "<u>", "</u>");
    }
    if (run.i) {
      text = wrapMark(text, "*");
    }
    if (run.b) {
      text = wrapMark(text, "**");
    }
    if (run.href) {
      text = "[" + text.trim() + "](" + run.href + ")";
    }
    out += text;
  }
  return out;
}

function markdownImage(block) {
  const alt = String(block.alt || "").replace(/\s+/g, " ").trim();
  return "![" + alt + "](" + block.src + ")";
}

function wrapMark(inner, open, close) {
  const leading = /^\s*/.exec(inner)[0];
  const trailing = /\s*$/.exec(inner)[0];
  const core = inner.slice(leading.length, inner.length - trailing.length);
  if (!core) {
    return inner;
  }
  return leading + open + core + (close === undefined ? open : close) + trailing;
}

function inlineCode(text) {
  const code = text.replace(/\s+/g, " ").trim();
  if (!code) {
    return "";
  }
  if (code.indexOf("`") === -1) {
    return "`" + code + "`";
  }
  return "`` " + code + " ``";
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_[\]])/g, "\\$1");
}

function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "document").slice(0, 80);
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openDeleteDialog() {
  if (!state.loaded || els.deleteDialog.open) {
    return;
  }
  closeDocumentMenu();
  state.deleting = false;
  els.deleteConfirm.disabled = false;
  els.deleteCancel.disabled = false;
  els.deleteConfirm.textContent = "Delete";
  els.deleteDialog.showModal();
  window.requestAnimationFrame(() => els.deleteConfirm.focus());
}

function closeDeleteDialog() {
  if (state.deleting) {
    return;
  }
  if (els.deleteDialog.open) {
    els.deleteDialog.close();
  }
}

async function deleteDocument() {
  if (!state.loaded || state.deleting) {
    return;
  }
  state.deleting = true;
  els.deleteConfirm.disabled = true;
  els.deleteCancel.disabled = true;
  els.deleteConfirm.textContent = "Deleting…";

  try {
    await request("/api/documents/" + encodeURIComponent(state.documentId), { method: "DELETE" });
    state.loaded = false;
    state.dirty = false;
    window.location.assign("/");
  } catch (error) {
    state.deleting = false;
    els.deleteConfirm.disabled = false;
    els.deleteCancel.disabled = false;
    els.deleteConfirm.textContent = "Delete";
    showToast(error.userMessage || "That document couldn't be deleted.", true);
  }
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    if (!els.imageMenu.hidden) {
      event.preventDefault();
      closeImageMenu();
      editor.focusEditor();
      return;
    }
    if (!els.documentMenu.hidden) {
      event.preventDefault();
      closeDocumentMenu(true);
      return;
    }
  }

  if (!state.loaded) {
    return;
  }

  const commandKey = event.ctrlKey || event.metaKey;
  if (!commandKey) {
    return;
  }

  if (event.key.toLocaleLowerCase() === "s") {
    event.preventDefault();
    if (!els.linkDialog.open && !els.deleteDialog.open) {
      saveNow();
    }
  }
}

/* --------------------------------------------------------------------------
   Network and small utilities
   -------------------------------------------------------------------------- */

async function request(path, options) {
  const fetchOptions = Object.assign({}, options || {});
  fetchOptions.headers = { Accept: "application/json" };

  if (fetchOptions.body && typeof fetchOptions.body !== "string") {
    fetchOptions.headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(fetchOptions.body);
  }

  let response;
  try {
    response = await fetch(path, fetchOptions);
  } catch (networkError) {
    const offline = new Error("Network request failed");
    offline.status = 0;
    offline.userMessage = "Couldn't reach Grapho. Check that the server is still running.";
    throw offline;
  }

  if (!response.ok) {
    const message =
      response.status === 404 ? "That document no longer exists." : "The request couldn't be completed.";
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    const failure = new Error(payload && payload.error ? payload.error : message);
    failure.status = response.status;
    failure.userMessage = failure.message;
    throw failure;
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function showToast(message, isError) {
  if (!message) {
    return;
  }
  els.toast.textContent = message;
  els.toast.classList.toggle("is-error", Boolean(isError));
  els.toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2600);
}
