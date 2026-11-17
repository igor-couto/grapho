// Grapho's editor page: loads a document, owns the pretext-backed editor, and
// handles saving, formatting, links, images, and export.

import {
  IMAGE_RADIUS_DEFAULT,
  IMAGE_RADIUS_LIMIT,
  blockText,
  imageRadius,
  parseDocument,
  serializeDocument,
} from "./doc/model.js";
import { DocEditor } from "./doc/input.js";
import { IMAGE_MAX_DATA_URL, encodeCanvas, transformImage } from "./doc/image.js";
import { cacheImageSize, ensureFonts, loadMissingImages } from "./doc/layout.js";
import { buildPdf } from "./doc/pdf.js";

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
  imageBusy: false,
  toastTimer: null,
  paperWidth: null,
  paperDrag: null,
  exportingPdf: false,
  focusMode: false,
};

const els = {};
let editor = null;

const IMAGE_MAX_EDGE = 1600;
const IMAGE_PASSTHROUGH_BYTES = 600 * 1024;
const PAPER_MIN_WIDTH = 360;
const PAPER_DEFAULT_WIDTH = 900; // Keep in sync with .editor-column in app.css.
const PAPER_EDGE_GAP = 18;
const PAPER_SNAP_DISTANCE = 24;
const PAPER_SNAP_RELEASE_DISTANCE = 44;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  els.saveStatus = document.getElementById("saveStatus");
  els.backToLibrary = document.getElementById("backToLibrary");
  els.documentMenuButton = document.getElementById("documentMenuButton");
  els.documentMenu = document.getElementById("documentMenu");
  els.focusMenuItemLabel = document.getElementById("focusMenuItemLabel");
  els.formatToolbar = document.getElementById("formatToolbar");
  els.styleButton = document.getElementById("styleButton");
  els.styleButtonLabel = document.getElementById("styleButtonLabel");
  els.styleMenu = document.getElementById("styleMenu");
  els.alignButton = document.getElementById("alignButton");
  els.alignMenu = document.getElementById("alignMenu");
  els.linkButton = document.getElementById("linkButton");
  els.imageButton = document.getElementById("imageButton");
  els.imageInput = document.getElementById("imageInput");
  els.imageMenu = document.getElementById("imageMenu");
  els.imageRadiusInput = document.getElementById("imageRadiusInput");
  els.paper = document.getElementById("paper");
  els.editorColumn = document.querySelector(".editor-column");
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
    onImageDragStart: closeImageMenu,
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
  applyPaperWidth(paperWidthFrom(document.paper_width));

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
  els.paper.querySelectorAll(".paper-grip").forEach((grip) => {
    grip.hidden = true;
  });
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
  document.title = notFound ? "Document not found - Grapho" : "Couldn't open document - Grapho";
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
  els.formatToolbar.querySelectorAll("button").forEach((control) => {
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
  document.title = title + " - Grapho";
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
  const payload = {
    title: normalizeTitle(els.documentTitle.value),
    content: hasContent ? serializeDocument(blocks) : "",
    // Zero tells the server to drop a stored width, so a document snapped back
    // to the default follows the stylesheet again.
    paper_width: state.paperWidth || 0,
  };
  return payload;
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

  els.styleButton.addEventListener("click", toggleStyleMenu);
  els.styleMenu.addEventListener("click", handleStyleMenuClick);
  els.styleMenu.addEventListener("keydown", handleStyleMenuKeydown);
  els.formatToolbar.addEventListener("scroll", closeStyleMenu, { passive: true });

  els.linkButton.addEventListener("click", openLinkDialog);
  els.imageButton.addEventListener("click", openImagePicker);
  els.imageInput.addEventListener("change", handleImagePicked);
  els.imageRadiusInput.addEventListener("input", handleImageRadiusInput);
  els.imageRadiusInput.addEventListener("blur", handleImageRadiusBlur);

  els.alignButton.addEventListener("click", toggleAlignMenu);
  els.alignMenu.addEventListener("click", handleAlignMenuClick);
  els.alignMenu.addEventListener("keydown", handleAlignMenuKeydown);
  els.formatToolbar.addEventListener("scroll", closeAlignMenu, { passive: true });

  els.imageMenu.addEventListener("click", handleImageMenuClick);
  els.imageMenu.addEventListener("keydown", (event) => {
    // The radius field needs its own arrow keys, Backspace, and Delete.
    if (event.target.closest(".image-radius-input")) {
      return;
    }
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
  // The editor cancels pointerdown, which suppresses the mouse events that
  // follow, so menu dismissal has to listen for the pointer event itself.
  document.addEventListener("pointerdown", handleDocumentPointer);
  bindPaperResize();
  window.addEventListener("scroll", closeImageMenu, { passive: true });
  window.addEventListener("scroll", closeAlignMenu, { passive: true });
  window.addEventListener("scroll", closeStyleMenu, { passive: true });
  window.addEventListener("resize", closeImageMenu);
  window.addEventListener("resize", closeAlignMenu);
  window.addEventListener("resize", closeStyleMenu);

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

  // The whole sheet shows the text cursor, so a click on its margins or in the
  // space below the last line has to put the caret on the nearest line instead
  // of doing nothing.
  els.paper.addEventListener("pointerdown", (event) => {
    if (!state.loaded || event.button !== 0 || event.isPrimary === false) {
      return;
    }
    if (els.editor.contains(event.target) || event.target.closest(".paper-grip, .document-title, .load-error")) {
      return;
    }
    event.preventDefault();
    editor.focusEditor();
    editor.collapseTo(editor.positionFromEvent(event));
  });

  els.documentMenuButton.addEventListener("click", toggleDocumentMenu);
  els.documentMenu.addEventListener("click", handleDocumentMenuAction);
  document.addEventListener("fullscreenchange", handleFullscreenChange);

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

/* --------------------------------------------------------------------------
   Paper width
   -------------------------------------------------------------------------- */

function paperWidthFrom(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}

function applyPaperWidth(width) {
  state.paperWidth = width;
  if (width) {
    els.editorColumn.style.width = width + "px";
  } else {
    els.editorColumn.style.removeProperty("width");
  }
}

// The page grows in both directions from the centre, so the widest it can get
// is the workspace minus a small gap at each edge of the screen. The default
// width is always reachable, even when the window is narrower than it.
function paperWidthBounds() {
  const workspace = els.editorColumn.parentElement;
  const styles = window.getComputedStyle(workspace);
  const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const available = Math.max(0, workspace.clientWidth - padding);
  const min = Math.min(PAPER_MIN_WIDTH, available);
  const defaultWidth = Math.min(PAPER_DEFAULT_WIDTH, available);
  const max = Math.max(min, available - PAPER_EDGE_GAP * 2, defaultWidth);
  return { min, max, defaultWidth };
}

function bindPaperResize() {
  for (const grip of els.paper.querySelectorAll("[data-paper-grip]")) {
    grip.addEventListener("pointerdown", (event) => beginPaperResize(event, grip));
    grip.addEventListener("pointermove", movePaperResize);
    grip.addEventListener("pointerup", endPaperResize);
    grip.addEventListener("pointercancel", endPaperResize);
    grip.addEventListener("lostpointercapture", endPaperResize);
  }
}

function beginPaperResize(event, grip) {
  if (!state.loaded || state.paperDrag || event.button !== 0 || event.isPrimary === false) {
    return;
  }

  const bounds = paperWidthBounds();
  if (bounds.max <= 0) {
    return;
  }

  const startWidth = els.paper.getBoundingClientRect().width;
  event.preventDefault();
  state.paperDrag = {
    pointerId: event.pointerId,
    side: grip.dataset.paperGrip,
    grip,
    startX: event.clientX,
    startWidth,
    min: Math.min(bounds.min, startWidth),
    // A paper already wider than the gap allows (a narrow window) should not
    // shrink when the first movement tries to widen it.
    max: Math.max(bounds.max, startWidth),
    defaultWidth: bounds.defaultWidth,
    snapped: false,
    moved: false,
  };
  grip.setPointerCapture(event.pointerId);
  grip.classList.add("is-active");
  document.body.classList.add("is-resizing-paper");
}

function movePaperResize(event) {
  const drag = state.paperDrag;
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }

  event.preventDefault();
  const distance = drag.side === "left" ? drag.startX - event.clientX : event.clientX - drag.startX;
  // Both edges move, so one pixel of pointer travel adds two pixels of paper.
  const clamped = Math.min(Math.max(drag.startWidth + distance * 2, drag.min), drag.max);
  const offset = Math.abs(clamped - drag.defaultWidth);
  // Hold the default a little longer than it takes to enter it, so the snap
  // feels magnetic instead of flickering whenever the pointer crosses it.
  drag.snapped = drag.snapped
    ? offset <= PAPER_SNAP_RELEASE_DISTANCE
    : offset <= PAPER_SNAP_DISTANCE;
  drag.grip.classList.toggle("is-snapped", drag.snapped);

  const width = drag.snapped ? null : Math.round(clamped);
  if (width !== state.paperWidth) {
    applyPaperWidth(width);
    drag.moved = true;
  }
}

function endPaperResize(event) {
  const drag = state.paperDrag;
  if (!drag || (event && event.pointerId !== drag.pointerId)) {
    return;
  }

  state.paperDrag = null;
  drag.grip.classList.remove("is-active", "is-snapped");
  if (drag.grip.hasPointerCapture(drag.pointerId)) {
    drag.grip.releasePointerCapture(drag.pointerId);
  }
  document.body.classList.remove("is-resizing-paper");
  if (drag.moved) {
    markDirty();
  }
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
  updateStyleState(type);
  updateAlignState(info.alignment || "left");

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
   Paragraph style
   -------------------------------------------------------------------------- */

const STYLE_LABELS = {
  p: "Normal text",
  h1: "Heading 1",
  h2: "Heading 2",
  quote: "Quote",
  code: "Code block",
};

function updateStyleState(type) {
  const value = STYLE_LABELS[type] ? type : "p";
  els.styleButtonLabel.textContent = STYLE_LABELS[value];
  els.styleButton.setAttribute("aria-label", "Paragraph style: " + STYLE_LABELS[value]);
  els.styleMenu.querySelectorAll("[data-block-style]").forEach((item) => {
    item.setAttribute("aria-checked", item.dataset.blockStyle === value ? "true" : "false");
  });
}

function toggleStyleMenu() {
  if (els.styleButton.disabled) {
    return;
  }
  if (!els.styleMenu.hidden) {
    closeStyleMenu(true);
    return;
  }

  closeAlignMenu();
  closeDocumentMenu();
  closeImageMenu();
  els.styleMenu.hidden = false;
  els.styleButton.setAttribute("aria-expanded", "true");
  positionStyleMenu();

  const current = els.styleMenu.querySelector('[aria-checked="true"]') || els.styleMenu.querySelector("button");
  if (current) {
    current.focus({ preventScroll: true });
  }
}

function closeStyleMenu(restoreFocus) {
  if (els.styleMenu.hidden) {
    return;
  }
  els.styleMenu.hidden = true;
  els.styleButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    els.styleButton.focus();
  }
}

function positionStyleMenu() {
  const buttonRect = els.styleButton.getBoundingClientRect();
  const menuRect = els.styleMenu.getBoundingClientRect();
  const margin = 12;
  const gap = 8;

  let left = buttonRect.left;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  left = Math.max(margin, left);

  let top = buttonRect.bottom + gap;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = buttonRect.top - menuRect.height - gap;
  }
  top = Math.max(margin, top);

  els.styleMenu.style.left = Math.round(left) + "px";
  els.styleMenu.style.top = Math.round(top) + "px";
}

function handleStyleMenuClick(event) {
  const choice = event.target.closest("[data-block-style]");
  if (!choice) {
    return;
  }
  closeStyleMenu();
  editor.setBlockType(choice.dataset.blockStyle);
  editor.focusEditor();
}

function handleStyleMenuKeydown(event) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const items = Array.from(els.styleMenu.querySelectorAll("[data-block-style]"));
  const index = items.indexOf(document.activeElement);
  if (index === -1) {
    return;
  }
  event.preventDefault();
  const offset = event.key === "ArrowDown" ? 1 : -1;
  items[(index + offset + items.length) % items.length].focus();
}

/* --------------------------------------------------------------------------
   Alignment and indent
   -------------------------------------------------------------------------- */

const ALIGNMENT_LABELS = {
  left: "left",
  center: "centered",
  right: "right",
  justify: "justified",
};

function updateAlignState(alignment) {
  const value = ALIGNMENT_LABELS[alignment] ? alignment : "left";
  els.alignButton.dataset.currentAlign = value;
  els.alignButton.setAttribute("aria-label", "Align & indent: " + ALIGNMENT_LABELS[value]);
  els.alignMenu.querySelectorAll("[data-align-value]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.alignValue === value ? "true" : "false");
  });
}

