const SVG_NS = "http://www.w3.org/2000/svg";
const SQUARE_VIEW = { left: 0, top: 0, right: 1000, bottom: 1000 };
const TEXT_SIZES = { s: 24, m: 32, l: 44, xl: 60 };
const TEXT_FAMILIES = {
  normal: 'Inter, "Segoe UI", system-ui, sans-serif',
  hand_drawn: 'Kalam, "Segoe Print", cursive',
  code: 'ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace',
};
let textContext;

export function isStyledShape(type) {
  return type === "rectangle" || type === "diamond" || type === "ellipse";
}

function svg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function boundsOf(points) {
  let [[left, top]] = points;
  let right = left, bottom = top;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

function arrowhead(kind, [x, y], [tipX, tipY], size) {
  const dx = tipX - x, dy = tipY - y;
  const length = Math.hypot(dx, dy);
  if (kind === "none" || !length) return [];
  const back = kind === "bar" ? 0 : size / length;
  const half = size * 0.48 / length;
  const baseX = tipX - dx * back, baseY = tipY - dy * back;
  const left = [baseX - dy * half, baseY + dx * half];
  const right = [baseX + dy * half, baseY - dx * half];
  if (kind === "bar") return [left, right];
  const points = [left, [tipX, tipY], right];
  if (kind === "triangle") points.push(left);
  return points;
}

function sampleSegment(start, end, roughness, control) {
  if (!roughness && !control) return [start, end];
  const [x, y] = start;
  const dx = end[0] - x, dy = end[1] - y;
  const length = Math.hypot(dx, dy);
  if (!length) return [start, end];
  const steps = control ? Math.min(24, Math.max(4, Math.ceil(Math.sqrt(length)) * 2)) : 8;
  const middle = control ?? [x + dx / 2, y + dy / 2];
  const amplitude = Math.min(length / 12, 3 * roughness) / length;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const from = (1 - t) ** 2;
    const through = 2 * t * (1 - t);
    const to = t ** 2;
    const wave = Math.sin(t * Math.PI * 2) * amplitude;
    return [
      x * from + middle[0] * through + end[0] * to - dy * wave,
      y * from + middle[1] * through + end[1] * to + dx * wave,
    ];
  });
}

function arrowPaths({ start, end, style = {} }) {
  const { route, roughness = 0, start_head: startHead = "none", end_head: endHead = "arrow" } = style;
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (!length) return [[start, end]];
  const midX = (start[0] + end[0]) / 2, midY = (start[1] + end[1]) / 2;
  let shaft;
  if (route === "elbow" && dx && dy) {
    const corners = Math.abs(dx) >= Math.abs(dy)
      ? [[midX, start[1]], [midX, end[1]]]
      : [[start[0], midY], [end[0], midY]];
    const [first, second] = corners;
    shaft = sampleSegment(start, first, roughness)
      .concat(sampleSegment(first, second, roughness).slice(1), sampleSegment(second, end, roughness).slice(1));
  } else if (route === "curved") {
    const bend = Math.min(0.36, 160 / length);
    const control = [midX - dy * bend, midY + dx * bend];
    // Bend inward when the default direction would cross the scene origin.
    if (start.every(coordinate => coordinate >= 0) && end.every(coordinate => coordinate >= 0)
        && control.some(coordinate => coordinate < 0)) {
      control[0] = midX + dy * bend;
      control[1] = midY - dx * bend;
    }
    shaft = sampleSegment(start, end, roughness, control);
  } else {
    shaft = sampleSegment(start, end, roughness);
  }
  const size = Math.min(18, length / 2);
  const heads = [arrowhead(startHead, shaft[1], start, size), arrowhead(endHead, shaft.at(-2), end, size)];
  return [shaft, ...heads.filter(head => head.length)];
}

