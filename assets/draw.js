import { createDrawingTools } from "./draw-tools.js";
import { createDrawingStyle } from "./draw-style.js";
import { prepareClipboardImage, prepareImage } from "./doc/image.js";

const DEFAULT_TITLE = "Untitled drawing";
const DEFAULT_BACKGROUND = { pattern: "dots", color: null, patternColor: null };
const SCENE_VERSION = 12;
const MAX_DRAWING_REQUEST = 24 * 1024 * 1024; // Match the API body limit.
const HISTORY_LIMIT = 100;
const library = document.getElementById("drawingLibraryLink");
const titleInput = document.getElementById("drawingTitle");
const canvas = document.getElementById("drawingCanvas");
const ink = document.getElementById("drawingInk");
const undo = document.getElementById("drawingUndo");
const redo = document.getElementById("drawingRedo");
const status = document.getElementById("drawingStatus");
const errorNotice = document.getElementById("drawingError");
const errorMessage = document.getElementById("drawingErrorMessage");
const toolbar = document.getElementById("drawingToolbar");
const toolButtons = [...toolbar.querySelectorAll("[data-draw-tool]")];
const addImageButton = document.getElementById("drawingAddImage");
const imageInput = document.getElementById("drawingImageInput");
const imageError = document.getElementById("drawingImageError");
const moreButton = document.getElementById("drawingMore");
const moreMenu = document.getElementById("drawingMoreMenu");
const actionButtons = [...moreMenu.querySelectorAll("[data-draw-action]")];
const backgroundDialog = document.getElementById("drawingBackgroundDialog");
const backgroundForm = backgroundDialog.querySelector("form");
const backgroundOptions = backgroundForm.elements.namedItem("background");
const backgroundColor = backgroundForm.elements.namedItem("color");
const patternColor = backgroundForm.elements.namedItem("patternColor");
const toolbarButtons = [...toolbar.querySelectorAll("[data-draw-tool], #drawingAddImage, #drawingMore")];
const id = location.pathname.split("/").at(-1);
const endpoint = "/api/documents/" + encodeURIComponent(id) + "/drawing";
const params = new URLSearchParams(location.search);
const space = params.get("space");
const query = params.get("q");
const libraryParams = new URLSearchParams();
if (space) libraryParams.set("space", space);
if (query) {
  libraryParams.set("q", query);
  libraryParams.set("from", id);
}
if (libraryParams.size) library.search = libraryParams.toString();

let isDraft = location.pathname.startsWith("/draw/new/");
let loaded = false;
let title = DEFAULT_TITLE;
let elements = [];
let background = DEFAULT_BACKGROUND;
let backgroundDraft;
const undoHistory = [];
const redoHistory = [];
let savedTitle = DEFAULT_TITLE;
let savedElements = [];
let savedBackground = DEFAULT_BACKGROUND;
let savePromise = null;
let imageImport = null;
let saveTimer;

const tools = createDrawingTools({
  canvas, ink,
  getElements: () => elements,
  commit: commitEdit,
  isReady: () => loaded,
  styleFor: type => shapeStyle.styleFor(type),
  onContextChange: updateControls,
  onDraftChange: () => {
    syncUnloadGuard();
    updateSaveStatus();
  },
});
const shapeStyle = createDrawingStyle({
  ink, getTool: tools.getTool, getElements: () => elements, selectedElements: tools.selectedElements, commit: commitEdit,
  updatePreview: tools.paintLinePreview,
  getEditingText: tools.getEditingText,
  setEditingTextStyle: tools.setEditingTextStyle,
});

titleInput.addEventListener("input", () => {
  title = titleInput.value.trim().replace(/\s+/g, " ") || DEFAULT_TITLE;
  updatePageTitle();
  queueSave();
});
titleInput.addEventListener("blur", () => { titleInput.value = title; });
titleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) titleInput.blur();
});

undo.addEventListener("click", () => changeHistory(false));
redo.addEventListener("click", () => changeHistory(true));
for (const button of toolButtons) {
  button.addEventListener("click", () => activateTool(button.dataset.drawTool));
}

