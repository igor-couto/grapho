import {
  drawingTextLayout, elementBounds, hitTest, hitsSegment, moveElement, renderElement, resizeElement,
  selectionHandles, simulatedPencilPressure, updatePencilStroke,
} from "./draw-geometry.js";

const BASE_SIZE = 1000;
const MAX_COORDINATE = 65535;
const MIN_COORDINATE = -MAX_COORDINATE;
const SCENE_BOUNDS = { left: MIN_COORDINATE, top: MIN_COORDINATE, right: MAX_COORDINATE, bottom: MAX_COORDINATE };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // getRandomValues is also available on a home server served over plain HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function unionBounds(elements) {
  return elements.map(elementBounds).reduce((a, b) => ({
    left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
  }));
}

function moveGroup(elements, bounds, dx, dy, view) {
  // An image at its natural size can cover the entire viewport and still move.
  if (elements.some(element => element.type === "image")) view = SCENE_BOUNDS;
  dx = clamp(dx, Math.ceil(Math.min(0, view.left - bounds.left)), Math.floor(Math.max(0, view.right - bounds.right)));
  dy = clamp(dy, Math.ceil(Math.min(0, view.top - bounds.top)), Math.floor(Math.max(0, view.bottom - bounds.bottom)));
  return dx || dy ? elements.map(element => moveElement(element, dx, dy, view)) : elements;
}

