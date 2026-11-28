import assert from "node:assert/strict";
import { test } from "node:test";
import { elementBounds, hitsSegment, hitTest, moveElement, resizeElement, selectionHandles, simulatedPencilPressure } from "../assets/draw-geometry.js";

test("an outlined shape can be selected inside, and only inside its actual contour", () => {
  const box = { start: [240, 200], end: [40, 100] };
  for (const type of ["rectangle", "diamond", "ellipse"]) {
    const element = { ...box, type };
    assert.equal(hitTest(element, [140, 150], 0), true);
    assert.equal(hitTest(element, [140, 98], 3), true);
    assert.equal(hitTest(element, [140, 90], 3), false);
    assert.equal(hitTest(element, [41, 101], 0), type === "rectangle");
  }
});

test("a fast eraser sweep catches crossing lines, curves, strokes, and dots between samples", () => {
  const start = [300, 100], end = [300, 500];
  const shapes = [
    { type: "line", start, end },
    { type: "arrow", start, end },
    { type: "diamond", start: [250, 100], end: [350, 500] },
    { type: "ellipse", start: [250, 100], end: [350, 500] },
    { type: "pencil", points: [[280, 120], [340, 420], [410, 490]] },
    { type: "pencil", points: [[320, 300]] },
  ];
  for (const element of shapes) {
    assert.equal(hitsSegment(element, [100, 300], [700, 300], 0), true, element.type);
    assert.equal(hitsSegment(element, [100, 40], [700, 60], 12), false, element.type);
  }
});

test("an arrowhead is part of its bounds and counts as a pointer hit", () => {
  const arrow = { type: "arrow", start: [50, 100], end: [350, 100] };
  assert.ok(elementBounds(arrow).top < 92);
  assert.equal(hitTest(arrow, [333, 108], 2), true);
  assert.equal(hitTest({ ...arrow, type: "line" }, [333, 108], 2), false);
});

test("selection and erasing use the curved or elbow route", () => {
  const curved = { type: "arrow", start: [100, 300], end: [500, 300], style: { route: "curved" } };
  assert.equal(hitTest(curved, [300, 372], 1), true);
  assert.equal(hitTest(curved, [300, 300], 1), false);

  const elbow = { type: "arrow", start: [120, 200], end: [480, 380], style: { route: "elbow" } };
  assert.equal(hitsSegment(elbow, [290, 295], [315, 295], 0), true);
  assert.equal(hitTest(elbow, [210, 245], 1), false);
});

test("each arrowhead changes hit testing at its own endpoint", () => {
  const arrow = {
    type: "arrow", start: [100, 100], end: [500, 100],
    style: { start_head: "bar", end_head: "none" },
  };
  assert.equal(hitTest(arrow, [100, 92], 0), true);
  assert.equal(hitTest(arrow, [482, 108], 1), false);
  assert.equal(elementBounds(arrow).top < 92, true);
});

test("a line uses its intermediate points, trims rounded joins, and fills only a closed path", () => {
  const line = { type: "line", start: [100, 100], vertices: [[300, 100]], end: [300, 300] };
  assert.equal(hitTest(line, [300, 100], 0), true);
  assert.equal(hitTest({ ...line, style: { edges: "rounded" } }, [300, 100], 0), false);
  assert.equal(hitTest(line, [300, 250], 0), true);
  const filled = { ...line, style: { fill: "#f0c879" } };
  assert.equal(hitTest(filled, [260, 180], 0), false);
  assert.equal(hitTest({ ...filled, closed: true }, [260, 180], 0), true);
  assert.deepEqual(moveElement(line, 50, 25).vertices, [[350, 125]]);
  assert.deepEqual(resizeElement(line, "vertex-0", [400, 120]).vertices, [[400, 120]]);
});

test("a pencil background extends picking to the filled area between its ends", () => {
  const pencil = { type: "pencil", points: [[100, 120], [300, 120], [300, 320]] };
  assert.equal(hitTest(pencil, [240, 180], 0), false);
  assert.equal(hitTest({ ...pencil, style: { fill: "#f0c879" } }, [240, 180], 0), true);
  assert.ok(simulatedPencilPressure([0, 0], [5, 0]) > simulatedPencilPressure([0, 0], [80, 0]));
});