function toggleAlignMenu() {
  if (els.alignButton.disabled) {
    return;
  }
  if (!els.alignMenu.hidden) {
    closeAlignMenu(true);
    return;
  }

  closeDocumentMenu();
  closeImageMenu();
  closeStyleMenu();
  els.alignMenu.hidden = false;
  els.alignButton.setAttribute("aria-expanded", "true");
  positionAlignMenu();

  const current = els.alignMenu.querySelector('[aria-checked="true"]') || els.alignMenu.querySelector("button");
  if (current) {
    current.focus({ preventScroll: true });
  }
}

function closeAlignMenu(restoreFocus) {
  if (els.alignMenu.hidden) {
    return;
  }
  els.alignMenu.hidden = true;
  els.alignButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    els.alignButton.focus();
  }
}

function positionAlignMenu() {
  const buttonRect = els.alignButton.getBoundingClientRect();
  const menuRect = els.alignMenu.getBoundingClientRect();
  const margin = 12;
  const gap = 8;

  let left = buttonRect.left;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  left = Math.max(margin, left);

  let top = buttonRect.bottom + gap;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = buttonRect.top - menuRect.height - gap;
  }
  top = Math.max(margin, top);

  els.alignMenu.style.left = Math.round(left) + "px";
  els.alignMenu.style.top = Math.round(top) + "px";
}