addImageButton.addEventListener("click", () => {
  imageError.hidden = true;
  imageInput.click();
});
imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  importImage(file);
});

canvas.addEventListener("dragover", event => {
  const transfer = event.dataTransfer;
  if (!transfer?.types.includes("Files")) return;
  event.preventDefault();
  transfer.dropEffect = loaded && !imageImport ? "copy" : "none";
});
canvas.addEventListener("drop", event => {
  const transfer = event.dataTransfer;
  if (!transfer?.types.includes("Files")) return;
  event.preventDefault();
  if (!loaded || imageImport) return;
  if (transfer.files.length > 1) {
    showImageError("Drop one image at a time.");
    return;
  }
  importImage(transfer.files[0], tools.imagePlacement(event));
});

document.addEventListener("copy", event => {
  if (!acceptsDrawingCommand(event) || !event.clipboardData || document.getSelection()?.isCollapsed === false) return;
  const selected = tools.selectedElements();
  if (selected.length !== 1 || selected[0].type !== "image") return;
  const image = document.createElement("img");
  image.src = selected[0].src;
  image.alt = selected[0].alt;
  event.clipboardData.setData("text/html", image.outerHTML);
  event.preventDefault();
});

document.addEventListener("paste", event => {
  if (!acceptsDrawingCommand(event) || !event.clipboardData || imageImport) return;
  const image = prepareClipboardImage(event.clipboardData);
  if (!image) return;
  event.preventDefault();
  importPreparedImage(image);
});

function importImage(file, placement) {
  if (!file || !loaded || imageImport) return;
  importPreparedImage(prepareImage(file), placement);
}

async function importPreparedImage(preparation, placement) {
  imageError.hidden = true;
  imageImport = preparation.then(image => {
    activateTool("select");
    tools.addImage(image, placement);
  }).catch(error => {
    showImageError(error.message);
  });
  syncUnloadGuard();
  updateControls();
  updateSaveStatus();
  await imageImport;
  imageImport = null;
  syncUnloadGuard();
  updateControls();
  updateSaveStatus();
}

function showImageError(message) {
  imageError.textContent = message;
  imageError.hidden = false;
}

function activateTool(name) {
  if (!loaded) return;
  tools.setTool(name);
  shapeStyle.update();
  for (const button of toolButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.drawTool === name));
  }
  closeMenu();
}

function runAction(action) {
  if (action === "select-all") {
    activateTool("select");
    tools.selectAll();
  } else if (action === "duplicate") {
    tools.duplicateSelection();
  } else if (action === "delete") {
    tools.removeSelection();
  } else if (action === "background") {
    backgroundDraft = { ...background };
    backgroundOptions.value = background.pattern;
    updateBackgroundColorFields();
    backgroundDialog.showModal();
    backgroundDialog.querySelector("input:checked").focus();
  }
}

function closeMenu() {
  moreMenu.hidden = true;
  moreButton.setAttribute("aria-expanded", "false");
}

function openMenu() {
  moreMenu.hidden = false;
  moreButton.setAttribute("aria-expanded", "true");
  actionButtons.find(button => !button.disabled)?.focus();
}