function shapeEnd(type, start, end, constrain, view) {
  if (!constrain) return end;
  let dx = end[0] - start[0], dy = end[1] - start[1];
  if (type === "line" || type === "arrow") {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    dx = Math.cos(angle) * length;
    dy = Math.sin(angle) * length;
  } else {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  // Shorten both axes equally when the constrained shape reaches the paper edge.
  const scale = Math.min(1,
    dx > 0 ? (view.right - start[0]) / dx : dx < 0 ? (view.left - start[0]) / dx : 1,
    dy > 0 ? (view.bottom - start[1]) / dy : dy < 0 ? (view.top - start[1]) / dy : 1);
  return [Math.round(start[0] + dx * scale), Math.round(start[1] + dy * scale)];
}

export function createDrawingTools({
  canvas, ink, getElements, commit, onContextChange = () => {}, onDraftChange = () => {},
  isReady = () => true, styleFor = () => undefined,
}) {
  const overlay = document.getElementById("drawingSelection");
  const editor = document.getElementById("drawingTextEditor");
  const stylePanel = document.getElementById("drawingStylePanel");
  const nodes = new Map();
  let tool = "select";
  let selected = new Set();
  let gesture = null;
  let pan = null;
  let viewportAdjusted = false;
  let pendingLine = null;
  let editing = null;
  let initialTextStyle;
  let textAt = null;
  const viewBox = canvas.viewBox.baseVal;
  let view = { left: 0, top: 0, right: BASE_SIZE, bottom: BASE_SIZE };
  let fitScale = 1;
  let displayScale = 1;
  let renderedScale = 1;

  function moveViewport(x, y) {
    viewBox.x = clamp(x, MIN_COORDINATE, Math.max(MIN_COORDINATE, MAX_COORDINATE - viewBox.width));
    viewBox.y = clamp(y, MIN_COORDINATE, Math.max(MIN_COORDINATE, MAX_COORDINATE - viewBox.height));
    view = {
      left: Math.ceil(viewBox.x - 0.001),
      top: Math.ceil(viewBox.y - 0.001),
      right: Math.min(MAX_COORDINATE, Math.floor(viewBox.x + viewBox.width + 0.001)),
      bottom: Math.min(MAX_COORDINATE, Math.floor(viewBox.y + viewBox.height + 0.001)),
    };
    const gridSize = clamp(20 * fitScale / displayScale, 10, 80);
    canvas.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    canvas.style.backgroundPosition = `${-viewBox.x / displayScale}px ${-viewBox.y / displayScale}px`;
  }

  function fitViewport(growOnly = false) {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    if (viewportAdjusted) {
      // Keep the user's view centred on the same spot when the window changes.
      if (growOnly) return;
      const centerX = viewBox.x + viewBox.width / 2;
      const centerY = viewBox.y + viewBox.height / 2;
      viewBox.width = width * displayScale;
      viewBox.height = height * displayScale;
      moveViewport(centerX - viewBox.width / 2, centerY - viewBox.height / 2);
      return;
    }
    const scene = getElements();
    const bounds = scene.length ? unionBounds(scene) : { left: 0, top: 0, right: 0, bottom: 0 };
    const left = clamp(Math.floor(bounds.left), MIN_COORDINATE, 0);
    const top = clamp(Math.floor(bounds.top), MIN_COORDINATE, 0);
    // Use one scale for both axes. The shorter side starts at 1000 units,
    // and the visible area grows to fit saved objects when the window shrinks.
    const unitsPerPixel = Math.max(
      growOnly ? viewBox.width / width : 0,
      Math.max(BASE_SIZE, Math.min(MAX_COORDINATE, bounds.right) - left) / width,
      Math.max(BASE_SIZE, Math.min(MAX_COORDINATE, bounds.bottom) - top) / height,
    );
    fitScale = displayScale = unitsPerPixel;
    viewBox.width = width * unitsPerPixel;
    viewBox.height = height * unitsPerPixel;
    moveViewport(left, top);
  }

  function pointAt(event, bounds) {
    return [
      clamp(Math.round(viewBox.x + (event.clientX - bounds.left) * displayScale), view.left, view.right),
      clamp(Math.round(viewBox.y + (event.clientY - bounds.top) * displayScale), view.top, view.bottom),
    ];
  }

  function selectedElements() {
    return getElements().filter(element => selected.has(element.id));
  }

  function updateSelection(ids) {
    const next = new Set(ids);
    if (next.size === selected.size && [...next].every(id => selected.has(id))) return;
    selected = next;
    onContextChange();
  }

  function overlayRect(className, x, y, w, h) {
    const rect = document.createElementNS(canvas.namespaceURI, "rect");
    rect.setAttribute("class", className);
    for (const [name, value] of Object.entries({ x, y, width: w, height: h })) rect.setAttribute(name, value);
    overlay.append(rect);
    return rect;
  }

  function paintSelection(elements = selectedElements()) {
    overlay.replaceChildren();
    if (tool !== "select" || editing || !elements.length) return;
    const { left, top, right, bottom } = unionBounds(elements);
    overlayRect("drawing-selection-box", left, top, right - left, bottom - top);
    if (elements.length !== 1) return;
    const size = 8 * viewBox.width / canvas.getBoundingClientRect().width;
    for (const { name, point: [x, y] } of selectionHandles(elements[0])) {
      const handle = overlayRect("drawing-resize-handle", x - size / 2, y - size / 2, size, size);
      handle.dataset.handle = name;
    }
  }

  function render() {
    const scene = getElements();
    const ids = new Set(scene.map(element => element.id));
    for (const [id, { node }] of nodes) {
      if (!ids.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    }
    for (const element of scene) {
      const previous = nodes.get(element.id);
      if (previous?.element !== element
          || (renderedScale !== displayScale && element.type === "pencil" && element.style?.pressure === "variable")) {
        paintPreview(element);
      }
      else if (element.id !== editing?.id) previous.node.removeAttribute("visibility");
    }
    // An undo can reinsert an object below a later one. Restore that order
    // while leaving unchanged pencil paths and labels in place.
    let next = ink.firstElementChild;
    for (const { id } of scene) {
      const { node } = nodes.get(id);
      if (node !== next) ink.insertBefore(node, next);
      next = node.nextElementSibling;
    }
    updateSelection([...selected].filter(id => nodes.has(id)));
    renderedScale = displayScale;
    paintSelection();
  }

  function paintPreview(element) {
    const node = renderElement(element, displayScale);
    if (element.id === editing?.id) node.setAttribute("visibility", "hidden");
    const previous = nodes.get(element.id);
    if (previous) previous.node.replaceWith(node);
    else ink.append(node);
    nodes.set(element.id, { element, node });
  }

  function lineElement(points, closed) {
    const element = { id: pendingLine.id, type: "line", start: points[0], end: points.at(-1) };
    const style = styleFor("line");
    if (style) element.style = style;
    if (points.length > 2) element.vertices = points.slice(1, -1);
    if (closed) element.closed = true;
    return element;
  }

  function lineTarget(event) {
    const rect = canvas.getBoundingClientRect();
    const point = pointAt(event, rect);
    const { points } = pendingLine;
    const scale = viewBox.width / rect.width;
    const near = ([x, y], radius) => Math.hypot(point[0] - x, point[1] - y) <= radius * scale;
    const last = points.at(-1);
    if (points.length >= 3 && near(points[0], event.pointerType === "touch" ? 14 : 8)) {
      return { closed: true };
    }
    if (near(last, 4)) return { finish: true };
    // A line may start outside the visible area when the user pans mid-path.
    const limits = {
      left: Math.min(view.left, last[0]), top: Math.min(view.top, last[1]),
      right: Math.max(view.right, last[0]), bottom: Math.max(view.bottom, last[1]),
    };
    return { point: shapeEnd("line", last, point, event.shiftKey, limits) };
  }

  function paintLinePreview() {
    if (!pendingLine) return;
    const { points, target } = pendingLine;
    const preview = target?.point ? [...points, target.point] : points;
    paintPreview(lineElement(preview, Boolean(target?.closed)));
    overlay.replaceChildren();
    const [x, y] = points[0];
    const size = 7 * viewBox.width / canvas.getBoundingClientRect().width;
    overlayRect("drawing-line-start", x - size / 2, y - size / 2, size, size);
  }

  function finishLine(closed = false) {
    if (!pendingLine) return false;
    const { id, points } = pendingLine;
    const element = lineElement(points, closed);
    pendingLine = null;
    nodes.get(id)?.node.remove();
    nodes.delete(id);
    if (points.length >= 2) commit([...getElements(), element]);
    else paintSelection();
    onDraftChange();
    return true;
  }

  function placeLinePoint(event) {
    const target = lineTarget(event);
    if (target.closed) finishLine(true);
    else if (target.finish) {
      if (pendingLine.points.length >= 2) finishLine();
    } else {
      pendingLine.points.push(target.point);
      pendingLine.target = null;
      paintLinePreview();
      onDraftChange();
    }
  }

  function fitEditor() {
    if (!editing) return;
    const { width, height } = canvas.getBoundingClientRect();
    // Keep a new or growing label on the page even when its original anchor
    // was in the last row or column. Oversized labels start at the paper edge.
    const layout = drawingTextLayout({ ...editing, text: editor.value });
    const lineWidth = Math.max(layout.fontSize, Math.ceil(layout.width) + 2);
    textAt = [
      clamp(editing.at[0], view.left, Math.max(view.left, view.right - lineWidth)),
      clamp(editing.at[1], view.top, Math.max(view.top, view.bottom - layout.height)),
    ];
    const scale = width / viewBox.width;
    editor.style.fontFamily = layout.fontFamily;
    editor.style.fontSize = layout.fontSize * scale + "px";
    editor.style.lineHeight = layout.lineHeight * scale + "px";
    editor.style.textAlign = layout.align;
    const color = editing.style?.stroke ?? "var(--ink)";
    editor.style.color = `color-mix(in srgb, ${color} ${editing.style?.opacity ?? 100}%, transparent)`;
    const left = (textAt[0] - viewBox.x) * scale;
    const top = (textAt[1] - viewBox.y) * scale;
    editor.style.left = left + "px";
    editor.style.top = top + "px";
    editor.style.width = Math.min(width - left, lineWidth * scale) + "px";
    editor.style.height = Math.min(height - top, (layout.height + 2) * scale) + "px";
  }

  function beginText(at, original) {
    editing = original || { id: newId(), type: "text", at, text: "" };
    const style = original ? original.style : styleFor("text");
    if (!original && style) editing.style = style;
    initialTextStyle = style;
    nodes.get(editing.id)?.node.setAttribute("visibility", "hidden");
    editor.value = editing.text;
    editor.hidden = false;
    fitEditor();
    paintSelection();
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    onContextChange();
    onDraftChange();
  }

  function setEditingTextStyle(style) {
    if (!editing) return;
    editing = { ...editing };
    if (style) editing.style = style;
    else delete editing.style;
    fitEditor();
    onDraftChange();
  }

  function hasPendingText() {
    if (!editing) return false;
    if (editor.value !== editing.text) return true;
    if (editing.style === initialTextStyle) return false;
    const before = initialTextStyle ?? {};
    const after = Object.entries(editing.style ?? {});
    return after.length !== Object.keys(before).length || after.some(([key, value]) => before[key] !== value);
  }

  function finishText(accept = true) {
    if (!editing) return false;
    const element = editing;
    const value = editor.value;
    const changed = hasPendingText();
    editing = null;
    initialTextStyle = undefined;
    editor.blur();
    editor.hidden = true;
    nodes.get(element.id)?.node.removeAttribute("visibility");
    if (accept && changed) {
      const scene = getElements();
      const existing = scene.some(item => item.id === element.id);
      if (value.trim()) {
        const next = { ...element, at: textAt, text: value };
        commit(existing ? scene.map(item => item.id === next.id ? next : item) : [...scene, next]);
      } else if (existing) {
        commit(scene.filter(item => item.id !== element.id));
      }
    }
    paintSelection();
    onContextChange();
    onDraftChange();
    return true;
  }

  editor.addEventListener("input", () => {
    fitEditor();
    onDraftChange();
  });
  editor.addEventListener("blur", event => {
    if (!stylePanel.contains(event.relatedTarget)) finishText();
  });
  stylePanel.addEventListener("focusout", event => {
    if (event.relatedTarget !== editor && !stylePanel.contains(event.relatedTarget)) finishText();
  });
  editor.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      event.stopPropagation();
      finishText(event.key !== "Escape");
    }
  });

  function cancel() {
    if (editing) return finishText(false);
    if (!gesture && !pendingLine) return false;
    const cancelledLine = Boolean(pendingLine);
    pendingLine = null;
    if (gesture) {
      const { pointerId, previousSelection } = gesture;
      gesture = null;
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      updateSelection(previousSelection);
    }
    render();
    if (cancelledLine) onDraftChange();
    return true;
  }

  function setTool(next) {
    finishText();
    if (next !== tool) finishLine();
    if (!pendingLine) cancel();
    if (next !== tool) updateSelection([]);
    tool = next;
    canvas.dataset.tool = next;
    if (pendingLine) paintLinePreview();
    else paintSelection();
  }

  function clearSelection() {
    updateSelection([]);
    paintSelection();
  }

  function selectAll() {
    updateSelection(getElements().map(element => element.id));
    paintSelection();
  }

  function removeSelection() {
    cancel();
    if (!selected.size) return false;
    const next = getElements().filter(element => !selected.has(element.id));
    updateSelection([]);
    commit(next);
    return true;
  }

  function duplicateSelection() {
    cancel();
    const originals = selectedElements();
    if (!originals.length) return false;
    const copies = moveGroup(originals, unionBounds(originals), 16, 16, view).map(element => ({ ...element, id: newId() }));
    if (!commit([...getElements(), ...copies])) return false;
    updateSelection(copies.map(element => element.id));
    paintSelection(copies);
    return true;
  }

  function imagePlacement(event) {
    return event
      ? pointAt(event, canvas.getBoundingClientRect())
      : [(view.left + view.right) / 2, (view.top + view.bottom) / 2];
  }

  function addImage({ src, alt, width, height }, [x, y] = imagePlacement()) {
    if (width > MAX_COORDINATE - MIN_COORDINATE || height > MAX_COORDINATE - MIN_COORDINATE) {
      throw new Error("This image is too wide or tall for the drawing canvas.");
    }
    const imageX = clamp(Math.floor(x - width / 2), MIN_COORDINATE, MAX_COORDINATE - width);
    const imageY = clamp(Math.floor(y - height / 2), MIN_COORDINATE, MAX_COORDINATE - height);
    const image = {
      id: newId(), type: "image", src, alt,
      start: [imageX, imageY], end: [imageX + width, imageY + height],
    };
    if (!commit([...getElements(), image])) return;
    updateSelection([image.id]);
    paintSelection([image]);
  }

  function pick(point, tolerance) {
    return getElements().findLast(element => hitTest(element, point, tolerance));
  }

  function startSelection(point, event, unitsPerPixel) {
    const originals = selectedElements();
    if (originals.length === 1) {
      const radius = (event.pointerType === "touch" ? 14 : 7) * unitsPerPixel;
      const handle = selectionHandles(originals[0]).find(({ point: [x, y] }) =>
        Math.abs(x - point[0]) <= radius && Math.abs(y - point[1]) <= radius);
      if (handle) return { kind: "resize", original: originals[0], handle };
    }
    const target = pick(point, (event.pointerType === "touch" ? 10 : 5) * unitsPerPixel);
    if (!target) {
      if (!event.shiftKey) clearSelection();
      return { kind: "marquee", additive: event.shiftKey };
    }
    if (event.shiftKey && selected.has(target.id)) {
      updateSelection([...selected].filter(id => id !== target.id));
      paintSelection();
      return null;
    }
    if (!selected.has(target.id)) updateSelection(event.shiftKey ? [...selected, target.id] : [target.id]);
    const moving = selectedElements();
    paintSelection(moving);
    return { kind: "move", originals: moving, bounds: unionBounds(moving) };
  }

  function erase(start, end) {
    for (const element of getElements()) {
      if (gesture.removed.has(element.id) || !hitsSegment(element, start, end, gesture.tolerance)) continue;
      gesture.removed.add(element.id);
      nodes.get(element.id).node.setAttribute("visibility", "hidden");
    }
  }

  function beginPan(event) {
    finishText();
    if (pendingLine?.target) {
      pendingLine.target = null;
      paintLinePreview();
    }
    pan = {
      pointerId: event.pointerId,
      clientX: event.clientX, clientY: event.clientY,
      x: viewBox.x, y: viewBox.y,
    };
    canvas.classList.add("is-panning");
    canvas.setPointerCapture(event.pointerId);
  }

  function panTo(event) {
    const dx = event.clientX - pan.clientX;
    const dy = event.clientY - pan.clientY;
    if (dx || dy) viewportAdjusted = true;
    moveViewport(pan.x - dx * displayScale, pan.y - dy * displayScale);
  }

  function endPan() {
    if (!pan) return;
    const { pointerId } = pan;
    pan = null;
    canvas.classList.remove("is-panning");
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }

  // Prevent the browser's middle-button autoscroll on the canvas.
  for (const eventName of ["mousedown", "auxclick"]) {
    canvas.addEventListener(eventName, event => {
      if (event.button === 1) event.preventDefault();
    });
  }
  canvas.addEventListener("mouseup", event => {
    // With another button still held, the mouse has no pointerup yet.
    if (event.button === 1) endPan();
  });

  canvas.addEventListener("wheel", event => {
    if (!isReady()) return;
    const mode = event.deltaMode;
    if (!event.deltaX && !event.deltaY) return;
    event.preventDefault();
    if (gesture || pan) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = event.deltaX * (mode === 1 ? 16 : mode === 2 ? rect.width : 1);
    const dy = event.deltaY * (mode === 1 ? 16 : mode === 2 ? rect.height : 1);
    finishText();
    if (pendingLine) pendingLine.target = null;
    viewportAdjusted = true;
    if (Math.abs(dx) >= Math.abs(dy)) {
      moveViewport(viewBox.x + dx * displayScale, viewBox.y);
    } else {
      const maxScale = Math.max(fitScale, Math.min(fitScale * 8, (MAX_COORDINATE - MIN_COORDINATE) / Math.max(rect.width, rect.height)));
      const minScale = Math.min(fitScale, Math.max(0.125, fitScale / 8));
      const scale = clamp(displayScale * Math.exp(clamp(dy, -300, 300) * 0.002), minScale, maxScale);
      if (scale !== displayScale) {
        // The world position under the pointer stays fixed while scaling.
        const x = viewBox.x + (event.clientX - rect.left) * (displayScale - scale);
        const y = viewBox.y + (event.clientY - rect.top) * (displayScale - scale);
        displayScale = scale;
        viewBox.width = rect.width * scale;
        viewBox.height = rect.height * scale;
        moveViewport(x, y);
        render();
      }
    }
    if (pendingLine) paintLinePreview();
  }, { passive: false });

  canvas.addEventListener("pointerdown", event => {
    if (!isReady() || gesture || pan || !event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    if (event.button === 1) {
      beginPan(event);
      return;
    }
    finishText();
    // Leave the active input so the drawing's shortcuts receive the next key.
    document.activeElement?.blur();
    const rect = canvas.getBoundingClientRect();
    const point = pointAt(event, rect);
    const unitsPerPixel = viewBox.width / rect.width;
    const previousSelection = [...selected];
    let action;
    if (tool === "text") {
      const target = pick(point, 3 * unitsPerPixel);
      beginText(point, target?.type === "text" ? target : null);
      return;
    }
    if (pendingLine) {
      action = { kind: "line-point" };
    } else if (tool === "select") {
      action = startSelection(point, event, unitsPerPixel);
      if (!action) return;
    } else if (tool === "eraser") {
      action = { kind: "erase", removed: new Set(), tolerance: 6 * unitsPerPixel };
    } else if (tool === "pencil") {
      const element = { id: newId(), type: tool, points: [point] };
      const style = styleFor(tool);
      if (style) element.style = style;
      if (event.pointerType === "pen" || style?.pressure === "variable") {
        element.pressures = [event.pointerType === "pen" ? Math.round(event.pressure * 255) : 128];
      }
      paintPreview(element);
      action = { kind: "pencil", element, commands: "M" + point.join(" ") };
    } else {
      const element = { id: newId(), type: tool, start: point, end: point };
      const style = styleFor(tool);
      if (style) element.style = style;
      paintPreview(element);
      action = { kind: "shape", element, unitsPerPixel };
    }
    gesture = { ...action, pointerId: event.pointerId, start: point, last: point, previousSelection };
    canvas.setPointerCapture(event.pointerId);
    if (gesture.kind === "erase") erase(point, point);
  });

  function updateMarquee(point) {
    const [x, y] = gesture.start;
    const left = Math.min(x, point[0]), top = Math.min(y, point[1]);
    const right = Math.max(x, point[0]), bottom = Math.max(y, point[1]);
    const ids = gesture.additive ? [...gesture.previousSelection] : [];
    for (const element of getElements()) {
      const bounds = elementBounds(element);
      if (bounds.left >= left && bounds.right <= right && bounds.top >= top && bounds.bottom <= bottom) ids.push(element.id);
    }
    updateSelection(ids);
    paintSelection();
    overlayRect("drawing-marquee", left, top, right - left, bottom - top);
  }

  function updateGesture(event) {
    if (gesture.kind === "line-point") return;
    const rect = canvas.getBoundingClientRect();
    const point = pointAt(event, rect);
    if (gesture.kind === "pencil" || gesture.kind === "erase") {
      let changed = false;
      const pressures = gesture.element?.pressures;
      const pen = event.pointerType === "pen";
      for (const sample of [...(event.getCoalescedEvents?.() || []), event]) {
        const next = pointAt(sample, rect);
        const pressure = pen && sample.pressure > 0 ? Math.round(sample.pressure * 255) : undefined;
        if (samePoint(gesture.last, next)) {
          if (pressures && pressure !== undefined && pressures.at(-1) !== pressure) {
            pressures[pressures.length - 1] = pressure;
            changed = true;
          }
          continue;
        }
        if (gesture.kind === "erase") erase(gesture.last, next);
        else {
          gesture.element.points.push(next);
          if (pressures) {
            pressures.push(pressure ?? (pen ? pressures.at(-1) : simulatedPencilPressure(gesture.last, next, displayScale)));
          }
          gesture.commands += "L" + next.join(" ");
        }
        changed = true;
        gesture.last = next;
      }
      if (changed && gesture.kind === "pencil") {
        updatePencilStroke(nodes.get(gesture.element.id).node, gesture.element, displayScale, gesture.commands);
      }
      return;
    }
    if (samePoint(gesture.last, point) && gesture.kind !== "shape") return;
    gesture.last = point;
    const dx = point[0] - gesture.start[0], dy = point[1] - gesture.start[1];
    if (gesture.kind === "move") {
      gesture.preview = moveGroup(gesture.originals, gesture.bounds, dx, dy, view);
      for (const element of gesture.preview) paintPreview(element);
      paintSelection(gesture.preview);
    } else if (gesture.kind === "resize") {
      const { original, handle } = gesture;
      const nextPoint = [
        clamp(handle.point[0] + dx, view.left, view.right),
        clamp(handle.point[1] + dy, view.top, view.bottom),
      ];
      gesture.preview = samePoint(nextPoint, handle.point) ? original : resizeElement(original, handle.name, nextPoint, view);
      paintPreview(gesture.preview);
      paintSelection([gesture.preview]);
    } else if (gesture.kind === "shape") {
      gesture.element.end = shapeEnd(tool, gesture.start, point, event.shiftKey, view);
      paintPreview(gesture.element);
    } else {
      updateMarquee(point);
    }
  }

  canvas.addEventListener("pointermove", event => {
    if (pan) {
      if (event.pointerId !== pan.pointerId) return;
      if (event.buttons & 4) panTo(event);
      else endPan();
    } else if (pendingLine && event.isPrimary) {
      pendingLine.target = lineTarget(event);
      paintLinePreview();
    } else if (event.pointerId === gesture?.pointerId) {
      updateGesture(event);
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (!pendingLine?.target) return;
    pendingLine.target = null;
    paintLinePreview();
  });

  canvas.addEventListener("pointerup", event => {
    if (event.pointerId === pan?.pointerId) {
      panTo(event);
      endPan();
      return;
    }
    if (event.pointerId !== gesture?.pointerId) return;
    updateGesture(event);
    const action = gesture;
    gesture = null;
    const scene = getElements();
    if (action.kind === "line-point") {
      if (pendingLine) placeLinePoint(event);
    } else if (action.kind === "shape" && action.element.type === "line"
        && Math.hypot(action.last[0] - action.start[0], action.last[1] - action.start[1]) <= 4 * action.unitsPerPixel) {
      pendingLine = { id: action.element.id, points: [action.start] };
      paintLinePreview();
    } else if (action.kind === "pencil" || (action.kind === "shape" && !samePoint(action.start, action.element.end))) {
      commit([...scene, action.element]);
    } else if (action.kind === "erase" && action.removed.size) {
      commit(scene.filter(element => !action.removed.has(element.id)));
    } else if (action.kind === "move" && action.preview && action.preview !== action.originals) {
      const moved = new Map(action.preview.map(element => [element.id, element]));
      commit(scene.map(element => moved.get(element.id) || element));
    } else if (action.kind === "resize" && action.preview && action.preview !== action.original) {
      commit(scene.map(element => element.id === action.original.id ? action.preview : element));
    } else if (action.kind === "shape") {
      nodes.get(action.element.id).node.remove();
      nodes.delete(action.element.id);
    } else {
      paintSelection();
    }
  });

  canvas.addEventListener("pointercancel", event => {
    if (event.pointerId === pan?.pointerId) endPan();
    if (event.pointerId === gesture?.pointerId) cancel();
  });
  canvas.addEventListener("lostpointercapture", event => {
    // Touch transfers implicit capture from the pressed SVG child to the canvas.
    if (event.target !== canvas) return;
    if (event.pointerId === pan?.pointerId) endPan();
    if (event.pointerId === gesture?.pointerId) cancel();
  });
  window.addEventListener("blur", endPan);

  canvas.addEventListener("dblclick", event => {
    if (!isReady() || tool !== "select" || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const target = pick(pointAt(event, rect), 4 * viewBox.width / rect.width);
    if (target?.type === "text") {
      event.preventDefault();
      beginText(target.at, target);
    }
  });

  new ResizeObserver(() => {
    endPan();
    if (gesture) cancel();
    fitViewport();
    if (renderedScale !== displayScale) render();
    if (editing) fitEditor();
    else if (pendingLine) paintLinePreview();
    else if (selected.size) paintSelection();
  }).observe(canvas);

  document.fonts.addEventListener("loadingdone", () => {
    for (const element of getElements()) {
      if (element.type === "text") paintPreview(element);
    }
    if (editing) fitEditor();
    else if (!gesture && selected.size) paintSelection();
  });

  canvas.dataset.tool = tool;
  return {
    setTool, render, fitViewport, removeSelection, duplicateSelection, clearSelection, selectAll, cancel, finishText,
    selectedElements, addImage, imagePlacement, finishLine, paintLinePreview, getTool: () => tool,
    hasSelection: () => selected.size > 0,
    getEditingText: () => editing,
    setEditingTextStyle,
    hasPendingText,
    hasPendingLine: () => pendingLine?.points.length > 1,
  };
}
