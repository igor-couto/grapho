// Grapho's editor page: loads a document, owns the pretext-backed editor, and
// handles saving, formatting, links, images, and export.

import {
  IMAGE_RADIUS_DEFAULT,
  IMAGE_RADIUS_LIMIT,
  blockText,
  findSearchPassage,
  imageRadius,
  parseDocument,
  serializeDocument,
} from "./doc/model.js";
import { DocEditor } from "./doc/input.js";
import {
  mapRichCaretToSource,
  mapSourceCaretToRich,
  richToSource,
  sourceToRich,
  wrapInlineText,
} from "./doc/markdown.js";
import {
  clearFormatting as clearSourceFormatting,
  inspect as inspectSource,
  linkAt as sourceLinkAt,
  removeLink as removeSourceLink,
  setAlign as setSourceAlign,
  setBlockStyle as setSourceBlockStyle,
  setLink as setSourceLink,
  setMark as setSourceMark,
  toggleList as toggleSourceList,
} from "./doc/markdown-edit.js";
import { IMAGE_MAX_DATA_URL, encodeCanvas, transformImage } from "./doc/image.js";
import { cacheImageSize, ensureFonts, loadMissingImages } from "./doc/layout.js";
import { buildPdf } from "./doc/pdf.js";

const state = {
  documentId: null,
  draft: false,
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
  linkAnchor: null,
  toastTimer: null,
  paperWidth: null,
  paperDrag: null,
  exportingPdf: false,
  focusMode: false,
  // Markdown mode is a per-visit view state (like focus mode): it starts off
  // on every page load and is never stored with the document. The stored HTML
  // stays the interchange format; these fields only hold the transient source
  // form while the mode is on.
  markdownMode: false,
  sourceDirty: false,
  richSnapshot: null,
  richHistory: null,
  markdownConversion: null,
  savedContent: "",
};

const els = {};
let editor = null;

// The link dialog's page search. The listing is read when the dialog opens,
// once per opening like Ctrl+O, and filtered locally as the writer types: no
// request per keystroke. Choosing a result links the selected text to that
// Grapho page instead of a web address.
const linkPicker = {
  documents: null,
  requestId: 0,
  visible: [],
  options: [],
  selected: -1,
};

const LINK_RESULT_LIMIT = 50;
const LINK_PAGE_ICON =
  '<svg viewBox="0 0 32 32" fill="none"><path d="M8 4.5h11.2L25 10.3v17.2H8V4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 4.5v6h6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12.2 16h8.6M12.2 20h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const linkShortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const linkLongDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DEFAULT_TITLE = "Untitled document";
const IMAGE_MAX_EDGE = 1600;
const IMAGE_PASSTHROUGH_BYTES = 600 * 1024;
const IMAGE_DOWNLOAD_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};
const PAPER_MIN_WIDTH = 360;
const PAPER_DEFAULT_WIDTH = 900; // Keep in sync with .editor-column in app.css.
const PAPER_EDGE_GAP = 18;
const PAPER_SNAP_DISTANCE = 24;
const PAPER_SNAP_RELEASE_DISTANCE = 44;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  els.saveStatus = document.getElementById("saveStatus");
  els.backToLibrary = document.getElementById("backToLibrary");
  els.shortcutsLink = document.getElementById("shortcutsLink");
  els.documentMenuButton = document.getElementById("documentMenuButton");
  els.documentMenu = document.getElementById("documentMenu");
  els.focusMenuItemLabel = document.getElementById("focusMenuItemLabel");
  els.markdownMenuItemLabel = document.getElementById("markdownMenuItemLabel");
  els.copyHeadingLink = document.getElementById("copyHeadingLink");
  els.formatToolbar = document.getElementById("formatToolbar");
  els.moreFormattingButton = document.getElementById("moreFormattingButton");
  els.moreFormattingMenu = document.getElementById("moreFormattingMenu");
  els.styleButton = document.getElementById("styleButton");
  els.styleButtonLabel = document.getElementById("styleButtonLabel");
  els.styleMenu = document.getElementById("styleMenu");
  els.alignButton = document.getElementById("alignButton");
  els.alignMenu = document.getElementById("alignMenu");
  els.linkButton = document.getElementById("linkButton");
  els.linkPopover = document.getElementById("linkPopover");
  els.linkDestination = document.getElementById("linkDestination");
  els.linkOpen = document.getElementById("linkOpen");
  els.linkEdit = document.getElementById("linkEdit");
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
  const query = new URLSearchParams(location.search).get("q");
  if (query) {
    const params = new URLSearchParams({ q: query, from: documentIdFromPath() });
    els.backToLibrary.search = params.toString();
    els.loadError.querySelector("a").search = params.toString();
  }
  els.toast = document.getElementById("toast");

  els.linkDialog = document.getElementById("linkDialog");
  els.linkForm = document.getElementById("linkForm");
  els.linkTitle = document.getElementById("linkTitle");
  els.linkInput = document.getElementById("linkInput");
  els.linkError = document.getElementById("linkError");
  els.linkApply = document.getElementById("linkApply");
  els.linkRemove = document.getElementById("linkRemove");
  els.linkCancel = document.getElementById("linkCancel");
  els.linkResults = document.getElementById("linkResults");
  els.linkResultsLabel = document.getElementById("linkResultsLabel");
  els.linkResultsList = document.getElementById("linkResultsList");

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
    onSourceFormat: handleSourceFormat,
    onSourceWrap: wrapSourceTypedText,
  });
  editor.bind();

  bindEvents();
  await loadDocument();
}

/* --------------------------------------------------------------------------
   Loading and saving
   -------------------------------------------------------------------------- */

