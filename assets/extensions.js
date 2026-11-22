const STORAGE_KEY = "grapho-extensions";
let enabled = loadExtensions();

function loadExtensions() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

export function extensionEnabled(name) {
  return enabled.has(name);
}

export function setExtensionEnabled(name, checked) {
  if (checked) enabled.add(name);
  else enabled.delete(name);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabled]));
  } catch {
    // A transient preference still works on the current page.
  }
}

export function onExtensionsChange(callback) {
  function refresh() {
    enabled = loadExtensions();
    callback();
  }
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) refresh();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refresh();
  });
}