function handleAlignMenuClick(event) {
  const alignChoice = event.target.closest("[data-align-value]");
  if (alignChoice) {
    editor.setAlignment(alignChoice.dataset.alignValue);
    closeAlignMenu();
    editor.focusEditor();
    return;
  }

  const indentChoice = event.target.closest("[data-indent-action]");
  if (indentChoice) {
    editor.changeIndent(Number(indentChoice.dataset.indentAction));
    closeAlignMenu();
    editor.focusEditor();
  }
}

function handleAlignMenuKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    return;
  }
  const items = Array.from(els.alignMenu.querySelectorAll("button:not(:disabled)"));
  const index = items.indexOf(document.activeElement);
  if (index === -1) {
    return;
  }
  event.preventDefault();
  const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
  items[(index + offset + items.length) % items.length].focus();
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
  closeAlignMenu();
  closeStyleMenu();

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

  // A large file is drawn into a canvas before it is stored, and a closed
  // ImageBitmap cannot be drawn: Chrome throws "The image source is detached".
  // Read the size and finish every draw while the bitmap is still alive.
  const naturalWidth = image.width || image.naturalWidth || 0;
  const naturalHeight = image.height || image.naturalHeight || 0;
  try {
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
  } finally {
    if (image.close) {
      image.close();
    }
  }
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
  closeAlignMenu();
  closeStyleMenu();
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
  els.imageMenu.querySelectorAll("[data-image-mode]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.imageMode === mode ? "true" : "false");
  });

  // The alignment row is the placement: the sides wrap the picture, and the
  // middle keeps it on its own line in the middle at the size it already has.
  const placement = mode === "left" || mode === "right" ? mode : mode === "block" ? "center" : "";
  els.imageMenu.querySelectorAll("[data-image-align]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.imageAlign === placement ? "true" : "false");
  });

  if (els.imageRadiusInput && block) {
    els.imageRadiusInput.value = String(imageRadius(block));
  }
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

  if (button.dataset.imageTransform) {
    // The menu stays open: turning a photo straight twice is one gesture.
    transformSelectedImage(button.dataset.imageTransform);
    return;
  }

  if (button.dataset.imageAlign) {
    // Also a quick repeated choice: left, then centre, then right.
    applyImagePlacement(button.dataset.imageAlign);
    return;
  }

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

  const mode = button.dataset.imageMode;
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