async function loadDocument() {
  const draftId = location.pathname.match(/^\/doc\/new\/([^/]+)$/)?.[1];
  state.draft = Boolean(draftId);
  state.documentId = draftId || documentIdFromPath();
  if (!state.documentId) {
    showLoadFailure({ status: 404 });
    return;
  }

  try {
    const document = state.draft
      ? {}
      : await request("/api/documents/" + encodeURIComponent(state.documentId));
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

  els.documentTitle.value = document.title || DEFAULT_TITLE;
  els.documentTitle.disabled = false;
  updateTitleDisplay();
  els.paper.setAttribute("aria-busy", "false");
  applyPaperWidth(paperWidthFrom(document.paper_width));

  const returning = history.state?.linkReturn;
  let returnedScrollY;
  loadMissingImages(blocks, () => {
    editor.relayout();
    editor.sync();
    // A late image measurement can move the heading a deep link asked for, so
    // follow it once the flow has settled again.
    if (!returning) {
      scrollToLocationAnchor({ smooth: false });
    } else if (window.scrollY === returnedScrollY) {
      // An older image can acquire its height after Back has restored the
      // paragraph. Keep it in place while the reader is still there.
      const { block, offset } = editor.getSelection().focus;
      if (block === returning.position.block && offset === returning.position.offset) {
        alignReturnCaret(returning.viewportY);
        returnedScrollY = window.scrollY;
      }
    }
  });
  editor.setDocument(blocks);
  state.savedContent = blocksContent(blocks);

  setToolbarEnabled(true);
  els.documentMenuButton.disabled = false;
  els.saveStatus.disabled = false;

  updateEditorPlaceholder();
  hideSaveStatus();
  const params = new URLSearchParams(window.location.search);
  if (restoreLinkOrigin()) {
    returnedScrollY = window.scrollY;
  } else if (!location.hash && params.get("passage") === "1" && params.has("q")) {
    const range = findSearchPassage(blocks, params.get("q"));
    if (range) {
      editor.collapseTo(range.from, { animateCaret: false });
      editor.view.showSearchPassage(range);
    }
  } else {
    scrollToLocationAnchor({ smooth: false });
  }

  if (params.get("new") === "1") {
    window.history.replaceState(null, "", window.location.pathname);
  }
  if (state.draft || params.get("new") === "1") {
    els.documentTitle.focus();
    els.documentTitle.select();
  }
}

// The heading a URL fragment names, decoded from the address bar. A malformed
// escape is no anchor rather than an error.
function locationAnchor() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) {
    return "";
  }
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return "";
  }
}

