// Extensions are switched on the Grapho server, not in this browser. The
// library's Extensions dialog writes /api/extensions and every page reads the
// current answer, so signing in from another computer shows the same switches.
const ENDPOINT = "/api/extensions";

let enabled = new Set();
let loaded = false;
let refreshing = null;
let writeQueue = Promise.resolve();
const listeners = [];
// Switches changed here whose save has not finished yet. They win over a
// refresh answer that was already on its way when the person clicked.
const pending = new Map();
// When each switch was last changed here, so a slow refresh cannot overwrite a
// newer save with the answer it carried from before that save.
let changeSerial = 0;
const changedAt = new Map();

export function extensionEnabled(name) {
  return enabled.has(name);
}

export function onExtensionsChange(callback) {
  listeners.push(callback);
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) refreshExtensions();
});

function notify() {
  for (const callback of listeners) callback();
}

function apply(switches, askedAt) {
  const next = new Set();
  for (const name of Object.keys(switches)) {
    const answered = (changedAt.get(name) ?? 0) <= askedAt;
    const on = answered ? switches[name] === true : enabled.has(name);
    if (on) next.add(name);
  }
  for (const [name, checked] of pending) {
    if (checked) next.add(name);
    else next.delete(name);
  }
  enabled = next;
  loaded = true;
  notify();
}

// One request at a time: a page load, an opened dialog, and a restored history
// entry can all ask, and they should share the answer.
function refresh() {
  if (refreshing) return refreshing;
  const askedAt = changeSerial;
  refreshing = (async () => {
    try {
      const response = await fetch(ENDPOINT, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.ok) apply(await response.json(), askedAt);
    } catch {
      // Keep the last answer. A page still works with the switches it has.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export function loadExtensions() {
  return loaded ? Promise.resolve() : refresh();
}

export function refreshExtensions() {
  return refresh();
}

export function setExtensionEnabled(name, checked) {
  if (checked) enabled.add(name);
  else enabled.delete(name);
  pending.set(name, checked);
  changedAt.set(name, ++changeSerial);

  // Writes go out in order. A failed one restores the server's answer instead
  // of leaving the checkbox showing something that was not saved.
  const saving = writeQueue.then(async () => {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ [name]: checked }),
      });
    } catch {
      settleWrite(name, checked);
      changedAt.delete(name);
      await refresh();
      throw switchError("Couldn't reach Grapho. Check that the server is still running.");
    }
    if (response.status === 401) {
      settleWrite(name, checked);
      changedAt.delete(name);
      const next = window.location.pathname + window.location.search;
      window.location.assign("/login?next=" + encodeURIComponent(next));
      throw switchError("Your session ended. Sign in again.");
    }
    if (!response.ok) {
      settleWrite(name, checked);
      changedAt.delete(name);
      await refresh();
      let message = "That extension couldn't be changed. Try again.";
      try {
        const payload = await response.json();
        if (payload && payload.error) message = payload.error;
      } catch {
        // Keep the friendly fallback when the server sends no JSON.
      }
      throw switchError(message);
    }
    settleWrite(name, checked);
  });

  // Keep the chain alive after a failure; the caller handles the returned
  // promise.
  writeQueue = saving.catch(() => {});
  return saving;
}

function settleWrite(name, checked) {
  // A newer click for the same switch owns the pending value now.
  if (pending.get(name) === checked) pending.delete(name);
}

function switchError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

// Pages import this module because they need the switches, so read them as
// soon as the script graph loads rather than waiting for each page to ask.
refresh();
