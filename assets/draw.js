const DEFAULT_TITLE = "Untitled drawing";
const library = document.getElementById("drawingLibraryLink");
const titleInput = document.getElementById("drawingTitle");
const canvas = document.getElementById("drawingCanvas");
const ink = document.getElementById("drawingInk");
const undo = document.getElementById("drawingUndo");
const redo = document.getElementById("drawingRedo");
const status = document.getElementById("drawingStatus");
const errorNotice = document.getElementById("drawingError");
const errorMessage = document.getElementById("drawingErrorMessage");
const size = canvas.viewBox.baseVal.width;
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
let strokes = [];
const undoneStrokes = [];
let activeStroke = null;
let savedTitle = DEFAULT_TITLE;
let savedStrokes = [];
let savePromise = null;
let saveTimer;

titleInput.addEventListener("input", () => {
  title = titleInput.value.trim().replace(/\s+/g, " ") || DEFAULT_TITLE;
  updatePageTitle();
  queueSave();
});
titleInput.addEventListener("blur", () => { titleInput.value = title; });
titleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) titleInput.blur();
});

canvas.addEventListener("pointerdown", (event) => {
  if (!loaded || activeStroke || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  titleInput.blur();
  canvas.setPointerCapture(event.pointerId);
  const [x, y] = pointAt(event, canvas.getBoundingClientRect());
  const commands = `M${x} ${y}`;
  activeStroke = {
    pointerId: event.pointerId,
    points: [[x, y]],
    commands,
    path: appendPath(commands + "l0 0"),
  };
  updateHistoryControls();
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId === activeStroke?.pointerId) extendStroke(event);
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId !== activeStroke?.pointerId) return;
  extendStroke(event);
  strokes.push(activeStroke.points);
  activeStroke = null;
  undoneStrokes.length = 0;
  updateHistoryControls();
  queueSave();
});

for (const name of ["pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(name, (event) => {
    if (event.pointerId !== activeStroke?.pointerId) return;
    activeStroke.path.remove();
    activeStroke = null;
    updateHistoryControls();
  });
}

undo.addEventListener("click", () => changeHistory(false));
redo.addEventListener("click", () => changeHistory(true));
document.addEventListener("keydown", (event) => {
  if (!loaded || activeStroke || event.isComposing || event.altKey
      || !(event.ctrlKey || event.metaKey) || document.activeElement === titleInput
      || document.querySelector("dialog[open]")) return;
  const key = event.key.toLowerCase();
  if (key === "z" || (key === "y" && !event.shiftKey)) {
    event.preventDefault();
    changeHistory(key === "y" || event.shiftKey);
  }
});

document.getElementById("drawingRetry").addEventListener("click", () => {
  if (loaded) saveDrawing();
  else loadDrawing();
});

library.addEventListener("click", async (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || (!savePromise && !hasChanges())) return;
  event.preventDefault();
  while (savePromise || hasChanges()) {
    if (!await saveDrawing()) return;
  }
  location.assign(library.href);
});

loadDrawing();

function pointAt(event, bounds) {
  return [
    Math.max(0, Math.min(size, Math.round((event.clientX - bounds.left) / bounds.width * size))),
    Math.max(0, Math.min(size, Math.round((event.clientY - bounds.top) / bounds.height * size))),
  ];
}

function extendStroke(event) {
  const bounds = canvas.getBoundingClientRect();
  const previousLength = activeStroke.points.length;
  const samples = event.getCoalescedEvents?.() ?? [];
  for (const sample of [...samples, event]) {
    const [x, y] = pointAt(sample, bounds);
    const [lastX, lastY] = activeStroke.points.at(-1);
    if (x === lastX && y === lastY) continue;
    activeStroke.points.push([x, y]);
    activeStroke.commands += `L${x} ${y}`;
  }
  if (activeStroke.points.length !== previousLength) {
    activeStroke.path.setAttribute("d", activeStroke.commands);
  }
}

function appendPath(commands) {
  const path = document.createElementNS(canvas.namespaceURI, "path");
  path.setAttribute("d", commands);
  ink.append(path);
  return path;
}

function renderStroke(points) {
  const coordinates = points.map(([x, y]) => `${x} ${y}`).join("L");
  appendPath("M" + coordinates + (points.length === 1 ? "l0 0" : ""));
}

function changeHistory(forward) {
  const stroke = (forward ? undoneStrokes : strokes).pop();
  if (!stroke) return;
  if (forward) {
    strokes.push(stroke);
    renderStroke(stroke);
  } else {
    undoneStrokes.push(stroke);
    ink.lastElementChild.remove();
  }
  updateHistoryControls();
  queueSave();
}

function updateHistoryControls() {
  undo.disabled = Boolean(activeStroke) || strokes.length === 0;
  redo.disabled = Boolean(activeStroke) || undoneStrokes.length === 0;
}

async function loadDrawing() {
  showError("");
  try {
    if (!isDraft) {
      const drawing = await requestDrawing(endpoint);
      title = savedTitle = drawing.title;
      strokes = drawing.strokes;
      savedStrokes = strokes.slice();
      for (const stroke of strokes) renderStroke(stroke);
      status.textContent = "Saved";
    }
    titleInput.disabled = false;
    titleInput.value = title;
    updatePageTitle();
    updateHistoryControls();
    loaded = true;
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
  return title !== savedTitle || strokes.length !== savedStrokes.length
    || strokes.some((stroke, index) => stroke !== savedStrokes[index]);
}

function protectChanges(event) {
  event.preventDefault();
  event.returnValue = true;
}

function syncUnloadGuard() {
  if (hasChanges() || savePromise) window.addEventListener("beforeunload", protectChanges);
  else window.removeEventListener("beforeunload", protectChanges);
}

function queueSave() {
  window.clearTimeout(saveTimer);
  syncUnloadGuard();
  if (savePromise) return;
  if (hasChanges()) {
    status.textContent = "Saving…";
    saveTimer = window.setTimeout(saveDrawing, 350);
  } else {
    status.textContent = isDraft ? "" : "Saved";
    showError("");
  }
}

function saveDrawing() {
  window.clearTimeout(saveTimer);
  if (savePromise) return savePromise;
  if (!hasChanges()) return Promise.resolve(true);
  status.textContent = "Saving…";
  savePromise = persistDrawing({ title, strokes: strokes.slice() });
  syncUnloadGuard();
  return savePromise;
}

async function persistDrawing(drawing) {
  const target = new URL(endpoint, location.origin);
  if (isDraft) {
    target.searchParams.set("draft", "true");
    if (space && space !== "general") target.searchParams.set("space", space);
  }

  let saved = false;
  try {
    savedTitle = await requestDrawing(target, drawing);
    savedStrokes = drawing.strokes;
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
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || (drawing ? "Couldn't save this drawing." : "Couldn't open this drawing."));
  }
  return response.json();
}

function showError(message) {
  errorMessage.textContent = message;
  errorNotice.hidden = !message;
}