// Opening /doc/<id>#<anchor> scrolls the heading into view once the document is
// laid out; a hash change in the same page does the same, smoothly.
function scrollToLocationAnchor(options) {
  if (!state.loaded || !editor) {
    return;
  }
  const anchor = locationAnchor();
  if (anchor) {
    editor.goToAnchor(anchor, options);
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

function documentIdFromPath(path = window.location.pathname) {
  const match = path.match(/^\/doc\/([^/]+)\/?$/);
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
  if (state.markdownMode) {
    state.sourceDirty = editor.getDocument() !== state.markdownConversion.blocks;
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
  return cleaned || DEFAULT_TITLE;
}

function normalizeTitleField() {
  if (!state.loaded) {
    return;
  }
  const normalized = normalizeTitle(els.documentTitle.value);
  if (els.documentTitle.value !== normalized) {
    els.documentTitle.value = normalized;
    updateTitleDisplay();
    markDirty();
  }
}

function updateTitleDisplay() {
  const value = els.documentTitle.value;
  els.documentTitle.parentElement.dataset.title = value;
  document.title = (value.trim() || DEFAULT_TITLE) + " - Grapho";
}

function updateEditorPlaceholder() {
  const blocks = editor ? editor.getDocument() : [];
  const hasText = blocks.some((block) => {
    if (block.type === "image" || block.type === "divider") {
      return true;
    }
    return blockText(block).trim().length > 0;
  });
  els.editor.dataset.empty = hasText ? "false" : "true";
}

// The rich blocks this document is made of right now. In Markdown mode the
// editor holds source lines, so saving and exporting parse them back first
// (which is also what keeps the stored JSON in the usual HTML format).
function documentBlocks() {
  if (!editor) {
    return [];
  }
  const blocks = editor.getDocument();
  if (!state.markdownMode) {
    return blocks;
  }
  return state.sourceDirty ? sourceToRich(blocks).blocks : state.richSnapshot.blocks;
}

// The content string the document stores for a set of rich blocks. Empty and
// all-blank documents store "", which is what makes an empty document's
// no-op Markdown toggle compare cleanly against the saved content.
function blocksContent(blocks) {
  const hasContent = blocks.some(
    (block) => block.type === "image" || block.type === "divider" || blockText(block).trim().length > 0,
  );
  return hasContent ? serializeDocument(blocks) : "";
}

function buildPayload() {
  const blocks = documentBlocks();
  const payload = {
    title: normalizeTitle(els.documentTitle.value),
    content: blocksContent(blocks),
    // Zero tells the server to drop a stored width, so a document snapped back
    // to the default follows the stylesheet again.
    paper_width: state.paperWidth || 0,
  };
  return payload;
}

function isEmptyDraft(payload) {
  return state.draft && payload.title === DEFAULT_TITLE && !payload.content;
}

function savePath() {
  return "/api/documents/" + encodeURIComponent(state.documentId) + (state.draft ? "/draft" : "");
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
  if (isEmptyDraft(payload)) {
    state.saveErrorNotified = false;
    hideSaveStatus();
    return Promise.resolve(true);
  }
  state.saving = true;

  state.savePromise = (async () => {
    try {
      const saved = await request(savePath(), {
        method: "PUT",
        body: payload,
      });

      if (state.draft) {
        state.documentId = saved.id;
        state.draft = false;
        history.replaceState(history.state, "", documentLinkHref(saved.id) + location.search + location.hash);
      }
      state.savedContent = payload.content;
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

function handlePageLink(event, beforeLeave) {
  // The link navigates away from the document, so wait until the latest edit
  // is on disk. Modified clicks keep the browser's new-tab behavior.
  const target = event.currentTarget.href;
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
    beforeLeave?.();
    return;
  }

  event.preventDefault();
  flushBeforeLeaving().then((saved) => {
    if (saved) {
      beforeLeave?.();
      window.location.assign(target);
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
  if (isEmptyDraft(payload)) {
    return;
  }
  try {
    fetch(savePath(), {
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
  window.addEventListener("hashchange", () => {
    if (!restoreLinkOrigin()) scrollToLocationAnchor({ smooth: true });
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) restoreLinkOrigin();
  });

  els.documentTitle.addEventListener("input", () => {
    if (!state.loaded) {
      return;
    }
    updateTitleDisplay();
    markDirty();
  });

  els.documentTitle.addEventListener("blur", normalizeTitleField);
  els.documentTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && state.loaded) {
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
    closeMoreFormatting();
    runCommand(button.dataset.command);
  });

  bindFormattingOverflow();
  els.styleButton.addEventListener("click", toggleStyleMenu);
  els.styleMenu.addEventListener("click", handleStyleMenuClick);
  els.styleMenu.addEventListener("keydown", handleStyleMenuKeydown);
  els.formatToolbar.addEventListener("scroll", closeStyleMenu, { passive: true });

  els.editor.addEventListener("click", handleLinkClick);
  els.linkButton.addEventListener("click", () => {
    const link = !state.markdownMode && editor.isCollapsed() && editor.linkAtCaret();
    if (link) {
      showLinkPopover(link.href, els.linkButton, true);
    } else {
      openLinkDialog();
    }
  });
  els.linkEdit.addEventListener("click", () => {
    const fragment = state.linkAnchor;
    if (fragment?.dataset.href && editor.linkAtCaret()?.href !== fragment.dataset.href) {
      // Two adjacent links share a caret offset. Edit the one that was hit.
      editor.collapseTo({ block: editor.getSelection().focus.block, offset: Number(fragment.dataset.end) });
    }
    openLinkDialog();
  });
  els.linkOpen.addEventListener("click", (event) => {
    if (els.linkOpen.origin === location.origin) handlePageLink(event, rememberLinkOrigin);
    closeLinkPopover();
  });
  document.addEventListener("focusin", (event) => {
    if (event.target !== els.docInput && !els.linkPopover.contains(event.target)) closeLinkPopover();
  });
  els.docInput.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.shiftKey && !els.linkPopover.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      els.linkOpen.focus({ preventScroll: true });
    }
  }, true);
  els.linkInput.addEventListener("input", handleLinkInput);
  els.linkInput.addEventListener("keydown", handleLinkInputKeydown);
  els.linkResultsList.addEventListener("mousedown", (event) => event.preventDefault());
  els.linkResultsList.addEventListener("mousemove", handleLinkResultHover);
  els.linkResultsList.addEventListener("click", handleLinkResultClick);
  els.linkDialog.addEventListener("close", () => {
    resetLinkPicker();
    restoreEditorFocus();
  });
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
  window.addEventListener("scroll", closeLinkPopover, { passive: true });
  window.addEventListener("resize", closeLinkPopover);
  window.visualViewport?.addEventListener("resize", () => {
    if (state.linkAnchor) positionBelow(els.linkPopover, state.linkAnchor);
  });
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

  els.backToLibrary.addEventListener("click", handlePageLink);
  els.shortcutsLink.addEventListener("click", handlePageLink);

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
  els.deleteDialog.addEventListener("cancel", (event) => {
    if (state.deleting) {
      event.preventDefault();
    }
  });
  els.deleteDialog.addEventListener("close", restoreEditorFocus);

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
  if (state.markdownMode) {
    runSourceCommand(command);
    editor.focusEditor();
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
  closeLinkPopover();

  const undoButton = els.formatToolbar.querySelector('[data-command="undo"]');
  const redoButton = els.formatToolbar.querySelector('[data-command="redo"]');
  if (undoButton) {
    undoButton.disabled = !info.canUndo;
  }
  if (redoButton) {
    redoButton.disabled = !info.canRedo;
  }

  if (info.image) {
    state.imageEntry = info.image;
  }

  if (state.markdownMode) {
    // The editor reports the plain source block ("p" with no marks); what the
    // toolbar shows is read out of the Markdown syntax at the selection, plus
    // any marks armed for the next typed text.
    const source = inspectSource(editor.getDocument(), editor.getSelection());
    const marks = source.marks || {};
    const pending = editor.getSourcePendingMarks ? editor.getSourcePendingMarks() : null;
    const pressed = (key) => Boolean(marks[key] || (pending && pending[key]));
    setPressed("bold", pressed("b"));
    setPressed("italic", pressed("i"));
    setPressed("underline", pressed("u"));
    setPressed("strikeThrough", pressed("s"));
    setListPressed(source.ordered);
    if (els.linkButton) {
      els.linkButton.setAttribute("aria-pressed", marks.href ? "true" : "false");
      els.linkButton.setAttribute("aria-label", marks.href ? "Edit link" : "Add link");
      els.linkButton.title = (marks.href ? "Edit link" : "Add link") + " (Ctrl+K)";
    }
    updateStyleState(source.style || "p");
    updateAlignState(source.align || "left");
    return;
  }

  const marks = info.marks || {};
  setPressed("bold", Boolean(marks.b));
  setPressed("italic", Boolean(marks.i));
  setPressed("underline", Boolean(marks.u));
  setPressed("strikeThrough", Boolean(marks.s));
  setListPressed(null);

  if (els.linkButton) {
    els.linkButton.setAttribute("aria-pressed", marks.href ? "true" : "false");
    const options = marks.href && info.collapsed;
    els.linkButton.setAttribute("aria-label", options ? "Link options" : "Add link");
    els.linkButton.title = options ? "Link options" : "Add link (Ctrl+K)";
  }

  const type = info.blockType || "p";
  updateStyleState(type);
  updateAlignState(info.alignment || "left");
}

function setListPressed(ordered) {
  const unordered = els.formatToolbar.querySelector('[data-command="insertUnorderedList"]');
  const orderedButton = els.formatToolbar.querySelector('[data-command="insertOrderedList"]');
  if (unordered) {
    unordered.setAttribute("aria-pressed", ordered === false ? "true" : "false");
  }
  if (orderedButton) {
    orderedButton.setAttribute("aria-pressed", ordered === true ? "true" : "false");
  }
}

function setPressed(command, pressed) {
  const button = els.formatToolbar.querySelector('[data-command="' + command + '"]');
  if (button) {
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }
}

function bindFormattingOverflow() {
  // Keep this in sync with the compact toolbar in app.css. Move the controls
  // across the breakpoint so both layouts use the same command and state.
  const compact = window.matchMedia("(max-width: 640px)");
  const controls = Array.from(els.formatToolbar.querySelectorAll("[data-toolbar-overflow]"), (button) => ({
    button,
    parent: button.parentElement,
    next: button.nextElementSibling,
  }));
  const updateLayout = () => {
    closeMoreFormatting();
    closeAlignMenu();
    if (compact.matches) {
      els.moreFormattingMenu.append(...controls.map(({ button }) => button));
    } else {
      for (const { button, parent, next } of [...controls].reverse()) {
        parent.insertBefore(button, next);
      }
    }
  };
  compact.addEventListener("change", updateLayout);
  if (compact.matches) {
    updateLayout();
  }

  els.moreFormattingButton.addEventListener("click", (event) => {
    if (!els.moreFormattingMenu.hidden) {
      closeMoreFormatting(event.detail === 0);
      return;
    }
    closeStyleMenu();
    closeAlignMenu();
    closeImageMenu();
    closeDocumentMenu();
    els.moreFormattingMenu.hidden = false;
    els.moreFormattingButton.setAttribute("aria-expanded", "true");
    // A tap can keep the editor focused, including its on-screen keyboard.
    if (event.detail === 0) {
      els.moreFormattingMenu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    }
  });

  els.formatToolbar.addEventListener("focusout", (event) => {
    const { target, relatedTarget } = event;
    if (
      (target === els.moreFormattingButton || els.moreFormattingMenu.contains(target)) &&
      relatedTarget !== els.moreFormattingButton &&
      !els.moreFormattingMenu.contains(relatedTarget)
    ) {
      closeMoreFormatting();
    }
  });
}

function closeMoreFormatting(restoreFocus) {
  if (els.moreFormattingMenu.hidden) {
    return;
  }
  els.moreFormattingMenu.hidden = true;
  els.moreFormattingButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    els.moreFormattingButton.focus({ preventScroll: true });
  }
}

/* --------------------------------------------------------------------------
   Paragraph style
   -------------------------------------------------------------------------- */

const STYLE_LABELS = {
  p: "Normal text",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
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
  closeMoreFormatting();
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
  positionBelow(els.styleMenu, els.styleButton);
}

function positionBelow(menu, anchor) {
  const anchorRect = anchor.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const viewport = window.visualViewport;
  const leftEdge = viewport?.offsetLeft || 0;
  const topEdge = viewport?.offsetTop || 0;
  const right = leftEdge + (viewport?.width || window.innerWidth);
  const bottom = topEdge + (viewport?.height || window.innerHeight);
  const left = Math.max(leftEdge + margin, Math.min(anchorRect.left, right - menu.offsetWidth - margin));
  const above = anchorRect.bottom + gap + menu.offsetHeight > bottom - margin;
  const top = above ? anchorRect.top - menu.offsetHeight - gap : anchorRect.bottom + gap;
  menu.dataset.side = above ? "above" : "below";
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(Math.max(topEdge + margin, top)) + "px";
}

function handleStyleMenuClick(event) {
  const choice = event.target.closest("[data-block-style]");
  if (!choice) {
    return;
  }
  closeStyleMenu();
  if (state.markdownMode) {
    applySourceCommand(setSourceBlockStyle, choice.dataset.blockStyle);
  } else {
    editor.setBlockType(choice.dataset.blockStyle);
  }
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
   Alignment
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
  els.alignButton.setAttribute("aria-label", "Align: " + ALIGNMENT_LABELS[value]);
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
  closeMoreFormatting();
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
    alignMenuAnchor().focus({ preventScroll: true });
  }
}

function alignMenuAnchor() {
  return els.moreFormattingMenu.contains(els.alignButton) ? els.moreFormattingButton : els.alignButton;
}

function positionAlignMenu() {
  positionBelow(els.alignMenu, alignMenuAnchor());
}

function handleAlignMenuClick(event) {
  const alignChoice = event.target.closest("[data-align-value]");
  if (!alignChoice) {
    return;
  }
  if (state.markdownMode) {
    applySourceCommand(setSourceAlign, alignChoice.dataset.alignValue);
  } else {
    editor.setAlignment(alignChoice.dataset.alignValue);
  }
  closeAlignMenu();
  editor.focusEditor();
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

function handleLinkClick(event) {
  const fragment = event.target.closest(".m-link");
  const modified = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;
  if (!fragment || modified || event.detail > 1 || event.button !== 0 || !editor.isCollapsed()) {
    return;
  }
  showLinkPopover(fragment.dataset.href, fragment, event.pointerType === "touch");
}

function closeLinkPopover() {
  if (!state.linkAnchor) return;
  els.linkPopover.hidden = true;
  state.linkAnchor = null;
}

async function showLinkPopover(href, anchor, focusOpen) {
  // Resolve stored relative and fragment links against this page, just as a
  // normal HTML anchor would. Inspecting an external link never contacts it.
  let url;
  try {
    url = new URL(href, location.href);
  } catch {
    return;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
  const internal = url.origin === location.origin;
  const address = internal ? url.pathname + url.search + url.hash : url.href;
  state.linkAnchor = anchor;
  els.linkOpen.href = url.href;
  els.linkOpen.target = internal || url.protocol === "mailto:" ? "_self" : "_blank";
  els.linkOpen.title = address;
  els.linkDestination.textContent = address;
  els.linkDestination.title = address;
  els.linkPopover.hidden = false;
  positionBelow(els.linkPopover, anchor);
  if (focusOpen) els.linkOpen.focus({ preventScroll: true });

  const id = internal && documentIdFromPath(url.pathname);
  if (!id) return;
  // Read only the title, on demand. A renamed page can have different wording
  // from the selected text. Open and Edit are usable while the title loads.
  try {
    let title = els.documentTitle.value;
    if (id !== state.documentId) {
      const response = await fetch("/api/documents/" + encodeURIComponent(id) + "/title");
      if (!response.ok) return;
      title = await response.json();
    }
    if (state.linkAnchor === anchor && els.linkOpen.href === url.href && title) {
      els.linkDestination.textContent = title + (url.hash ? " " + url.hash : "");
    }
  } catch {
    // The address already shown is also a usable destination.
  }
}

// Native Back can restore scroll before the asynchronously loaded paper has
// any height. Keep the originating caret and its screen position in this entry.
function rememberLinkOrigin() {
  const point = editor.caretGeometry();
  if (!point) return;
  const linkReturn = {
    position: editor.getSelection().focus,
    viewportY: els.editor.getBoundingClientRect().top + point.y,
  };
  history.replaceState({ ...history.state, linkReturn }, "");
}

function restoreLinkOrigin() {
  const origin = history.state?.linkReturn;
  if (!origin || !state.loaded) return false;
  const next = { ...history.state };
  delete next.linkReturn;
  history.replaceState(next, "");
  editor.collapseTo(origin.position, { animateCaret: false });
  alignReturnCaret(origin.viewportY);
  return true;
}

function alignReturnCaret(viewportY) {
  const point = editor.caretGeometry();
  if (point) {
    const top = els.editor.getBoundingClientRect().top + point.y - viewportY;
    window.scrollBy({ top, behavior: "instant" });
  }
}

function openLinkDialog() {
  if (!state.loaded) {
    return;
  }
  closeLinkPopover();
  closeDocumentMenu();
  closeImageMenu();
  closeAlignMenu();
  closeStyleMenu();
  closeMoreFormatting();

  const existing = state.markdownMode
    ? sourceLinkAt(editor.getDocument(), editor.getSelection())
    : editor.linkAtCaret();

  els.linkInput.value = existing ? existing.href : "";
  els.linkTitle.textContent = existing ? "Edit link" : "Add a link";
  els.linkApply.textContent = existing ? "Update link" : "Add link";
  els.linkRemove.hidden = !existing;
  els.linkError.hidden = true;
  resetLinkPicker();

  if (!els.linkDialog.open) {
    els.linkDialog.showModal();
  }
  renderLinkResults();
  window.requestAnimationFrame(() => {
    els.linkInput.focus();
    els.linkInput.select();
  });
  loadLinkDocuments();
}

function closeLinkDialog() {
  if (els.linkDialog.open) {
    els.linkDialog.close();
  }
}

// A link to another Grapho page is stored root-relative, so it keeps working
// on any host or port the library is served from.
function documentLinkHref(id) {
  return "/doc/" + encodeURIComponent(id);
}

function normalizeLink(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  // Root-relative targets are how a Grapho page link is stored, and older
  // documents can carry relative links too; editing one keeps its target.
  if (value.startsWith("/") && !value.startsWith("//")) {
    return /[\s\\\u0000-\u001f\u007f]/.test(value) ? null : value;
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

function insertLink(href, label) {
  const inserting = editor.getSelection().collapsed && els.linkRemove.hidden;
  const applied = state.markdownMode
    ? applySourceCommand(setSourceLink, href, label)
    : editor.setLink(href, label);
  if (inserting && !applied) {
    showLinkError("Place the cursor in a text line to insert a link.");
    return;
  }
  closeLinkDialog();
  editor.focusEditor();
}

function insertPageLink(page) {
  insertLink(documentLinkHref(page.id), page.title);
}

function showLinkError(message) {
  els.linkError.textContent = message;
  els.linkError.hidden = false;
  els.linkInput.focus();
}

function applyLink(event) {
  event.preventDefault();
  if (!state.loaded) {
    return;
  }
  // The primary action follows the row the writer picked (the keyboard can
  // pick one with the arrow keys); with no row picked, the field is the target.
  const picked = linkPicker.visible[linkPicker.selected];
  if (picked) {
    insertPageLink(picked);
    return;
  }
  const address = els.linkInput.value.trim();
  const url = normalizeLink(address);
  if (!url) {
    showLinkError("Enter a web address, or choose a Grapho page.");
    return;
  }
  insertLink(url, address);
}

function removeLink() {
  closeLinkDialog();
  if (state.markdownMode) {
    applySourceCommand(removeSourceLink);
    editor.focusEditor();
    return;
  }
  const hadLink = editor.linkAtCaret();
  if (hadLink) {
    editor.removeLinkAtCaret();
  } else {
    editor.setLink(null);
  }
  editor.focusEditor();
}

/* --------------------------------------------------------------------------
   Link dialog: search over the library
   -------------------------------------------------------------------------- */

// The listing is read when the dialog opens and then filtered locally, so the
// editor makes no request per keystroke. It quietly steps aside when it cannot
// be read: the field still adds a web address.
async function loadLinkDocuments() {
  const requestId = (linkPicker.requestId += 1);
  try {
    const response = await fetch("/api/documents", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (requestId !== linkPicker.requestId) {
      return;
    }
    if (!response.ok) {
      throw new Error("The document listing failed");
    }
    const payload = await response.json();
    if (requestId !== linkPicker.requestId) {
      return;
    }
    linkPicker.documents = Array.isArray(payload.documents) ? payload.documents : [];
  } catch (error) {
    if (requestId !== linkPicker.requestId) {
      return;
    }
    linkPicker.documents = null;
  }
  renderLinkResults();
}

// The dialog is closed (or reopened) while a listing is still arriving: drop
// it instead of painting it into a dialog the writer is no longer looking at.
function resetLinkPicker() {
  linkPicker.requestId += 1;
  linkPicker.visible = [];
  linkPicker.options = [];
  linkPicker.selected = -1;
  els.linkResults.hidden = true;
  els.linkResultsList.replaceChildren();
  els.linkInput.setAttribute("aria-expanded", "false");
  els.linkInput.removeAttribute("aria-activedescendant");
}

function handleLinkInput() {
  els.linkError.hidden = true;
  renderLinkResults();
}

function handleLinkInputKeydown(event) {
  if (event.defaultPrevented || event.isComposing || els.linkResults.hidden) {
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveLinkSelection(event.key === "ArrowDown" ? 1 : -1);
  }
}

function handleLinkResultHover(event) {
  const option = event.target.closest ? event.target.closest(".link-result") : null;
  if (!option) {
    return;
  }
  const index = Number(option.getAttribute("data-index"));
  if (!Number.isFinite(index) || index === linkPicker.selected) {
    return;
  }
  selectLinkResult(index, false);
}

function handleLinkResultClick(event) {
  const option = event.target.closest ? event.target.closest(".link-result") : null;
  if (!option) {
    return;
  }
  const picked = linkPicker.visible[Number(option.getAttribute("data-index"))];
  if (picked) {
    insertPageLink(picked);
  }
}

// A typed web address is not also a search: URLs, mailto targets, and internal
// paths keep the dialog behaving exactly as before the page list existed. The
// scheme must be one the dialog accepts, so a title such as "Q3: planning"
// still searches the library.
function linkInputIsAddress(value) {
  return /^(?:https?|mailto):/i.test(value) || value.startsWith("/") || /^www\./i.test(value);
}

function renderLinkResults() {
  if (!els.linkDialog || !els.linkDialog.open) {
    return;
  }
  linkPicker.selected = -1;
  linkPicker.visible = [];
  linkPicker.options = [];

  const query = els.linkInput.value.trim();
  if (!linkPicker.documents || linkInputIsAddress(query)) {
    hideLinkResults();
    return;
  }

  const { documents, terms } = matchLinkDocuments(query);
  const visible = documents.slice(0, LINK_RESULT_LIMIT);
  if (!visible.length) {
    hideLinkResults();
    return;
  }

  const fragment = document.createDocumentFragment();
  const options = [];
  visible.forEach((documentSummary, index) => {
    const option = createLinkResult(documentSummary, index, terms);
    options.push(option);
    fragment.appendChild(option);
  });
  els.linkResultsList.replaceChildren(fragment);
  els.linkResultsLabel.textContent = query ? "Documents" : "Recent documents";
  els.linkResults.hidden = false;
  els.linkInput.setAttribute("aria-expanded", "true");
  linkPicker.visible = visible;
  linkPicker.options = options;
  // Typing narrows the list to a search, so the best match is offered as the
  // Enter target. The recent list itself starts with nothing picked: opening
  // the dialog and pressing Enter must not link the latest document by accident.
  if (query) {
    selectLinkResult(0, false);
  }
}

function hideLinkResults() {
  els.linkResults.hidden = true;
  els.linkResultsList.replaceChildren();
  els.linkInput.setAttribute("aria-expanded", "false");
  els.linkInput.removeAttribute("aria-activedescendant");
  linkPicker.visible = [];
  linkPicker.options = [];
  linkPicker.selected = -1;
}

function matchLinkDocuments(query) {
  const terms = linkSearchTerms(query);
  const documents = (linkPicker.documents || []).filter(
    (documentSummary) => documentSummary.id !== state.documentId,
  );
  if (!terms.length) {
    return { documents: documents.sort(compareLinkDocuments), terms };
  }

  const matches = [];
  for (const documentSummary of documents) {
    const title = String(documentSummary.title || "").toLocaleLowerCase();
    let score = 0;
    let matched = true;
    for (const term of terms) {
      const at = title.indexOf(term);
      if (at === -1) {
        matched = false;
        break;
      }
      if (at > 0) {
        score += linkStartsWord(title, at) ? 1 : 2;
      }
    }
    if (matched) {
      matches.push({ document: documentSummary, score });
    }
  }
  matches.sort(
    (left, right) =>
      left.score - right.score || compareLinkDocuments(left.document, right.document),
  );
  return {
    documents: matches.map((match) => match.document),
    terms,
  };
}

function compareLinkDocuments(left, right) {
  return (
    right.updated_at - left.updated_at ||
    String(left.title).localeCompare(String(right.title))
  );
}

function linkSearchTerms(query) {
  const seen = Object.create(null);
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => {
      if (!term || seen[term]) {
        return false;
      }
      seen[term] = true;
      return true;
    })
    .sort((left, right) => right.length - left.length);
}

function linkStartsWord(title, index) {
  return !/[\p{L}\p{N}]/u.test(title.charAt(index - 1));
}

function createLinkResult(documentSummary, index, terms) {
  const option = document.createElement("li");
  option.className = "link-result";
  option.id = "linkResultOption" + index;
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", "false");
  option.setAttribute("data-index", String(index));

  const glyph = document.createElement("span");
  glyph.className = "link-result-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = LINK_PAGE_ICON;

  const title = document.createElement("span");
  title.className = "link-result-title";
  const label = String(documentSummary.title || "Untitled document");
  appendLinkHighlight(title, label, terms);
  title.title = label;

  const meta = document.createElement("span");
  meta.className = "link-result-meta";
  meta.textContent = linkEditedLabel(documentSummary.updated_at);

  option.appendChild(glyph);
  option.appendChild(title);
  option.appendChild(meta);
  return option;
}

function appendLinkHighlight(container, text, terms) {
  if (!terms.length) {
    container.appendChild(document.createTextNode(text));
    return;
  }

  const pattern = new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi",
  );
  let position = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > position) {
      container.appendChild(document.createTextNode(text.slice(position, match.index)));
    }
    const mark = document.createElement("mark");
    mark.className = "link-result-match";
    mark.textContent = match[0];
    container.appendChild(mark);
    position = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (position < text.length) {
    container.appendChild(document.createTextNode(text.slice(position)));
  }
}

function linkEditedLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return "Edited today";
  }
  const formatter = date.getFullYear() === today.getFullYear() ? linkShortDate : linkLongDate;
  return "Edited " + formatter.format(date);
}

function selectLinkResult(index, scroll) {
  if (index < 0 || index >= linkPicker.options.length) {
    return;
  }
  linkPicker.selected = index;
  linkPicker.options.forEach((option, optionIndex) => {
    option.setAttribute("aria-selected", optionIndex === index ? "true" : "false");
  });
  const selected = linkPicker.options[index];
  els.linkInput.setAttribute("aria-activedescendant", selected.id);
  if (scroll) {
    revealLinkResult(selected);
  }
}

function revealLinkResult(option) {
  const listBox = els.linkResultsList.getBoundingClientRect();
  const optionBox = option.getBoundingClientRect();
  if (optionBox.top < listBox.top) {
    els.linkResultsList.scrollTop -= listBox.top - optionBox.top;
  } else if (optionBox.bottom > listBox.bottom) {
    els.linkResultsList.scrollTop += optionBox.bottom - listBox.bottom;
  }
}

function moveLinkSelection(delta) {
  const count = linkPicker.options.length;
  if (!count) {
    return;
  }
  const start = linkPicker.selected < 0 ? (delta > 0 ? -1 : 0) : linkPicker.selected;
  selectLinkResult((((start + delta) % count) + count) % count, true);
}

/* --------------------------------------------------------------------------
   Images
   -------------------------------------------------------------------------- */

function openImagePicker() {
  if (!state.loaded) {
    return;
  }
  if (!els.moreFormattingMenu.hidden) {
    closeMoreFormatting();
    editor.focusEditor();
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
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) {
    throw new Error("Use a PNG, JPEG, WebP, GIF, or AVIF image.");
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
  let above = true;
  if (top < margin) {
    top = Math.min(imageBottom + gap, window.innerHeight - menuRect.height - margin);
    top = Math.max(margin, top);
    above = false;
  }

  // The image menu is usually above the picture; animate it out of the side it
  // actually landed on.
  els.imageMenu.dataset.side = above ? "above" : "below";
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

  if (button.dataset.imageAction === "download") {
    // The menu closes on a whole-image action; keep the picture's data before
    // that clears the entry the menu works from.
    const block = state.imageEntry.block;
    closeImageMenu();
    downloadImage(block);
    editor.focusEditor();
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
    // rendered width holds a resized image at the size it was scaled to. A flip
    // only mirrors the pixels, so its stored width has to stay exactly as it was.
    const displayWidth =
      image.turned && Number.isFinite(block.displayWidth) && entry.image
        ? Math.max(48, Math.round(entry.image.height))
        : block.displayWidth;

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
  // The download reads the stored data URL, so it waits with the transform
  // buttons rather than handing over the pixels the transform is replacing.
  els.imageMenu
    .querySelectorAll('[data-image-transform], [data-image-action="download"]')
    .forEach((button) => {
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

function downloadImage(block) {
  const src = String((block && block.src) || "");
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,(.*)$/.exec(src);
  if (!match) {
    showToast("That image can't be downloaded.", true);
    return;
  }

  const type = match[1];
  let bytes;
  try {
    // The stored data URL is the image itself; hand its bytes over untouched,
    // not a render or a fresh encode of the picture on the page.
    const binary = window.atob(match[2]);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch (error) {
    showToast("That image can't be downloaded.", true);
    return;
  }

  const name = imageDownloadName(block) + "." + IMAGE_DOWNLOAD_EXTENSIONS[type];
  downloadBlob(name, new Blob([bytes], { type }));
  showToast("Image download started.");
}

function imageDownloadName(block) {
  // The alt text starts life as the file's own name, so it is the closest thing
  // to the name the picture came in with. A missing or generic one falls back to
  // the document's title.
  const alt = String((block && block.alt) || "").trim();
  if (alt && !/^image$/i.test(alt)) {
    return slugify(alt);
  }
  return slugify(normalizeTitle(els.documentTitle.value));
}

function handleDocumentPointer(event) {
  if (!els.linkPopover.hidden && !els.linkPopover.contains(event.target)) closeLinkPopover();
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
  if (!els.moreFormattingMenu.contains(event.target) && !els.moreFormattingButton.contains(event.target)) {
    closeMoreFormatting();
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
  // A heading is the only thing with an address to copy, so the item only
  // exists while the caret is in one.
  els.copyHeadingLink.hidden = !editor.headingAnchor();
  els.documentMenu.hidden = false;
  els.documentMenuButton.setAttribute("aria-expanded", "true");
  closeAlignMenu();
  closeImageMenu();
  closeStyleMenu();
  closeMoreFormatting();
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
    case "copy-heading-link":
      copyHeadingLink();
      break;
    case "focus":
      toggleFocusMode();
      break;
    case "markdown":
      toggleMarkdownMode();
      break;
    case "delete":
      openDeleteDialog();
      break;
    default:
      break;
  }
}

// A heading's deep link. The fragment is the anchor the editor derives from the
// heading text, so the stored document format stays untouched.
function headingAnchorLink(anchor) {
  return (
    window.location.origin +
    "/doc/" +
    encodeURIComponent(state.documentId) +
    "#" +
    encodeURIComponent(anchor)
  );
}

// The clipboard API needs a secure context, and a library served from a plain
// http:// address on the network is not one. The old selection-and-copy path
// still works there, and it cannot disturb a document selection: the field it
// selects is its own.
function copyTextFallback(text) {
  const field = document.createElement("textarea");
  field.className = "clipboard-fallback";
  field.value = text;
  field.setAttribute("readonly", "");
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  field.remove();
  return copied;
}

async function copyHeadingLink() {
  const anchor = editor.headingAnchor();
  if (!anchor) {
    return;
  }
  if (state.draft && (!(await flushBeforeLeaving()) || state.draft)) {
    return;
  }
  const link = headingAnchorLink(anchor);
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch (error) {
    copied = copyTextFallback(link);
  }
  showToast(copied ? "Link to this heading copied." : "That link couldn't be copied.", !copied);
  editor.focusEditor();
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
  closeMoreFormatting();
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

/* --------------------------------------------------------------------------
   Markdown mode
   -------------------------------------------------------------------------- */

function toggleMarkdownMode() {
  if (state.markdownMode) {
    exitMarkdownMode();
  } else {
    enterMarkdownMode();
  }
}

function enterMarkdownMode() {
  if (state.markdownMode || !state.loaded) {
    return;
  }
  closeDocumentMenu();
  closeStyleMenu();
  closeAlignMenu();
  closeImageMenu();
  closeMoreFormatting();

  const richBlocks = editor.getDocument();
  const selection = editor.getSelection();
  // The conversion also carries the caret both ways, so switching the view
  // does not throw the writing position away.
  const conversion = richToSource(richBlocks);
  state.richSnapshot = { blocks: richBlocks, anchor: selection.anchor, focus: selection.focus };
  state.richHistory = editor.getHistory();
  state.markdownConversion = conversion;
  state.markdownMode = true;
  state.sourceDirty = false;
  document.body.classList.add("is-markdown-mode");
  updateMarkdownMenuItem();
  editor.setSourceMode(true);
  editor.setDocument(conversion.blocks, {
    anchor: mapRichCaretToSource(conversion, selection.anchor),
    focus: mapRichCaretToSource(conversion, selection.focus),
  });
  editor.focusEditor();
  updateEditorPlaceholder();
}

function exitMarkdownMode() {
  if (!state.markdownMode) {
    return;
  }

  const sourceBlocks = editor.getDocument();
  const sourceSelection = editor.getSelection();
  const snapshot = state.richSnapshot;
  const history = state.richHistory;
  let richBlocks = snapshot.blocks;
  let conversion = state.markdownConversion;
  let undoFrom;

  // With no source edits, put the exact rich blocks back; that makes a toggle
  // that changed nothing a true no-op, even if a parser normalization would
  // have altered the markup. With edits, the source is the document now.
  if (state.sourceDirty) {
    conversion = sourceToRich(sourceBlocks);
    if (serializeDocument(conversion.blocks) !== serializeDocument(snapshot.blocks)) {
      richBlocks = conversion.blocks;
      undoFrom = snapshot;
    }
  }
  const selection = {
    anchor: mapSourceCaretToRich(conversion, sourceSelection.anchor),
    focus: mapSourceCaretToRich(conversion, sourceSelection.focus),
  };

  state.markdownMode = false;
  state.sourceDirty = false;
  state.richSnapshot = null;
  state.richHistory = null;
  state.markdownConversion = null;
  document.body.classList.remove("is-markdown-mode");
  updateMarkdownMenuItem();
  editor.setSourceMode(false);
  editor.setDocument(richBlocks, selection, { history, undoFrom });
  editor.focusEditor();
  updateEditorPlaceholder();

  // A save made while the mode was on already stored the parsed form of the
  // change. If what the editor shows now is not what the server last saw
  // (unsaved edits from before the toggle, or a change not saved yet), save.
  const html = blocksContent(editor.getDocument());
  if (html !== state.savedContent) {
    state.dirty = true;
  }
  if (state.dirty) {
    scheduleSave(300);
  }
}

function updateMarkdownMenuItem() {
  if (els.markdownMenuItemLabel) {
    els.markdownMenuItemLabel.textContent = state.markdownMode ? "Exit Markdown mode" : "Markdown mode";
  }
}

function handleSourceFormat(key) {
  if (!state.markdownMode) {
    return;
  }
  runSourceMark(key);
  editor.focusEditor();
}

// A collapsed mark toggle cannot insert its markers immediately: an empty
// "****" pair would be parsed and stored as literal text. Instead it arms the
// next typed text, exactly like the rich editor's pending marks.
function runSourceMark(key) {
  const result = setSourceMark(editor.getDocument(), editor.getSelection(), key);
  if (result && result.pending) {
    toggleSourcePendingMark(key);
    return;
  }
  if (result && result.blocks) {
    editor.commit(result.blocks, result.anchor, result.focus);
  }
}

function toggleSourcePendingMark(key) {
  const pending = { ...(editor.getSourcePendingMarks() || {}) };
  if (pending[key]) {
    delete pending[key];
  } else {
    pending[key] = true;
  }
  editor.setSourcePendingMarks(pending);
  editor.sync();
}

// Called by the editor when text is typed with pending marks armed in Markdown
// mode: the text arrives already wrapped in canonical markers.
function wrapSourceTypedText(text, marks) {
  return wrapInlineText(text, marks);
}

// Toolbar actions in Markdown mode edit the source lines directly. The action
// returns the blocks and selection to commit, or null when it did nothing.
function applySourceCommand(action, ...args) {
  if (!state.markdownMode) {
    return false;
  }
  const result = action(editor.getDocument(), editor.getSelection(), ...args);
  if (!result) {
    return false;
  }
  editor.commit(result.blocks, result.anchor, result.focus);
  return true;
}

function runSourceCommand(command) {
  switch (command) {
    case "undo":
      editor.undo();
      break;
    case "redo":
      editor.redo();
      break;
    case "bold":
      runSourceMark("b");
      break;
    case "italic":
      runSourceMark("i");
      break;
    case "underline":
      runSourceMark("u");
      break;
    case "strikeThrough":
      runSourceMark("s");
      break;
    case "insertUnorderedList":
      applySourceCommand(toggleSourceList, false);
      break;
    case "insertOrderedList":
      applySourceCommand(toggleSourceList, true);
      break;
    case "removeFormat":
      applySourceCommand(clearSourceFormatting);
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
  const blocks = documentBlocks();
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
    // Tab indents a selected line by putting spaces in the text, and a normal
    // HTML paragraph collapses them away. Keep the indentation visible.
    "p,h1,h2,h3,blockquote{white-space:pre-wrap;}",
    "pre{padding:16px;background:#f1ece1;border-radius:8px;white-space:pre-wrap;",
    "font-family:ui-monospace,Consolas,monospace;font-size:.8em;}",
    "code{font-family:ui-monospace,Consolas,monospace;font-size:.84em;}",
    "hr{border:0;height:1px;background:#d3cbbb;margin:2em 0;}",
    "img{display:block;max-width:100%;height:auto;margin:1.6em auto;}",
    "img.wrap-left{float:left;max-width:42%;margin:.35em 1.35em 0 0;}",
    "img.wrap-right{float:right;max-width:42%;margin:.35em 0 0 1.35em;}",
    ...radiusRules,
    "h2,h3,blockquote,pre{clear:both;}",
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
  const blocks = documentBlocks();
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
    const pdf = await buildPdf(documentBlocks(), title);
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
  const blocks = documentBlocks();
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
    if (block.type === "divider") {
      parts.push("---");
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
    if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
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
  downloadBlob(filename, new Blob([content], { type }));
}

function downloadBlob(filename, blob) {
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

// Both dialogs are opened from the editor, so closing one has to leave the
// writer writing. The browser's own focus restoration is not enough: closing
// from a click on one of the dialog's own buttons can drop focus on the page
// body, or leave the editor's hidden textarea active but ignoring typed text,
// and the browser may finish that after the dialog's own close event. One task
// later the page has settled, so the editor takes its place back. Focus is
// only taken from those two places: a control the writer picked (the title
// field, a menu) keeps it.
function restoreEditorFocus() {
  if (!state.loaded) {
    return;
  }
  window.setTimeout(() => {
    if (!state.loaded || els.linkDialog.open || els.deleteDialog.open) {
      return;
    }
    if (document.activeElement !== document.body && document.activeElement !== editor.textarea) {
      return;
    }
    editor.focusEditor();
  }, 0);
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
    if (!(await flushBeforeLeaving())) {
      showToast("Your latest changes couldn't be saved. Try again before deleting.", true);
      return;
    }
    if (!state.draft) {
      await request("/api/documents/" + encodeURIComponent(state.documentId), { method: "DELETE" });
    }
    state.loaded = false;
    state.dirty = false;
    window.location.assign("/");
  } catch (error) {
    showToast(error.userMessage || "That document couldn't be deleted.", true);
  } finally {
    if (state.loaded) {
      state.deleting = false;
      els.deleteConfirm.disabled = false;
      els.deleteCancel.disabled = false;
      els.deleteConfirm.textContent = "Delete";
    }
  }
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    if (!els.linkPopover.hidden) {
      event.preventDefault();
      closeLinkPopover();
      editor.focusEditor();
      return;
    }
    if (!els.moreFormattingMenu.hidden) {
      event.preventDefault();
      closeMoreFormatting(els.moreFormattingMenu.contains(document.activeElement));
      return;
    }
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

  // Ctrl+Shift+F toggles focus mode, the same as the document menu item. It is
  // Ctrl-only rather than Ctrl-or-Cmd so the binding is the same on macOS as
  // everywhere else. Repeated keydowns from a held key must not flip the mode
  // back and forth, an open dialog owns the keyboard until it closes, and a
  // picture gesture in flight is not interrupted by hiding its toolbar.
  if (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase() === "f") {
    event.preventDefault();
    if (event.repeat || event.isComposing) {
      return;
    }
    if (editor.imageDrag || editor.imageResize) {
      return;
    }
    if (!els.linkDialog.open && !els.deleteDialog.open) {
      toggleFocusMode();
    }
    return;
  }

  // Ctrl+Shift+M switches between the Markdown source and the normal rendered
  // view, the same as the document menu item. It is deliberately Ctrl-only
  // rather than Ctrl-or-Cmd, so the binding is the same on macOS as everywhere
  // else; plain Ctrl+M stays unbound. Repeated keydowns from a held key must not
  // flip the view back and forth, an open dialog owns the keyboard until it
  // closes, and a picture gesture in flight is not interrupted by rebuilding
  // the view under it.
  if (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase() === "m") {
    event.preventDefault();
    if (event.repeat || event.isComposing) {
      return;
    }
    if (editor.imageDrag || editor.imageResize) {
      return;
    }
    if (!els.linkDialog.open && !els.deleteDialog.open) {
      toggleMarkdownMode();
    }
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