moreButton.addEventListener("click", () => {
  if (moreMenu.hidden) openMenu();
  else closeMenu();
});
for (const button of actionButtons) {
  button.addEventListener("click", () => {
    closeMenu();
    moreButton.focus({ preventScroll: true });
    runAction(button.dataset.drawAction);
  });
}
document.getElementById("drawingBackgroundCancel").addEventListener("click", () => backgroundDialog.close());
document.getElementById("drawingBackgroundResetColors").addEventListener("click", () => {
  backgroundDraft.color = null;
  backgroundDraft.patternColor = null;
  updateBackgroundColorFields();
});
for (const input of [backgroundColor, patternColor]) {
  input.addEventListener("input", () => {
    backgroundDraft[input.name] = input.value;
    renderBackgroundColors(backgroundDialog, backgroundDraft);
  });
}
backgroundForm.addEventListener("submit", () => {
  const next = { ...backgroundDraft, pattern: backgroundOptions.value };
  if (sameBackground(next, background)) return;
  recordEdit({ background: true, before: background, after: next });
  applyBackground(next);
});
document.addEventListener("pointerdown", event => {
  if (!moreMenu.contains(event.target) && !moreButton.contains(event.target)) closeMenu();
});
toolbar.addEventListener("focusout", event => {
  if (!toolbar.contains(event.relatedTarget)) closeMenu();
});
toolbar.addEventListener("focusin", event => {
  if (toolbarButtons.includes(event.target)) setToolbarTabStop(event.target);
});
function setToolbarTabStop(target) {
  for (const button of toolbarButtons) button.tabIndex = button === target ? 0 : -1;
}

toolbar.addEventListener("keydown", event => {
  const inMenu = !moreMenu.hidden;
  if (event.key === "Escape" && inMenu) {
    event.preventDefault();
    closeMenu();
    moreButton.focus();
    return;
  }
  if (event.key === "ArrowDown" && event.target === moreButton && !inMenu) {
    event.preventDefault();
    openMenu();
    return;
  }
  const buttons = (inMenu ? actionButtons : toolbarButtons).filter(button => !button.disabled);
  const index = buttons.indexOf(event.target);
  if (index < 0) return;
  const direction = inMenu ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  let next;
  if (event.key === direction[0]) next = (index + buttons.length - 1) % buttons.length;
  else if (event.key === direction[1]) next = (index + 1) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else return;
  event.preventDefault();
  buttons[next].focus();
});

function acceptsDrawingCommand(event) {
  return loaded && !event.defaultPrevented
    && !event.target.closest?.("input, textarea, select, [contenteditable=true]") && !document.querySelector("dialog[open]");
}

document.addEventListener("keydown", (event) => {
  if (!acceptsDrawingCommand(event) || event.isComposing || event.altKey || !moreMenu.hidden) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "z" || (key === "y" && !event.shiftKey)) {
      event.preventDefault();
      changeHistory(key === "y" || event.shiftKey);
    } else if (!event.shiftKey && (key === "a" || (key === "d" && tools.hasSelection()))) {
      event.preventDefault();
      runAction(key === "a" ? "select-all" : "duplicate");
    }
    return;
  }
  if (event.shiftKey) return;
  if (key === "enter" && !event.target.closest?.("button, a") && tools.finishLine()) {
    event.preventDefault();
    return;
  }
  const button = toolbarButtons.find(button => button.getAttribute("aria-keyshortcuts")?.toLowerCase() === key);
  if (button) {
    event.preventDefault();
    if (button !== addImageButton || !event.repeat) button.click();
  } else if (key === "escape") {
    event.preventDefault();
    tools.cancel();
    activateTool("select");
    tools.clearSelection();
  } else if ((key === "delete" || key === "backspace") && tools.hasSelection()) {
    event.preventDefault();
    tools.removeSelection();
  }
});

document.getElementById("drawingRetry").addEventListener("click", () => {
  if (loaded) saveDrawing();
  else loadDrawing();
});

library.addEventListener("click", async (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  tools.finishText();
  tools.finishLine();
  if (!imageImport && !savePromise && !hasChanges()) return;
  event.preventDefault();
  await imageImport;
  while (savePromise || hasChanges()) {
    if (!await saveDrawing()) return;
  }
  location.assign(library.href);
});

loadDrawing();