test("translation preserves every point, including when dragging against the page border", () => {
  const pencil = { id: "a", type: "pencil", points: [[20, 30], [100, 70], [975, 120]] };
  assert.equal(moveElement(pencil, 0, 0), pencil);
  assert.deepEqual(moveElement(pencil, 100, -50).points, [[45, 0], [125, 40], [1000, 90]]);
  assert.deepEqual(pencil.points, [[20, 30], [100, 70], [975, 120]]);
});

test("images can be hit and resized without stretching or crossing the opposite corner", () => {
  const picture = { type: "image", start: [300, 275], end: [500, 375] };
  assert.equal(hitTest(picture, [420, 320], 0), true);
  assert.equal(hitTest(picture, [420, 440], 0), false);
  const larger = resizeElement(picture, "se", [700, 465]);
  assert.deepEqual(larger.start, picture.start);
  assert.ok(Math.abs((larger.end[0] - 300) / (larger.end[1] - 275) - 2) < 0.02);
  const behind = resizeElement(picture, "se", [150, 200]);
  assert.deepEqual(behind.start, picture.start);
  assert.deepEqual(behind.end, [302, 276]);
});

test("movement and image resizing respect negative viewport bounds", () => {
  const view = { left: -400, top: -250, right: 600, bottom: 750 };
  const picture = { type: "image", start: [-200, -160], end: [0, -60] };
  assert.deepEqual(moveElement(picture, -250, -125, view).start, [-400, -250]);
  assert.deepEqual(resizeElement(picture, "nw", [-390, -240], view), {
    ...picture, start: [-380, -250],
  });
});

test("every image corner preserves its opposite anchor and aspect ratio on a panned canvas", () => {
  const view = { left: -400, top: -300, right: 600, bottom: 200 };
  const image = { type: "image", start: [-100, -100], end: [100, 0] };
  // Each drag goes beyond both edges. The edge reached first must limit both axes.
  const cases = [
    ["nw", [-1000, -1000], [-400, -250], [100, 0]],
    ["ne", [1000, -1000], [-100, -300], [500, 0]],
    ["sw", [-1000, 1000], [-400, -100], [100, 150]],
    ["se", [1000, 1000], [-100, -100], [500, 200]],
  ];
  for (const [handle, pointer, start, end] of cases) {
    const resized = resizeElement(image, handle, pointer, view);
    assert.deepEqual([resized.start, resized.end], [start, end], handle);
  }
  assert.deepEqual([image.start, image.end], [[-100, -100], [100, 0]]);
});

test("resizing a pressure-sensitive stroke keeps samples paired with points and preserves the undo snapshot", () => {
  const stroke = {
    id: "stroke", type: "pencil", style: { pressure: "variable", width: 3 },
    points: [[120, 140], [130, 160], [160, 180]], pressures: [30, 200, 75],
  };
  const before = structuredClone(stroke);
  const resized = resizeElement(stroke, "se", [200, 260]);
  assert.deepEqual(resized, { ...before, points: [[120, 140], [140, 200], [200, 260]] });
  assert.deepEqual(stroke, before);
});

test("corner resizing preserves the opposite anchor and can cross it", () => {
  const shape = { type: "rectangle", start: [200, 100], end: [100, 200] };
  const resize = resizeElement(shape, "sw", [245, 80]);
  assert.deepEqual(resize.start, shape.start);
  assert.deepEqual(resize.end, [245, 80]);
  assert.deepEqual(shape.end, [100, 200]);
  const pencil = { type: "pencil", points: [[80, 50], [80, 100], [80, 150]] };
  assert.deepEqual(selectionHandles(pencil).map(h => h.name), ["nw", "se"]);
  assert.deepEqual(resizeElement(pencil, "se", [100, 200]).points, [[80, 50], [90, 125], [100, 200]]);
});

test("line endpoints resize independently and keep their direction after crossing", () => {
  const arrow = { type: "arrow", start: [500, 80], end: [600, 250] };
  assert.deepEqual(selectionHandles(arrow).map(h => h.name), ["start", "end"]);
  assert.deepEqual(resizeElement(arrow, "end", [28.2, -20]), { ...arrow, end: [28, 0] });
});
