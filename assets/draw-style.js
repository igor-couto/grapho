import { isStyledShape } from "./draw-geometry.js";

const defaults = {
  stroke: null, fill: null, width: 2, pattern: "solid", roughness: 0, edges: "sharp", opacity: 100,
  route: "straight", start_head: "none", end_head: "arrow", pressure: "uniform",
  font_family: "normal", font_size: "s", text_align: "left",
};
const arrowFields = new Set(["route", "start_head", "end_head"]);
const pencilFields = new Set([undefined, "stroke", "fill", "width", "pressure", "opacity"]);
const textOnlyFields = new Set(["font_family", "font_size", "text_align"]);
const textFields = new Set([undefined, "stroke", "opacity", "layers", ...textOnlyFields]);
const headChoices = [["", "Mixed"], ["none", "None"], ["arrow", "Arrow"], ["triangle", "Triangle"], ["bar", "Bar"]];
const colors = {
  stroke: [[null, "Default ink"], ["#d94b58", "Red"], ["#299456", "Green"], ["#307bd2", "Blue"], ["#bf720b", "Amber"]],
  fill: [[null, "Transparent"], ["#f5a0a4", "Red"], ["#9ccba9", "Green"], ["#9fc4ed", "Blue"], ["#f0c879", "Amber"]],
};
const choices = {
  width: [[1, "Thin", "M4 12h16", 1.4], [2, "Medium", "M4 12h16", 2.6], [3, "Thick", "M4 12h16", 4.5]],
  pattern: [
    ["solid", "Solid", "M4 12h16"],
    ["dashed", "Dashed", "M3 12h4m3 0h4m3 0h4"],
    ["dotted", "Dotted", "M4 12h.01m4 0h.01m4 0h.01m4 0h.01m4 0h.01"],
  ],
  roughness: [
    [0, "Precise", "M3 15 21 9"],
    [1, "Sketchy", "M3 15c5 1 5-5 10-5s4 1 8-1"],
    [2, "Rough", "M3 16c5 1 4-8 9-7s4 5 9-2"],
  ],
  pressure: [
    ["uniform", "Uniform pressure", "M3 14c4 0 4-5 7-5s4 6 7 6 3-5 4-6"],
    ["variable", "Pressure sensitive", "M3 14c4 0 4-5 7-5s4 6 7 6 3-5 4-6m-12 1c2 0 4 5 7 5", 2],
  ],
  edges: [["sharp", "Sharp corners", "M5 19V5h14"], ["rounded", "Rounded corners", "M5 19v-7a7 7 0 0 1 7-7h7"]],
  route: [
    ["straight", "Straight arrow", "M5 19 19 5m-7 0h7v7"],
    ["curved", "Curved arrow", "M4 18q2-12 16-12m-5-3 5 3-4 5"],
    ["elbow", "Elbow arrow", "M4 18h8V6h8m-4-4 4 4-4 4"],
  ],
  font_family: [
    ["hand_drawn", "Hand-drawn", "M4 16 15.5 4.5l4 4L8 20H4zm9-9 4 4"],
    ["normal", "Normal", "M6 20V9a6 6 0 0 1 12 0v11M6 13h12"],
    ["code", "Code", "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"],
  ],
  font_size: [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large"]],
  text_align: [
    ["left", "Align left", "M4 7h16M4 12h11M4 17h8"],
    ["center", "Align center", "M4 7h16m-13 5h10m-9 5h8"],
    ["right", "Align right", "M4 7h16m-11 5h11m-8 5h8"],
  ],
  layers: [
    ["back", "Send to back", "M12 3v12m-4-4 4 4 4-4M4 20h16"],
    ["backward", "Send backward", "M12 4v15m-5-5 5 5 5-5"],
    ["forward", "Bring forward", "M12 20V5m-5 5 5-5 5 5"],
    ["front", "Bring to front", "M12 21V9m-4 4 4-4 4 4M4 4h16"],
  ],
};

function supportsStyle(type, key) {
  if (type === "text") return textFields.has(key);
  if (textOnlyFields.has(key)) return false;
  if (type === "pencil") return pencilFields.has(key);
  if (key === "pressure") return false;
  if (type === "arrow") return key !== "fill" && key !== "edges";
  if (type === "line") return !arrowFields.has(key);
  return isStyledShape(type) && !arrowFields.has(key) && (key !== "edges" || type !== "ellipse");
}

function styleGroup(type) {
  return isStyledShape(type) ? "shape" : type;
}

function reorder(elements, ids, action) {
  if (action === "back" || action === "front") {
    const selected = elements.filter(item => ids.has(item.id));
    const others = elements.filter(item => !ids.has(item.id));
    return action === "back" ? [...selected, ...others] : [...others, ...selected];
  }
  const next = elements.slice();
  const step = action === "forward" ? 1 : -1;
  for (let i = step === 1 ? next.length - 2 : 1; i >= 0 && i < next.length; i -= step) {
    const neighbor = i + step;
    if (ids.has(next[i].id) && !ids.has(next[neighbor].id)) {
      [next[i], next[neighbor]] = [next[neighbor], next[i]];
    }
  }
  return next;
}

export function createDrawingStyle({ ink, getTool, getElements, selectedElements, commit, updatePreview, getEditingText, setEditingTextStyle }) {
  const panel = document.getElementById("drawingStylePanel");
  const toggle = document.getElementById("drawingStyleToggle");
  const background = document.getElementById("drawingStyleBackground");
  const width = document.getElementById("drawingStyleWidth");
  const pattern = document.getElementById("drawingStylePattern");
  const roughness = document.getElementById("drawingStyleRoughness");
  const pressure = document.getElementById("drawingStylePressure");
  const edges = document.getElementById("drawingStyleEdges");
  const arrowType = document.getElementById("drawingArrowType");
  const arrowheads = document.getElementById("drawingArrowheads");
  const textFamily = document.getElementById("drawingTextFamily");
  const textSize = document.getElementById("drawingTextSize");
  const textAlignment = document.getElementById("drawingTextAlignment");
  const layers = document.getElementById("drawingStyleLayers");
  const slider = document.getElementById("drawingStyleOpacity");
  const readout = document.getElementById("drawingStyleOpacityValue");
  const compact = matchMedia("(max-width: 640px)");
  let openOverride = null;
  const newStyles = { shape: {}, arrow: { route: "curved" }, line: {}, pencil: {}, text: {} };
  const controls = [];
  const customColors = [];

  function targets(key) {
    const editingText = getEditingText();
    return (editingText ? [editingText] : selectedElements()).filter(item => supportsStyle(item.type, key));
  }

  function currentValue(key, selected) {
    if (!selected.length) {
      const style = newStyles[styleGroup(getTool())];
      return style?.[key] ?? defaults[key];
    }
    const value = selected[0].style?.[key] ?? defaults[key];
    return selected.every(item => (item.style?.[key] ?? defaults[key]) === value) ? value : undefined;
  }

  function withValue(style, key, value) {
    const next = { ...style };
    if (value === defaults[key]) delete next[key];
    else next[key] = value;
    return Object.keys(next).length ? next : undefined;
  }

  function changeStyle(key, value) {
    const selected = targets(key);
    const editingText = getEditingText();
    if (editingText) {
      if (supportsStyle("text", key) && (editingText.style?.[key] ?? defaults[key]) !== value) {
        setEditingTextStyle(withValue(editingText.style, key, value));
      }
    } else if (getTool() !== "select") {
      const group = styleGroup(getTool());
      newStyles[group] = withValue(newStyles[group], key, value) ?? {};
      updatePreview();
    } else {
      const ids = new Set(selected.map(item => item.id));
      commit(getElements().map(item => {
        if (!ids.has(item.id) || (item.style?.[key] ?? defaults[key]) === value) return item;
        const changed = { ...item };
        const style = withValue(item.style, key, value);
        if (style) changed.style = style;
        else delete changed.style;
        return changed;
      }));
    }
    update();
  }

  function addChoice(row, key, value, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drawing-style-choice";
    button.title = label;
    button.setAttribute("aria-label", label);
    row.append(button);
    controls.push({ button, key, value });
    button.addEventListener("click", () => {
      if (key === "layers") {
        commit(reorder(getElements(), new Set(targets("layers").map(item => item.id)), value));
      } else {
        changeStyle(key, value);
      }
    });
    return button;
  }

  for (const row of panel.querySelectorAll("[data-shape-style]")) {
    const key = row.dataset.shapeStyle;
    if (colors[key]) {
      for (const [value, label] of colors[key]) {
        const button = addChoice(row, key, value, label);
        button.classList.add("is-swatch");
        if (key === "fill" && value === null) button.classList.add("is-clear");
        else button.style.setProperty("--swatch", value ?? "var(--ink)");
      }
      const input = document.createElement("input");
      input.type = "color";
      input.className = "drawing-style-color";
      const label = key === "stroke" ? "Custom stroke color" : "Custom background color";
      input.title = label;
      input.setAttribute("aria-label", label);
      row.append(input);
      customColors.push({ input, key });
      input.addEventListener("change", () => changeStyle(key, input.value));
    } else {
      for (const [value, label, path, width = 1.8] of choices[key]) {
        const button = addChoice(row, key, value, label);
        if (key === "font_size") {
          const size = document.createElement("span");
          size.textContent = value.toUpperCase();
          button.append(size);
        } else {
          button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        }
      }
    }
  }

  const headInputs = [...arrowheads.querySelectorAll("select")];
  for (const input of headInputs) {
    for (const [value, label] of headChoices) {
      const option = new Option(label, value);
      option.hidden = option.disabled = !value;
      input.add(option);
    }
    input.addEventListener("change", () => changeStyle(input.dataset.arrowhead, input.value));
  }

  function update() {
    const tool = getTool();
    const selected = targets();
    toggle.hidden = !supportsStyle(tool) && (tool !== "select" || !selected.length);
    panel.hidden = toggle.hidden || !(openOverride ?? !compact.matches);
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (toggle.hidden) return;
    const supports = key => tool === "select" ? selected.some(item => supportsStyle(item.type, key)) : supportsStyle(tool, key);
    background.hidden = !supports("fill");
    width.hidden = !supports("width");
    pattern.hidden = !supports("pattern");
    roughness.hidden = !supports("roughness");
    pressure.hidden = !supports("pressure");
    edges.hidden = !supports("edges");
    arrowType.hidden = arrowheads.hidden = !supports("route");
    textFamily.hidden = !supports("font_family");
    textSize.hidden = !supports("font_size");
    textAlignment.hidden = !supports("text_align");
    layers.hidden = !supports("layers");
    layers.disabled = !selected.length || Boolean(getEditingText());
    const values = Object.fromEntries(Object.keys(defaults).map(key => [
      key, currentValue(key, selected.filter(item => supportsStyle(item.type, key))),
    ]));
    for (const { button, key, value } of controls) {
      if (key !== "layers") button.setAttribute("aria-pressed", String(values[key] === value));
    }
    for (const { input, key } of customColors) input.value = values[key] ?? "#808080";
    for (const input of headInputs) input.value = values[input.dataset.arrowhead] ?? "";
    slider.value = values.opacity ?? defaults.opacity;
    readout.value = values.opacity === undefined ? "Mixed" : values.opacity + "%";
  }

  toggle.addEventListener("click", () => {
    openOverride = panel.hidden;
    update();
  });
  compact.addEventListener("change", update);
  slider.addEventListener("input", () => {
    readout.value = slider.value + "%";
    const editingText = getEditingText();
    if (editingText) {
      setEditingTextStyle(withValue(editingText.style, "opacity", Number(slider.value)));
      return;
    }
    const ids = new Set(targets().map(item => item.id));
    for (const node of ink.children) {
      if (ids.has(node.dataset.elementId)) node.setAttribute("opacity", Number(slider.value) / 100);
    }
  });
  slider.addEventListener("change", () => changeStyle("opacity", Number(slider.value)));

  function styleFor(type) {
    const style = Object.fromEntries(Object.entries(newStyles[styleGroup(type)] ?? {})
      .filter(([key]) => supportsStyle(type, key)));
    return Object.keys(style).length ? style : undefined;
  }

  return { update, styleFor };
}