function applyImagePlacement(placement) {
  const entry = state.imageEntry;
  if (!entry || !entry.block || !entry.image) {
    return;
  }
  const index = entry.index;

  if (placement === "center") {
    // Block already centres a picture on its own line; pinning the width it has
    // now is what keeps this from sizing it up the way Block does.
    if (entry.block.mode === "block") {
      return;
    }
    editor.updateImageBlock(index, {
      mode: "block",
      displayWidth: Math.max(1, Math.round(entry.image.width)),
    });
  } else {
    if (entry.block.mode === placement) {
      return;
    }
    editor.updateImageBlock(index, { mode: placement });
  }

  const next = editor.entryFor(index);
  if (next) {
    state.imageEntry = next;
    updateImageMenuChecks(next);
    positionImageMenu(next);
  }
}

async function transformSelectedImage(action) {
  const entry = state.imageEntry;
  if (state.imageBusy || !entry || !entry.image) {
    return;
  }
  const index = entry.index;
  const block = entry.block;
  if (!block || block.type !== "image") {
    return;
  }

  state.imageBusy = true;
  setImageToolsBusy(true);
  try {
    const image = await transformImage(block.src, action);
    // Pixels take a moment to make, and the document can move on meanwhile.
    // Never write the result into whatever block has taken this index since.
    if (editor.getDocument()[index] !== block) {
      return;
    }

    // A turn swaps the picture's sides. Keeping the rendered height as the new
    // rendered width holds a resized image at the size it was scaled to.
    const displayWidth =
      Number.isFinite(block.displayWidth) && entry.image
        ? Math.max(48, Math.round(entry.image.height))
        : null;

    // The layout's image cache is keyed by source, so the freshly encoded
    // bitmap is unknown to it until it is told the size the block now carries.
    cacheImageSize(image.src, { width: image.width, height: image.height });

    editor.updateImageBlock(index, {
      src: image.src,
      width: image.width,
      height: image.height,
      displayWidth,
    });

    if (!els.imageMenu.hidden) {
      const next = editor.entryFor(index);
      if (next) {
        state.imageEntry = next;
        updateImageMenuChecks(next);
        positionImageMenu(next);
      }
    }
  } catch (error) {
    console.error(error);
    showToast(error && error.message ? error.message : "That image couldn't be changed.", true);
    closeImageMenu();
  } finally {
    state.imageBusy = false;
    setImageToolsBusy(false);
  }
}

