// Run the actual editor page in its own frame. Only the document writes are
// intercepted so each test controls exactly when a save succeeds or fails.
const tests = (window.__extraTests ||= []);

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitFor(check, description) {
  const deadline = performance.now() + 12000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for " + description);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function draftTest(name, run) {
  async function checkDraft() {
    const id = crypto.randomUUID();
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:absolute;left:-10000px;width:800px;height:600px";
    frame.src = "/doc/new/" + id;
    document.body.append(frame);
    try {
      const win = frame.contentWindow;
      await waitFor(() => win.document.querySelector('#paper[aria-busy="false"]'), "the draft to load");
      const doc = win.document;
      const input = doc.getElementById("docInput");
      const title = doc.getElementById("documentTitle");
      const status = doc.getElementById("saveStatus");
      const requests = [];
      const originalFetch = win.fetch.bind(win);
      win.fetch = (url, options) => {
        if (options?.method !== "PUT") return originalFetch(url, options);
        return new Promise((resolve, reject) => {
          requests.push({
            url, payload: JSON.parse(options.body),
            succeed: () => resolve(Response.json({ id })),
            fail: () => reject(new TypeError("Connection lost")),
          });
        });
      };
      function type(text) {
        input.value = text;
        input.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      function shortcut(key) {
        input.dispatchEvent(new win.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
      }
      await run({ id, win, doc, title, status, requests, type, shortcut });
    } finally {
      frame.remove();
    }
  }
  tests.push({ name: "autosave: " + name, fn: checkDraft });
}

draftTest("edits made during the first save reach the same document in order", async ({
  id, win, title, requests, type, shortcut,
}) => {
  type("Opening");
  shortcut("s");
  equal(requests.length, 1, "first save started");
  equal(requests[0].url, "/api/documents/" + id + "/draft", "first save target");
  equal(requests[0].payload.content, "<p>Opening</p>", "first snapshot");

  type(" revised");
  title.value = "Final draft";
  title.dispatchEvent(new win.Event("input", { bubbles: true }));
  shortcut("s");
  equal(requests.length, 1, "a second save waits for the first");
  requests[0].succeed();

  await waitFor(() => requests.length === 2, "the queued autosave");
  equal(win.location.pathname, "/doc/" + id, "canonical document URL");
  equal(requests[1].url, "/api/documents/" + id, "follow-up save target");
  equal(requests[1].payload.content, "<p>Opening revised</p>", "latest body");
  equal(requests[1].payload.title, "Final draft", "latest title");
  requests[1].succeed();
});

draftTest("a failed save retries automatically even when the writer stops typing", async ({
  id, win, status, requests, type, shortcut,
}) => {
  type("café");
  type(" com leite");
  shortcut("s");
  requests[0].fail();
  await waitFor(() => !status.hidden, "save failure feedback");
  equal(win.location.pathname, "/doc/new/" + id, "unsaved draft URL");
  await waitFor(() => requests.length === 2, "automatic retry");
  equal(requests[1].url, requests[0].url, "retry uses the same draft ID");
  equal(requests[1].payload.content, "<p>café com leite</p>", "retry preserves the full draft");
  requests[1].succeed();
  await waitFor(() => status.hidden && win.location.pathname === "/doc/" + id, "save recovery");
});

draftTest("leaving during a save waits for the last edit to be acknowledged", async ({
  id, win, doc, requests, type, shortcut,
}) => {
  type("Chapter one");
  shortcut("s");
  type(" ends here.");
  doc.getElementById("documentMenuButton").click();
  doc.getElementById("shortcutsLink").click();
  equal(requests.length, 1, "the first save is still in flight");
  equal(win.location.pathname, "/doc/new/" + id, "navigation waits");
  requests[0].succeed();
  await waitFor(() => requests.length === 2, "save of the last edit");
  equal(requests[1].url, "/api/documents/" + id, "last edit goes to the saved document");
  equal(requests[1].payload.content, "<p>Chapter one ends here.</p>", "complete text before leaving");
  equal(win.location.pathname, "/doc/" + id, "the document stays open until the last save completes");
  requests[1].succeed();
  await waitFor(() => win.document.getElementById("shortcutsTitle"), "the shortcuts page after the last save");
  equal(win.location.pathname, "/shortcuts", "requested destination");
});

draftTest("failed saves keep the writer on the page and the retry button saves later edits", async ({
  id, win, doc, status, requests, type,
}) => {
  type("Keep this draft");
  doc.getElementById("backToLibrary").click();
  await waitFor(() => requests.length === 1, "save before leaving");
  requests[0].fail();
  await waitFor(() => requests.length === 2, "the second save attempt before leaving");
  requests[1].fail();
  await waitFor(() => doc.getElementById("toast").textContent.includes("before leaving"), "navigation failure feedback");
  equal(win.location.pathname, "/doc/new/" + id, "editor stays open");
  equal(status.hidden, false, "retry is available");
  type(" here.");
  status.click();
  equal(requests.length, 3, "manual retry started");
  equal(requests[2].payload.content, "<p>Keep this draft here.</p>", "writer can keep editing after the failure");
  requests[2].succeed();
  await waitFor(() => status.hidden && win.location.pathname === "/doc/" + id, "manual retry to finish");
});

draftTest("undoing the only text skips an empty draft save and a title alone can then save it", async ({
  id, win, title, requests, type, shortcut,
}) => {
  type("temporary");
  shortcut("z");
  shortcut("s");
  equal(requests.length, 0, "an empty untitled draft makes no request");
  equal(win.location.pathname, "/doc/new/" + id, "draft stays editable");
  title.value = "Ideas for tomorrow";
  title.dispatchEvent(new win.Event("input", { bubbles: true }));
  shortcut("s");
  equal(requests.length, 1, "title-only document is saved");
  equal(requests[0].payload.title, "Ideas for tomorrow", "chosen title");
  equal(requests[0].payload.content, "", "empty body");
  requests[0].succeed();
  await waitFor(() => win.location.pathname === "/doc/" + id, "title-only draft to finish saving");
});