function commitEdit(next) {
  // Unchanged elements keep their identity. A pencil stroke typically adds
  // just one reference to history, regardless of the number of earlier strokes.
  let start = 0;
  while (start < elements.length && start < next.length && elements[start] === next[start]) start++;
  if (start === elements.length && start === next.length) return false;
  let end = elements.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && elements[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const before = elements.slice(start, end);
  const after = next.slice(start, nextEnd);
  if (after.some(element => element.type === "image")) {
    const oldIds = new Set(before.map(({ id }) => id));
    if (after.some(element => element.type === "image" && !oldIds.has(element.id))) {
      const payload = JSON.stringify(drawingSnapshot(next));
      if (new Blob([payload]).size > MAX_DRAWING_REQUEST) {
        showImageError("This drawing is too large to add another image.");
        return false;
      }
      imageError.hidden = true;
    }
  }
  recordEdit({ start, before, after });
  applyScene(next);
  return true;
}

function recordEdit(edit) {
  undoHistory.push(edit);
  if (undoHistory.length > HISTORY_LIMIT) undoHistory.shift();
  redoHistory.length = 0;
}

function changeHistory(forward) {
  if (tools.cancel()) return;
  const edit = (forward ? redoHistory : undoHistory).pop();
  if (!edit) return;
  (forward ? undoHistory : redoHistory).push(edit);
  if (edit.background) {
    applyBackground(forward ? edit.after : edit.before);
    return;
  }
  const remove = forward ? edit.before : edit.after;
  const insert = forward ? edit.after : edit.before;
  applyScene(elements.slice(0, edit.start).concat(insert, elements.slice(edit.start + remove.length)), true);
}

function applyBackground(next) {
  background = next;
  renderBackground();
  updateControls();
  queueSave();
}

function renderBackground() {
  canvas.dataset.background = background.pattern;
  renderBackgroundColors(canvas.parentElement, background);
}

function renderBackgroundColors(target, { color, patternColor }) {
  target.style.setProperty("--drawing-background-color", color ?? "");
  target.style.setProperty("--drawing-pattern-color", patternColor ?? "");
}

function updateBackgroundColorFields() {
  const theme = getComputedStyle(document.documentElement);
  backgroundColor.value = backgroundDraft.color ?? theme.getPropertyValue("--paper").trim();
  patternColor.value = backgroundDraft.patternColor ?? theme.getPropertyValue("--line-strong").trim();
  renderBackgroundColors(backgroundDialog, backgroundDraft);
}

function sameBackground(first, second) {
  return first.pattern === second.pattern && first.color === second.color && first.patternColor === second.patternColor;
}

function applyScene(next, fitViewport = false) {
  elements = next;
  if (fitViewport) tools.fitViewport(true);
  tools.render();
  updateControls();
  queueSave();
}

function updateControls() {
  shapeStyle.update();
  undo.disabled = !undoHistory.length;
  redo.disabled = !redoHistory.length;
  moreButton.disabled = !loaded;
  addImageButton.disabled = !loaded || Boolean(imageImport);
  if ((moreButton.disabled && moreButton.tabIndex === 0) ||
      (addImageButton.disabled && addImageButton.tabIndex === 0)) {
    setToolbarTabStop(toolButtons.find(button => button.getAttribute("aria-pressed") === "true"));
  }
  for (const button of toolButtons) button.disabled = !loaded;
  for (const button of actionButtons) {
    const action = button.dataset.drawAction;
    button.disabled = !loaded || (action === "select-all"
      ? !elements.length
      : action !== "background" && !tools.hasSelection());
  }
}

async function loadDrawing() {
  showError("");
  updateControls();
  try {
    if (!isDraft) {
      const drawing = await requestDrawing(endpoint + "?scene=true&version=" + SCENE_VERSION);
      title = savedTitle = drawing.title;
      elements = drawing.elements;
      savedElements = elements;
      background = savedBackground = {
        pattern: drawing.background ?? DEFAULT_BACKGROUND.pattern,
        color: drawing.background_color?.toLowerCase() ?? null,
        patternColor: drawing.pattern_color?.toLowerCase() ?? null,
      };
      // Pencil-only drawings have always allowed undoing strokes after reopening.
      // In a mixed scene, stacking order cannot reconstruct its edit history.
      if (elements.every(element => element.type === "pencil")) {
        const first = Math.max(0, elements.length - HISTORY_LIMIT);
        for (let i = first; i < elements.length; i++) {
          undoHistory.push({ start: i, before: [], after: [elements[i]] });
        }
      }
      status.textContent = "Saved";
    }
    renderBackground();
    titleInput.disabled = false;
    titleInput.value = title;
    updatePageTitle();
    loaded = true;
    tools.fitViewport();
    tools.render();
    updateControls();
    setToolbarTabStop(toolButtons.find(button => button.getAttribute("aria-pressed") === "true"));
  } catch (error) {
    showError(error.message);
  } finally {
    document.getElementById("drawingMain").removeAttribute("aria-busy");
  }
}

function updatePageTitle() {
  document.title = title + " - Grapho";
}

function hasChanges() {
  if (title !== savedTitle || !sameBackground(background, savedBackground) || elements.length !== savedElements.length) return true;
  return elements !== savedElements && elements.some((element, index) => element !== savedElements[index]);
}

function protectChanges(event) {
  event.preventDefault();
  event.returnValue = true;
}

function syncUnloadGuard() {
  if (hasChanges() || savePromise || imageImport || tools.hasPendingText() || tools.hasPendingLine()) {
    window.addEventListener("beforeunload", protectChanges);
  } else {
    window.removeEventListener("beforeunload", protectChanges);
  }
}

function updateSaveStatus() {
  if (!errorNotice.hidden) status.textContent = "Unsaved";
  else if (imageImport) status.textContent = "Adding image.";
  else if (tools.hasPendingText()) status.textContent = "Editing text";
  else if (tools.hasPendingLine()) status.textContent = "Drawing line";
  else if (savePromise || hasChanges()) status.textContent = "Saving…";
  else status.textContent = isDraft ? "" : "Saved";
}

function queueSave() {
  window.clearTimeout(saveTimer);
  syncUnloadGuard();
  if (savePromise) return;
  if (hasChanges()) {
    saveTimer = window.setTimeout(saveDrawing, 350);
  } else {
    showError("");
  }
  updateSaveStatus();
}

function drawingSnapshot(next = elements) {
  return {
    title,
    version: SCENE_VERSION,
    elements: next,
    background: background.pattern,
    background_color: background.color ?? undefined,
    pattern_color: background.patternColor ?? undefined,
  };
}

function saveDrawing() {
  window.clearTimeout(saveTimer);
  if (savePromise) return savePromise;
  if (!hasChanges()) return Promise.resolve(true);
  status.textContent = "Saving…";
  savePromise = persistDrawing(drawingSnapshot(), background);
  syncUnloadGuard();
  return savePromise;
}

async function persistDrawing(drawing, savedBackgroundSnapshot) {
  const target = new URL(endpoint, location.origin);
  if (isDraft) {
    target.searchParams.set("draft", "true");
    if (space && space !== "general") target.searchParams.set("space", space);
  }

  let saved = false;
  try {
    savedTitle = await requestDrawing(target, drawing);
    savedElements = drawing.elements;
    savedBackground = savedBackgroundSnapshot;
    if (title === drawing.title) {
      title = savedTitle;
      if (document.activeElement !== titleInput) titleInput.value = title;
      updatePageTitle();
    }
    if (isDraft) {
      history.replaceState(null, "", "/doc/" + id + location.search + location.hash);
      isDraft = false;
    }
    showError("");
    saved = true;
  } catch (error) {
    status.textContent = "Unsaved";
    showError(error.message);
  } finally {
    savePromise = null;
    syncUnloadGuard();
    if (saved) queueSave();
  }
  return saved;
}

async function requestDrawing(target, drawing) {
  let response;
  try {
    response = await fetch(target, drawing && {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(drawing),
    });
  } catch {
    throw new Error("Couldn't reach Grapho. Check that the server is still running.");
  }
  if (!response.ok) {
    if (response.status === 413) throw new Error("This drawing is too large to save.");
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || (drawing ? "Couldn't save this drawing." : "Couldn't open this drawing."));
  }
  return response.json();
}

function showError(message) {
  errorMessage.textContent = message;
  errorNotice.hidden = !message;
}