function setImageToolsBusy(busy) {
  els.imageMenu.querySelectorAll("[data-image-transform]").forEach((button) => {
    button.disabled = busy;
  });
}

function handleImageRadiusInput() {
  const entry = state.imageEntry;
  if (!entry || !entry.block || entry.block.type !== "image") {
    return;
  }
  const typed = els.imageRadiusInput.value.trim();
  const parsed = Number(typed);
  if (typed === "" || !Number.isFinite(parsed)) {
    return;
  }
  const radius = Math.min(IMAGE_RADIUS_LIMIT, Math.max(0, Math.round(parsed)));
  if (radius === imageRadius(entry.block)) {
    return;
  }
  editor.updateImageBlock(
    entry.index,
    { radius: radius === IMAGE_RADIUS_DEFAULT ? null : radius },
    { coalesce: true },
  );
}

function handleImageRadiusBlur() {
  const entry = state.imageEntry;
  if (entry && entry.block) {
    els.imageRadiusInput.value = String(imageRadius(entry.block));
  }
}

function handleDocumentPointer(event) {
  if (!els.imageMenu.hidden && !els.imageMenu.contains(event.target)) {
    closeImageMenu();
  }
  if (!els.documentMenu.hidden && !els.documentMenu.contains(event.target) && !event.target.closest("#documentMenuButton")) {
    closeDocumentMenu();
  }
  if (!els.alignMenu.hidden && !els.alignMenu.contains(event.target) && !event.target.closest("#alignButton")) {
    closeAlignMenu();
  }
  if (!els.styleMenu.hidden && !els.styleMenu.contains(event.target) && !event.target.closest("#styleButton")) {
    closeStyleMenu();
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
  closeAlignMenu();
  closeImageMenu();
  closeStyleMenu();
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
    case "export-pdf":
      exportPdf();
      els.documentMenuButton.focus();
      break;
    case "focus":
      toggleFocusMode();
      break;
    case "delete":
      openDeleteDialog();
      break;
    default:
      break;
  }
}

/* --------------------------------------------------------------------------
   Focus mode
   -------------------------------------------------------------------------- */

function toggleFocusMode() {
  if (state.focusMode) {
    exitFocusMode();
  } else {
    enterFocusMode();
  }
}

function enterFocusMode() {
  if (state.focusMode) {
    return;
  }
  state.focusMode = true;
  document.body.classList.add("is-focus-mode");
  updateFocusMenuItem();
  editor.focusEditor();
  // The menu click is the user gesture the Fullscreen API needs. If the
  // browser refuses, the page still hides its chrome.
  requestFocusFullscreen();
}