function corners({ left, top, right, bottom }) {
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

function diamondCorners({ left, top, right, bottom }) {
  const midX = (right + left) / 2, midY = (bottom + top) / 2;
  return [[midX, top], [right, midY], [midX, bottom], [left, midY]];
}

function pathData(points) {
  return "M" + points.map(([x, y]) => x + " " + y).join("L");
}

function toward([x, y], [otherX, otherY], distance) {
  const length = Math.hypot(otherX - x, otherY - y);
  return [x + (otherX - x) * distance / length, y + (otherY - y) * distance / length];
}

function lineVertices({ start, end, vertices = [] }) {
  return [start, ...vertices, end];
}

function lineOutline(element) {
  const { closed, style = {} } = element;
  const points = lineVertices(element).filter(([x, y], i, vertices) =>
    i === 0 || x !== vertices[i - 1][0] || y !== vertices[i - 1][1]);
  const first = points[0];
  if (closed && points.length > 1 && first.every((value, i) => value === points.at(-1)[i])) points.pop();
  if (points.length < 2) return [first, first];
  const lastSegment = closed ? points.length : points.length - 1;
  const joins = points.map((point, i) => {
    if (style.edges !== "rounded" || (!closed && (i === 0 || i === lastSegment))) {
      return { incoming: point, outgoing: point };
    }
    const previous = points.at(i - 1);
    const next = points[(i + 1) % points.length];
    const radius = Math.min(18,
      Math.hypot(point[0] - previous[0], point[1] - previous[1]) / 3,
      Math.hypot(point[0] - next[0], point[1] - next[1]) / 3);
    return { incoming: toward(point, previous, radius), outgoing: toward(point, next, radius) };
  });
  const outline = [joins[0].incoming];
  for (let i = 0; i < lastSegment; i++) {
    const { incoming, outgoing } = joins[i];
    if (incoming !== outgoing) {
      for (const point of sampleSegment(incoming, outgoing, 0, points[i]).slice(1)) outline.push(point);
    }
    const next = joins[(i + 1) % joins.length].incoming;
    for (const point of sampleSegment(outgoing, next, style.roughness ?? 0).slice(1)) outline.push(point);
  }
  return outline;
}

function polygonOutline(vertices, radius, roughness) {
  const incoming = vertices.map((point, i) => toward(point, vertices.at(i - 1), radius));
  const outgoing = vertices.map((point, i) => toward(point, vertices[(i + 1) % vertices.length], radius));
  let path = "M" + incoming[0].join(" ");
  vertices.forEach((point, i) => {
    if (radius) path += "Q" + point.join(" ") + " " + outgoing[i].join(" ");
    const [x, y] = outgoing[i];
    const end = incoming[(i + 1) % vertices.length];
    const dx = end[0] - x;
    const dy = end[1] - y;
    if (roughness) {
      const length = Math.hypot(dx, dy);
      const wobble = Math.min(0.15, 4 * roughness / length) * (i % 2 ? -1 : 1);
      const first = [x + dx / 3 - dy * wobble, y + dy / 3 + dx * wobble];
      const second = [x + dx * 2 / 3 + dy * wobble, y + dy * 2 / 3 - dx * wobble];
      path += "C" + first.join(" ") + " " + second.join(" ") + " " + end.join(" ");
    } else {
      path += "L" + end.join(" ");
    }
  });
  return path + "Z";
}

function sketchEllipse(cx, cy, rx, ry, roughness) {
  const x = rx * 0.552;
  const y = ry * 0.552;
  const wobble = Math.min(4, Math.min(rx, ry) * 0.05) * roughness;
  return `M ${cx} ${cy - ry}
    C ${cx + x} ${cy - ry + wobble} ${cx + rx + wobble} ${cy - y} ${cx + rx} ${cy}
    C ${cx + rx - wobble} ${cy + y} ${cx + x} ${cy + ry + wobble} ${cx} ${cy + ry}
    C ${cx - x} ${cy + ry - wobble} ${cx - rx - wobble} ${cy + y} ${cx - rx} ${cy}
    C ${cx - rx + wobble} ${cy - y} ${cx - x} ${cy - ry - wobble} ${cx} ${cy - ry} Z`;
}

function renderShape(type, box, width, height, style = {}) {
  const roughness = style.roughness ?? 0;
  const radius = style.edges === "rounded" ? Math.min(18, width * 0.18, height * 0.18) : 0;
  if (type === "ellipse") {
    const rx = width / 2, ry = height / 2;
    const cx = box.left + rx, cy = box.top + ry;
    return roughness ? svg("path", { d: sketchEllipse(cx, cy, rx, ry, roughness) })
      : svg("ellipse", { cx, cy, rx, ry });
  }
  if (type === "rectangle" && !roughness) {
    return svg("rect", { x: box.left, y: box.top, width, height, rx: radius });
  }
  const vertices = type === "diamond" ? diamondCorners(box) : corners(box);
  return svg("path", { d: polygonOutline(vertices, radius, roughness) });
}

export function drawingTextLayout({ text, style }) {
  const fontSize = TEXT_SIZES[style?.font_size ?? "s"];
  const fontFamily = TEXT_FAMILIES[style?.font_family ?? "normal"];
  const lineHeight = fontSize * 1.25;
  const align = style?.text_align ?? "left";
  const lines = text.split("\n");
  textContext ??= document.createElement("canvas").getContext("2d");
  textContext.font = fontSize + "px " + fontFamily;
  let width = 0;
  for (const line of lines) width = Math.max(width, textContext.measureText(line).width);
  return { fontSize, fontFamily, lineHeight, align, lines, width, height: lines.length * lineHeight };
}

function renderText(element) {
  const { at: [x, y], style } = element;
  const { fontSize, fontFamily, lineHeight, align, lines, width } = drawingTextLayout(element);
  const anchors = { left: "start", center: "middle", right: "end" };
  const textX = x + ({ left: 0, center: width / 2, right: width })[align];
  const node = svg("text", {
    "font-size": fontSize, "font-family": fontFamily, "text-anchor": anchors[align],
    fill: style?.stroke ?? "currentColor", stroke: "none", opacity: (style?.opacity ?? 100) / 100,
  });
  node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  lines.forEach((line, index) => {
    const span = svg("tspan", { x: textX, y: y + fontSize + index * lineHeight });
    span.textContent = line;
    node.append(span);
  });
  return node;
}

function strokeWidth(style) {
  return [1.5, 2.5, 5][(style?.width ?? 2) - 1];
}

export function simulatedPencilPressure([x, y], [nextX, nextY], unitsPerPixel = 1) {
  return Math.round(255 / (1 + Math.hypot(nextX - x, nextY - y) / (8 * unitsPerPixel)));
}

function pressureOutline({ points, pressures, style }, unitsPerPixel) {
  const width = strokeWidth(style) * unitsPerPixel;
  const radiusFor = pressure => width * (0.4 + 1.2 * pressure / 255) / 2;
  let radius = radiusFor(pressures?.[0] ?? 128);
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${x + radius} ${y}a${radius} ${radius} 0 1 0 ${-2 * radius} 0a${radius} ${radius} 0 1 0 ${2 * radius} 0Z`;
  }
  const firstRadius = radius;
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(i + 1, points.length - 1)];
    if (i) radius = 0.48 * radius + 0.52 * radiusFor(pressures?.[i] ?? simulatedPencilPressure(previous, point));
    let dx = next[0] - previous[0], dy = next[1] - previous[1];
    if (!dx && !dy) {
      dx = point[0] - previous[0];
      dy = point[1] - previous[1];
    }
    const scale = radius / (Math.hypot(dx, dy) || 1);
    const [x, y] = point;
    left.push([x - dy * scale, y + dx * scale]);
    right.push([x + dy * scale, y - dx * scale]);
  }
  const endCap = `A${radius} ${radius} 0 0 0 ${right.at(-1).join(" ")}`;
  const startCap = `A${firstRadius} ${firstRadius} 0 0 0 ${left[0].join(" ")}`;
  return pathData(left) + endCap + "L" + right.reverse().slice(1).map(point => point.join(" ")).join("L") + startCap + "Z";
}

export function updatePencilStroke(node, element, unitsPerPixel, commands = pathData(element.points)) {
  const shaft = node.lastElementChild ?? node;
  if (element.style?.fill) node.firstElementChild.setAttribute("d", commands + "Z");
  shaft.setAttribute("d", element.style?.pressure === "variable"
    ? pressureOutline(element, unitsPerPixel)
    : commands + (element.points.length === 1 ? "l0 0" : ""));
}

function renderPencil(element, unitsPerPixel) {
  const { style } = element;
  const shaft = svg("path", { "vector-effect": "non-scaling-stroke" });
  let node = shaft;
  if (style?.fill) {
    node = svg("g", {});
    node.append(svg("path", { fill: style.fill, stroke: "none", "fill-rule": "evenodd" }), shaft);
  }
  if (style?.pressure === "variable") {
    shaft.setAttribute("fill", style.stroke ?? "currentColor");
    shaft.setAttribute("stroke", "none");
  }
  updatePencilStroke(node, element, unitsPerPixel);
  return node;
}

export function renderElement(element, unitsPerPixel = 1) {
  let node;
  if (element.type === "pencil") {
    node = renderPencil(element, unitsPerPixel);
  } else if (element.type === "text") {
    node = renderText(element);
  } else {
    const { start, end, type } = element;
    const box = boundsOf([start, end]);
    const width = box.right - box.left, height = box.bottom - box.top;
    if (type === "image") {
      node = svg("image", {
        x: box.left, y: box.top, width, height, href: element.src,
        role: "img", "aria-label": element.alt || "Image",
      });
    } else if (type === "arrow") {
      const [shaft, ...heads] = arrowPaths(element);
      node = svg("g", {});
      node.append(svg("path", { d: pathData(shaft), "vector-effect": "non-scaling-stroke" }));
      if (heads.length) {
        node.append(svg("path", {
          d: heads.map(pathData).join(""),
          "stroke-dasharray": "none",
          "vector-effect": "non-scaling-stroke",
        }));
      }
    } else if (type === "line") {
      node = svg("path", {
        d: pathData(lineOutline(element)) + (element.closed ? "Z" : ""),
        "fill-rule": "evenodd",
        "stroke-linecap": element.style?.edges === "rounded" ? "round" : "butt",
        "stroke-linejoin": element.style?.edges === "rounded" ? "round" : "miter",
      });
    } else if (!width || !height) {
      node = svg("path", { d: pathData([start, end]) });
    } else {
      node = renderShape(type, box, width, height, element.style);
    }
  }
  node.dataset.elementId = element.id;
  node.dataset.type = element.type;
  if (element.type !== "text") node.setAttribute("vector-effect", "non-scaling-stroke");
  if (element.style && element.type !== "text") {
    const { stroke, fill, pattern, opacity, pressure } = element.style;
    const size = strokeWidth(element.style);
    if (stroke && pressure !== "variable") node.setAttribute("stroke", stroke);
    if (fill && element.type !== "pencil" && (element.type !== "line" || element.closed)) node.setAttribute("fill", fill);
    node.setAttribute("stroke-width", size);
    if (pattern === "dashed") node.setAttribute("stroke-dasharray", `${size * 3} ${size * 2.5}`);
    if (pattern === "dotted") node.setAttribute("stroke-dasharray", `0 ${size * 2.5}`);
    if (opacity !== undefined) node.setAttribute("opacity", opacity / 100);
  }
  return node;
}

export function elementBounds(element) {
  if (element.type === "pencil") return boundsOf(element.points);
  if (element.type === "text") {
    const [left, top] = element.at;
    const { width, height } = drawingTextLayout(element);
    return { left, top, right: left + width, bottom: top + height };
  }
  if (element.type === "arrow") return boundsOf(arrowPaths(element).flat());
  if (element.type === "line") return boundsOf(lineVertices(element).concat(lineOutline(element)));
  return boundsOf([element.start, element.end]);
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(value, upper));
}

// Distance to a finite segment, including the one-point stroke left by a tap.
function distanceToSegment([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const projection = (x - x1) * dx + (y - y1) * dy;
  if (projection <= 0) return Math.hypot(x - x1, y - y1);
  if (projection >= lengthSq) return Math.hypot(x - x2, y - y2);
  return Math.abs((x - x1) * dy - (y - y1) * dx) / Math.sqrt(lengthSq);
}

function side([ax, ay], [bx, by], [cx, cy]) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsMeet(a, b, c, d, tolerance) {
  // A cross can land far from all four endpoints when the eraser moves quickly.
  if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
  return distanceToSegment(a, c, d) <= tolerance || distanceToSegment(b, c, d) <= tolerance
    || distanceToSegment(c, a, b) <= tolerance || distanceToSegment(d, a, b) <= tolerance;
}

function insideBox([x, y], { left, top, right, bottom }) {
  return x >= left && x <= right && y >= top && y <= bottom;
}

function insidePolygon([x, y], points) {
  let inside = false;
  for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
    const [x1, y1] = points[previous], [x2, y2] = points[i];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

export function hitsSegment(element, from, to, tolerance = 6) {
  const arrow = element.type === "arrow" ? arrowPaths(element) : null;
  const line = element.type === "line" ? lineOutline(element) : null;
  const box = arrow ? boundsOf(arrow.flat()) : line ? boundsOf(line) : elementBounds(element);
  if (Math.max(from[0], to[0]) < box.left - tolerance || Math.min(from[0], to[0]) > box.right + tolerance
      || Math.max(from[1], to[1]) < box.top - tolerance || Math.min(from[1], to[1]) > box.bottom + tolerance) return false;

  const near = (a, b) => segmentsMeet(from, to, a, b, tolerance);
  const { type, start, end } = element;
  if (type === "pencil") {
    const points = element.points;
    if (points.length === 1) return distanceToSegment(points[0], from, to) <= tolerance;
    if (element.style?.fill && points.length >= 3 && (insidePolygon(from, points) || near(points.at(-1), points[0]))) return true;
    return points.some((p, i) => i > 0 && near(points[i - 1], p));
  }
  if (line) {
    if (element.closed && element.style?.fill && insidePolygon(from, line)) return true;
    return line.some((point, i) => i > 0 && near(line[i - 1], point));
  }
  if (arrow) return arrow.some(path => path.some((point, i) => i > 0 && near(path[i - 1], point)));

  const rx = (box.right - box.left) / 2, ry = (box.bottom - box.top) / 2;
  const cx = box.left + rx, cy = box.top + ry;
  if (type === "ellipse") {
    if (!rx || !ry) return near(start, end);
    // Scaling the ellipse to a unit circle makes a full segment hit test possible.
    const normalize = ([x, y]) => [(x - cx) / (rx + tolerance), (y - cy) / (ry + tolerance)];
    return distanceToSegment([0, 0], normalize(from), normalize(to)) <= 1;
  }
  let outline;
  if (type === "diamond") {
    if (!rx || !ry) return near(start, end);
    if (Math.abs((from[0] - cx) / rx) + Math.abs((from[1] - cy) / ry) <= 1) return true;
    outline = diamondCorners(box);
  } else {
    if (insideBox(from, box)) return true;
    outline = corners(box);
  }
  return outline.some((p, i) => near(p, outline[(i + 1) % outline.length]));
}

export function hitTest(element, point, tolerance = 6) {
  return hitsSegment(element, point, point, tolerance);
}

function transformPoints(element, transform) {
  if (element.type === "pencil") return { ...element, points: element.points.map(transform) };
  if (element.type === "text") return { ...element, at: transform(element.at) };
  if (element.vertices) {
    return { ...element, start: transform(element.start), end: transform(element.end), vertices: element.vertices.map(transform) };
  }
  return { ...element, start: transform(element.start), end: transform(element.end) };
}

export function moveElement(element, dx, dy, view = SQUARE_VIEW) {
  const { left, top, right, bottom } = elementBounds(element);
  // Text may already extend past the page. A drag can bring it back gradually.
  dx = clamp(Math.round(dx), Math.min(0, Math.ceil(view.left - left)), Math.max(0, Math.floor(view.right - right)));
  dy = clamp(Math.round(dy), Math.min(0, Math.ceil(view.top - top)), Math.max(0, Math.floor(view.bottom - bottom)));
  if (!dx && !dy) return element;
  return transformPoints(element, ([x, y]) => [x + dx, y + dy]);
}

export function selectionHandles(element) {
  if (element.type === "text") return [];
  if (element.type === "line" || element.type === "arrow") {
    return [
      { name: "start", point: element.start },
      ...(element.vertices ?? []).map((point, index) => ({ name: `vertex-${index}`, point })),
      { name: "end", point: element.end },
    ];
  }
  const box = elementBounds(element);
  const points = corners(box);
  if (box.left === box.right && box.top === box.bottom) return [];
  if (box.left === box.right || box.top === box.bottom) {
    return [{ name: "nw", point: points[0] }, { name: "se", point: points[2] }];
  }
  return ["nw", "ne", "se", "sw"].map((name, i) => ({ name, point: points[i] }));
}

export function resizeElement(element, handle, [x, y], view = SQUARE_VIEW) {
  const target = [
    clamp(Math.round(x), view.left, view.right),
    clamp(Math.round(y), view.top, view.bottom),
  ];
  if (handle === "start" || handle === "end") return { ...element, [handle]: target };
  if (handle.startsWith("vertex-")) {
    const vertices = element.vertices.slice();
    vertices[Number(handle.slice(7))] = target;
    return { ...element, vertices };
  }
  const box = elementBounds(element);
  const west = handle.endsWith("w"), north = handle.startsWith("n");
  const fixedX = west ? box.right : box.left, fixedY = north ? box.bottom : box.top;
  const spanX = (west ? box.left : box.right) - fixedX, spanY = (north ? box.top : box.bottom) - fixedY;
  if (element.type === "image") {
    const width = Math.abs(spanX);
    const height = Math.abs(spanY);
    const desiredX = target[0] - fixedX;
    const desiredY = target[1] - fixedY;
    const requested = (spanX * desiredX + spanY * desiredY) / (width * width + height * height);
    const maxWidth = west ? fixedX - view.left : view.right - fixedX;
    const maxHeight = north ? fixedY - view.top : view.bottom - fixedY;
    const scale = clamp(requested, Math.max(1 / width, 1 / height), Math.min(maxWidth / width, maxHeight / height));
    const otherX = fixedX + Math.round(spanX * scale);
    const otherY = fixedY + Math.round(spanY * scale);
    return {
      ...element,
      start: [Math.min(fixedX, otherX), Math.min(fixedY, otherY)],
      end: [Math.max(fixedX, otherX), Math.max(fixedY, otherY)],
    };
  }
  if (!spanX && !spanY) return element;
  return transformPoints(element, ([x, y]) => {
    // An exactly vertical or horizontal stroke can also be pulled diagonally.
    const xPart = spanX ? (x - fixedX) / spanX : (y - fixedY) / spanY;
    const yPart = spanY ? (y - fixedY) / spanY : xPart;
    return [Math.round(fixedX + xPart * (target[0] - fixedX)), Math.round(fixedY + yPart * (target[1] - fixedY))];
  });
}