function exitFocusMode() {
  if (!state.focusMode) {
    return;
  }
  state.focusMode = false;
  document.body.classList.remove("is-focus-mode");
  closeDocumentMenu();
  updateFocusMenuItem();
  leaveFocusFullscreen();
  editor.focusEditor();
}

function updateFocusMenuItem() {
  if (els.focusMenuItemLabel) {
    els.focusMenuItemLabel.textContent = state.focusMode ? "Exit focus mode" : "Focus mode";
  }
}

function requestFocusFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) {
    return;
  }
  try {
    const request = root.requestFullscreen();
    if (request && typeof request.catch === "function") {
      request.catch(() => {});
    }
  } catch (error) {
    // Fullscreen is a bonus; focus mode itself needs nothing from it.
  }
}

function leaveFocusFullscreen() {
  if (!document.fullscreenElement || !document.exitFullscreen) {
    return;
  }
  try {
    const request = document.exitFullscreen();
    if (request && typeof request.catch === "function") {
      request.catch(() => {});
    }
  } catch (error) {
    // The browser may have already left fullscreen.
  }
}

function handleFullscreenChange() {
  if (!state.focusMode) {
    return;
  }
  if (!document.fullscreenElement) {
    // Esc or the browser's own control left fullscreen, so leave focus mode
    // with it. Leaving from the menu already cleared the state.
    exitFocusMode();
    return;
  }
  // Fullscreen can move focus off the hidden textarea; put it back so the
  // first keystroke lands in the page.
  editor.focusEditor();
}

function exportHtml() {
  if (!state.loaded) {
    return;
  }
  const title = normalizeTitle(els.documentTitle.value);
  const escapedTitle = escapeHtml(title);
  const blocks = editor.getDocument();
  const body = serializeDocument(blocks);
  // A radius lives on one image, and the export cannot put an inline style on
  // it, so write one rule per radius this document actually uses.
  const radii = new Set();
  for (const block of blocks) {
    if (block.type === "image" && Number.isFinite(block.radius)) {
      radii.add(Math.round(block.radius));
    }
  }
  const radiusRules = Array.from(radii)
    .sort((left, right) => left - right)
    .map((radius) => `img[data-radius="${radius}"]{border-radius:${radius}px;}`);
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
    "img{display:block;max-width:100%;height:auto;margin:1.6em auto;}",
    "img.wrap-left{float:left;max-width:42%;margin:.35em 1.35em 0 0;}",
    "img.wrap-right{float:right;max-width:42%;margin:.35em 0 0 1.35em;}",
    ...radiusRules,
    "h2,h3,h4,blockquote,pre{clear:both;}",
    '[data-align="center"]{text-align:center;}',
    '[data-align="right"]{text-align:right;}',
    '[data-align="justify"]{text-align:justify;}',
    '[data-indent="1"]{margin-left:24px;}',
    '[data-indent="2"]{margin-left:48px;}',
    '[data-indent="3"]{margin-left:72px;}',
    '[data-indent="4"]{margin-left:96px;}',
    '[data-indent="5"]{margin-left:120px;}',
    '[data-indent="6"]{margin-left:144px;}',
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

async function exportPdf() {
  if (!state.loaded || state.exportingPdf) {
    return;
  }
  state.exportingPdf = true;
  showToast("Preparing PDF…");

  try {
    const title = normalizeTitle(els.documentTitle.value);
    const pdf = await buildPdf(editor.getDocument(), title);
    downloadFile(slugify(title) + ".pdf", pdf, "application/pdf");
    showToast("PDF download started.");
  } catch (error) {
    console.error(error);
    showToast("That PDF couldn't be created.", true);
  } finally {
    state.exportingPdf = false;
  }
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
    if (!els.styleMenu.hidden) {
      event.preventDefault();
      closeStyleMenu(true);
      return;
    }
    if (!els.alignMenu.hidden) {
      event.preventDefault();
      closeAlignMenu(true);
      return;
    }
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
    // Escape already collapsed a selection, cancelled an image gesture, or
    // closed a dialog when it reaches this point.
    if (
      state.focusMode &&
      !event.defaultPrevented &&
      !els.linkDialog.open &&
      !els.deleteDialog.open
    ) {
      event.preventDefault();
      exitFocusMode();
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
    if (response.status === 401) {
      // The session ended while the editor was open. Sign in, then come back.
      window.location.assign(
        "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search),
      );
    }

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
