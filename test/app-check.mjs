// End-to-end check against the real Grapho server and browser editor.
//
// The unit suite in editor.test.js exercises the editor modules directly. This
// script checks the path they cannot: stored HTML goes through the Rust
// sanitizer, the real editor loads it, typing is saved, and a reload paints the
// same document. It expects a built binary (target/debug/grapho) and Chrome.
//
//   node test/app-check.mjs
//   GRAPHO_BIN=/path/to/grapho CHROME_PATH=/path/to/chrome node test/app-check.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHROME_START_TIMEOUT_MS = 20000;
const PAGE_TIMEOUT_MS = 30000;

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log("PASS " + name);
  } else {
    console.log("FAIL " + name + (detail ? "\n     " + detail : ""));
    failures.push(name);
  }
}

function equal(name, actual, expected) {
  check(
    name,
    Object.is(actual, expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

async function possibleBinary(candidate) {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch (error) {
    return false;
  }
}

async function findBinary() {
  const candidates = [
    process.env.GRAPHO_BIN,
    path.join(ROOT, "target", "debug", process.platform === "win32" ? "grapho.exe" : "grapho"),
    path.join(ROOT, "target", "release", process.platform === "win32" ? "grapho.exe" : "grapho"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await possibleBinary(candidate)) {
      return candidate;
    }
  }
  throw new Error("No Grapho binary found. Run `cargo build` or set GRAPHO_BIN.");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "google-chrome",
    "chromium",
  ].filter(Boolean);
  return candidates;
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch (error) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for " + url);
}

async function connectWebSocket(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  let closed = null;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    events.push(message);
  });
  socket.addEventListener("close", () => {
    closed = new Error("DevTools connection closed");
    for (const entry of pending.values()) {
      entry.reject(closed);
    }
    pending.clear();
  });
  return {
    events,
    send(method, params) {
      if (closed) {
        return Promise.reject(closed);
      }
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Page evaluation failed",
    );
  }
  return result.result ? result.result.value : undefined;
}

async function waitForPage(cdp, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(cdp, "({ href: location.href, ready: document.readyState })");
      if (state.href.startsWith(url) && state.ready === "complete") {
        return;
      }
    } catch (error) {
      // The context is replaced on navigation.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out loading " + url);
}

async function waitForEditor(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(
        cdp,
        `(() => {
          const paper = document.getElementById("paper");
          return Boolean(
            paper &&
            paper.getAttribute("aria-busy") === "false" &&
            document.querySelectorAll(".doc-content > .doc-block .doc-line").length
          );
        })()`,
      );
      if (ready) {
        return;
      }
    } catch (error) {
      // Loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The editor did not finish loading");
}

async function paintedBlocks(cdp) {
  return evaluate(
    cdp,
    `(() => Array.from(document.querySelectorAll(".doc-content > .doc-block")).map((block) => ({
      text: Array.from(block.querySelectorAll(":scope > .doc-line")).map((line) => line.textContent).join("\\n"),
      lines: block.querySelectorAll(":scope > .doc-line").length,
      code: Boolean(block.querySelector(".doc-line.is-code")),
      marker: block.querySelector(".doc-marker")?.textContent || "",
    })))()`,
  );
}

async function waitForExpression(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) {
        return true;
      }
    } catch (error) {
      // The page is navigating; try again while the deadline lasts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForNewPage(devtoolsPort, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)
      .then((response) => response.json())
      .catch(() => []);
    const found = targets.find(
      (target) => target.type === "page" && target.url.startsWith(url),
    );
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}


async function main() {
  const binary = await findBinary();
  const chromeCandidates = findChrome();
  let chrome = null;
  for (const candidate of chromeCandidates) {
    if (await possibleBinary(candidate)) {
      chrome = candidate;
      break;
    }
  }
  if (!chrome) {
    throw new Error("Chrome not found. Set CHROME_PATH.");
  }

  const port = await freePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grapho-app-data-"));
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "grapho-app-chrome-"));
  const base = `http://127.0.0.1:${port}`;
  const serverEnv = {
    ...process.env,
    GRAPHO_ADDR: `127.0.0.1:${port}`,
    GRAPHO_DATA_DIR: dataDir,
  };
  delete serverEnv.GRAPHO_PASSWORD_HASH;
  delete serverEnv.GRAPHO_PASSWORD_HASH_FILE;
  const server = spawn(binary, [], {
    env: serverEnv,
    stdio: process.env.GRAPHO_CHECK_VERBOSE ? "inherit" : "ignore",
    windowsHide: true,
  });
  server.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`Grapho server exited with code ${code}`);
    }
  });
  let browser = null;
  let cdp = null;
  let documentId = null;
  let imageDir = null;

  try {
    await waitFor(base + "/api/health", CHROME_START_TIMEOUT_MS);

    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-extensions",
        "--hide-scrollbars",
        "--no-default-browser-check",
        "--no-first-run",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profileDir,
        "--window-size=1280,900",
        base + "/",
      ],
      { stdio: "ignore", windowsHide: true },
    );

    const portFile = path.join(profileDir, "DevToolsActivePort");
    const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
    let devtoolsPort = null;
    while (Date.now() < deadline) {
      try {
        const contents = await readFile(portFile, "utf8");
        const [rawPort] = contents.trim().split("\n");
        if (rawPort) {
          devtoolsPort = Number(rawPort);
          break;
        }
      } catch (error) {
        // Chrome is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!devtoolsPort) {
      throw new Error("Chrome did not expose a DevTools port");
    }

    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) =>
      response.json(),
    );
    const page = targets.find((target) => target.type === "page");
    if (!page) {
      throw new Error("Chrome did not open a page");
    }
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await waitForPage(cdp, base + "/", CHROME_START_TIMEOUT_MS);

    const content = [
      "<p>First paragraph with  two  spaces.</p>",
      "<p></p>",
      "<p>Third paragraph.</p>",
      "<p>Line one<br>line two</p>",
      "<p>tab\there</p>",
      "<h1>A heading</h1>",
      "<ul><li>one</li><li>two</li></ul>",
      "<blockquote>A quote</blockquote>",
      "<pre>const x = 1;\n\treturn x;</pre>",
      "<p>" + "x".repeat(140) + "</p>",
      "<hr>",
    ].join("");

    documentId = await evaluate(
      cdp,
      `(async () => {
        const created = await fetch("/api/documents", { method: "POST" });
        if (!created.ok) throw new Error("create failed: " + created.status);
        const document = await created.json();
        const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Editor check", content: ${JSON.stringify(content)}, paper_width: 0 }),
        });
        if (!saved.ok) throw new Error("save failed: " + saved.status);
        return document.id;
      })()`,
    );
    check("document is created through the API", Boolean(documentId));

    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);

    // The paper starts empty until the editor paints it, so it carries a
    // loading ghost while aria-busy is true and drops it once the text is up.
    const loadingGhost = await evaluate(
      cdp,
      `(() => {
        const paper = document.getElementById("paper");
        const ghost = document.querySelector(".paper-loading");
        const prose = document.getElementById("editor");
        if (!ghost) return null;
        const whileLoaded = {
          display: getComputedStyle(ghost).display,
          prose: getComputedStyle(prose).visibility,
        };
        paper.setAttribute("aria-busy", "true");
        const whileBusy = {
          display: getComputedStyle(ghost).display,
          prose: getComputedStyle(prose).visibility,
        };
        paper.setAttribute("aria-busy", "false");
        return { whileLoaded, whileBusy };
      })()`,
    );
    check(
      "the loading ghost is gone once the document is painted",
      Boolean(loadingGhost) &&
        loadingGhost.whileLoaded.display === "none" &&
        loadingGhost.whileLoaded.prose === "visible",
      JSON.stringify(loadingGhost),
    );
    check(
      "the loading ghost stands in while the paper is busy",
      Boolean(loadingGhost) &&
        loadingGhost.whileBusy.display !== "none" &&
        loadingGhost.whileBusy.prose === "hidden",
      JSON.stringify(loadingGhost),
    );

    const longTitle = "How we decide when a draft is ready for review";
    const titleLayout = `(() => {
      const field = document.getElementById("documentTitle");
      return {
        value: field.value,
        lines: Math.round(field.clientHeight / parseFloat(getComputedStyle(field).lineHeight)),
        fits: field.scrollHeight <= field.clientHeight + 1 && field.scrollWidth <= field.clientWidth + 1,
      };
    })()`;
    equal("a short title takes one line", (await evaluate(cdp, titleLayout)).lines, 1);
    await evaluate(cdp, `document.getElementById("documentTitle").select()`);
    await cdp.send("Input.insertText", { text: longTitle });
    const desktopTitle = await evaluate(cdp, titleLayout);
    check(
      "a long title grows to fit while editing on desktop",
      desktopTitle.value === longTitle && desktopTitle.lines > 1 && desktopTitle.fits,
      JSON.stringify(desktopTitle),
    );
    await pressKey("Enter", "Enter", 13);
    equal("Enter moves from the title into the body", await evaluate(cdp, "document.activeElement.id"), "docInput");

    let blocks = await paintedBlocks(cdp);
    equal("editor paints every stored block", blocks.length, 12);
    equal("repeated spaces survive the sanitizer and reload", blocks[0].text, "First paragraph with  two  spaces.");
    equal("the empty paragraph survives", blocks[1].lines, 1);
    equal("the empty paragraph paints empty text", blocks[1].text, "");
    equal("hard breaks paint two lines", blocks[3].text, "Line one\nline two");
    equal("tabs are painted literally", blocks[4].text, "tab\there");
    equal("headings paint one line", blocks[5].text, "A heading");
    equal("list markers are painted", blocks[6].marker, "\u2022");
    equal("code keeps its newline and tab", blocks[9].text, "const x = 1;\n\treturn x;");
    equal("a divider paints no text lines", blocks[11].lines, 0);
    const dividerRules = await evaluate(cdp, `document.querySelectorAll(".doc-divider-rule").length`);
    equal("the divider's rule is painted", dividerRules, 1);

    // Heading levels stop at three, in the rich style menu as in Markdown mode.
    const styleMenu = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll("#styleMenu [data-block-style]")).map(
        (item) => item.dataset.blockStyle + ":" + item.textContent,
      )`,
    );
    check(
      "the style menu offers Heading 1 to 3 and nothing deeper",
      styleMenu.join("|") ===
        "p:Normal text|h1:Heading 1|h2:Heading 2|h3:Heading 3|quote:Quote|code:Code block",
      JSON.stringify(styleMenu),
    );

    // Exercise the real pointer and keyboard path: click after "First", type Q,
    // then drag over "paragraph" and replace it with R.
    const linePoints = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-content > .doc-block .doc-line");
        const text = line.textContent;
        const nodes = [];
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) { nodes.push(node); node = walker.nextNode(); }
        const pointAt = (offset) => {
          let remaining = offset;
          let target = nodes[nodes.length - 1];
          let targetOffset = target ? target.length : 0;
          for (const candidate of nodes) {
            if (remaining <= candidate.length) {
              target = candidate;
              targetOffset = remaining;
              break;
            }
            remaining -= candidate.length;
          }
          const range = document.createRange();
          range.setStart(nodes[0], 0);
          range.setEnd(target, targetOffset);
          const box = range.getBoundingClientRect();
          return { x: box.right, y: box.top + box.height / 2 };
        };
        const word = "paragraph";
        const start = text.indexOf(word);
        return {
          afterFirst: pointAt("First".length),
          wordStart: pointAt(start + 1),
          wordEnd: pointAt(start + word.length - 1),
          text,
        };
      })()`,
    );
    check("the first painted line has text", Boolean(linePoints.text && linePoints.text.length));

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: linePoints.afterFirst.x,
      y: linePoints.afterFirst.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: linePoints.afterFirst.x,
      y: linePoints.afterFirst.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Q",
      code: "KeyQ",
      text: "Q",
      unmodifiedText: "Q",
      windowsVirtualKeyCode: 81,
      nativeVirtualKeyCode: 81,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Q",
      code: "KeyQ",
      windowsVirtualKeyCode: 81,
      nativeVirtualKeyCode: 81,
    });

    let saved = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      saved = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${documentId}")).json())()`,
      );
      if (saved && saved.content && saved.content.includes("FirstQ paragraph")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(
      "a real click positions the caret and a real key types there",
      saved && saved.content.includes("FirstQ paragraph"),
      saved && saved.content,
    );

    const thirdLinePoints = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelectorAll(".doc-content > .doc-block")[2].querySelector(".doc-line");
        const text = line.textContent;
        const nodes = [];
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) { nodes.push(node); node = walker.nextNode(); }
        const pointAt = (offset) => {
          let remaining = offset;
          let target = nodes[nodes.length - 1];
          let targetOffset = target ? target.length : 0;
          for (const candidate of nodes) {
            if (remaining <= candidate.length) {
              target = candidate;
              targetOffset = remaining;
              break;
            }
            remaining -= candidate.length;
          }
          const range = document.createRange();
          range.setStart(nodes[0], 0);
          range.setEnd(target, targetOffset);
          const box = range.getBoundingClientRect();
          return { x: box.right, y: box.top + box.height / 2 };
        };
        const word = "paragraph";
        const start = text.indexOf(word);
        return {
          wordStart: pointAt(start),
          wordEnd: pointAt(start + word.length),
          text,
        };
      })()`,
    );
    check("the third painted line is intact", thirdLinePoints.text === "Third paragraph.");

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: thirdLinePoints.wordStart.x + 1,
      y: thirdLinePoints.wordStart.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: thirdLinePoints.wordEnd.x - 1,
      y: thirdLinePoints.wordEnd.y,
      button: "left",
      buttons: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: thirdLinePoints.wordEnd.x - 1,
      y: thirdLinePoints.wordEnd.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "R",
      code: "KeyR",
      text: "R",
      unmodifiedText: "R",
      windowsVirtualKeyCode: 82,
      nativeVirtualKeyCode: 82,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "R",
      code: "KeyR",
      windowsVirtualKeyCode: 82,
      nativeVirtualKeyCode: 82,
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      saved = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${documentId}")).json())()`,
      );
      if (saved && saved.content && saved.content.includes("<p>Third R.</p>")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(
      "a real drag selects the painted word before replacing it",
      saved && saved.content.includes("<p>Third R.</p>"),
      saved && saved.content,
    );

    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    blocks = await paintedBlocks(cdp);
    equal(
      "reload paints the mouse-and-key edits",
      blocks[0].text,
      "FirstQ paragraph with  two  spaces.",
    );
    equal("the dragged word was replaced on reload", blocks[2].text, "Third R.");
    equal("hard breaks survive the real save and reload", blocks[3].text, "Line one\nline two");
    equal("the empty paragraph survives a real save and reload", blocks[1].text, "");
    equal("the paragraph count survives a real save and reload", blocks.length, 12);
    equal("the divider survives the real save and reload", blocks[11].lines, 0);

    // Tab types four spaces at the caret instead of moving the paragraph; the
    // spaces must go through the sanitizer, the save, and the reload unchanged.
    const firstGlyph = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-content > .doc-block .doc-line");
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 0);
        const box = range.getBoundingClientRect();
        return { x: box.right, y: box.top + box.height / 2 };
      })()`,
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: firstGlyph.x + 0.5,
      y: firstGlyph.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: firstGlyph.x + 0.5,
      y: firstGlyph.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      saved = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${documentId}")).json())()`,
      );
      if (saved && saved.content && saved.content.includes("<p>    FirstQ paragraph")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(
      "Tab at the start of a paragraph saves four spaces, not an indent",
      saved && saved.content.includes("<p>    FirstQ paragraph"),
      saved && saved.content,
    );

    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    blocks = await paintedBlocks(cdp);
    equal(
      "reload paints the typed tab",
      blocks[0].text,
      "    FirstQ paragraph with  two  spaces.",
    );

    // A selection indents with spaces and Shift+Tab takes them back. Both used
    // to act on the selected text itself, so run the real keyboard and save
    // path and check what the server stored.
    const lineStarts = await evaluate(
      cdp,
      `(() => {
        const starts = [];
        document.querySelectorAll(".doc-content > .doc-block").forEach((block) => {
          const line = block.querySelector(".doc-line");
          if (!line) return;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          const node = walker.nextNode();
          const range = document.createRange();
          range.setStart(node || line, 0);
          range.setEnd(node || line, 0);
          const box = range.getBoundingClientRect();
          starts.push({ x: box.right, y: box.top + box.height / 2 });
        });
        return starts;
      })()`,
    );

    async function pressKey(key, code, virtualKeyCode, modifiers, text) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        text,
        modifiers: modifiers || 0,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        modifiers: modifiers || 0,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
      });
    }

    async function selectWholeLine(index) {
      const point = lineStarts[index];
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x + 1,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x + 1,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await pressKey("End", "End", 35, 8);
    }

    async function readSavedDocument() {
      return evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${documentId}")).json())()`,
      );
    }

    async function waitForSavedContent(probe) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        saved = await readSavedDocument();
        if (saved && saved.content && saved.content.includes(probe)) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }

    await selectWholeLine(0);
    await pressKey("Tab", "Tab", 9, 8);
    const outdented = await waitForSavedContent(
      "<p>FirstQ paragraph with  two  spaces.</p>",
    );
    check(
      "Shift+Tab outdents a selected paragraph instead of deleting it",
      outdented,
      saved && saved.content,
    );

    await pressKey("Tab", "Tab", 9, 0);
    const reindented = await waitForSavedContent(
      "<p>    FirstQ paragraph with  two  spaces.</p>",
    );
    check(
      "Tab indents the selected paragraph with spaces and saves them",
      reindented,
      saved && saved.content,
    );

    // Shift+Tab on a selection with nothing to outdent must leave it alone.
    await selectWholeLine(2);
    await pressKey("Tab", "Tab", 9, 8);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    saved = await readSavedDocument();
    check(
      "Shift+Tab with nothing to outdent leaves the selected text alone",
      Boolean(saved && saved.content && saved.content.includes("<p>Third R.</p>")),
      saved && saved.content,
    );

    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    blocks = await paintedBlocks(cdp);
    equal(
      "reload paints the indented selection",
      blocks[0].text,
      "    FirstQ paragraph with  two  spaces.",
    );
    equal("the untouched third line is still intact", blocks[2].text, "Third R.");

    // The HTML export writes the stored HTML, so the text indentation has to be
    // in it, and the exported stylesheet must not collapse it away.
    await evaluate(
      cdp,
      `(() => {
        window.__exported = [];
        const nativeCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = function (blob) {
          window.__exported.push(blob);
          return nativeCreate(blob);
        };
        return true;
      })()`,
    );
    // The menu settles in with a short animation instead of popping open. It
    // has to be brief enough that the next click never waits for it.
    const menuOpening = await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        const menu = document.getElementById("documentMenu");
        return {
          open: !menu.hidden,
          animations: menu.getAnimations().map((animation) => ({
            name: animation.animationName || "",
            duration: animation.effect ? animation.effect.getTiming().duration : 0,
          })),
        };
      })()`,
    );
    check(
      "opening a menu animates it in briefly",
      menuOpening.open &&
        menuOpening.animations.some(
          (animation) => animation.name === "menu-in" && animation.duration === 180,
        ),
      JSON.stringify(menuOpening),
    );
    await evaluate(cdp, `document.querySelector('[data-doc-action="export-html"]').click()`);
    let exportedHtml = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      exportedHtml = await evaluate(
        cdp,
        `(async () => {
          const blob = (window.__exported || [])[0];
          if (!blob) return "";
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsText(blob);
          });
        })()`,
      );
      if (exportedHtml) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(
      "the HTML export keeps the paragraph indentation",
      exportedHtml.includes("<p>    FirstQ paragraph with  two  spaces.</p>"),
      exportedHtml.slice(0, 400),
    );
    check("the HTML export keeps the full title", exportedHtml.includes(`<h1>${longTitle}</h1>`));
    check(
      "the HTML export keeps leading spaces visible",
      exportedHtml.includes("white-space:pre-wrap"),
      exportedHtml.slice(0, 1400),
    );

    // A narrow phone viewport must not gain a horizontal scrollbar from the
    // editor's absolutely positioned lines.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    const mobile = await evaluate(
      cdp,
      `({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        blocks: document.querySelectorAll(".doc-content > .doc-block").length,
        lineCount: document.querySelectorAll(".doc-line").length,
      })`,
    );
    check(
      "a 390px viewport has no horizontal overflow",
      mobile.scrollWidth <= mobile.innerWidth + 1,
      `innerWidth ${mobile.innerWidth}, scrollWidth ${mobile.scrollWidth}`,
    );
    check("the editor still paints on a narrow viewport", mobile.blocks === 12 && mobile.lineCount > 0);
    const mobileTitle = await evaluate(cdp, titleLayout);
    check(
      "the saved title wraps and fits on a 390px viewport",
      mobileTitle.value === longTitle && mobileTitle.lines > desktopTitle.lines && mobileTitle.fits,
      JSON.stringify(mobileTitle),
    );
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    // The image menu's transform buttons rewrite the picture itself, which sends
    // a brand new data URL back through the sanitizer. Check that path against
    // the real server: right-click the image, turn it, and reload.
    const imageSource = await evaluate(
      cdp,
      `(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 500;
        const context = canvas.getContext("2d");
        context.fillStyle = "#e02424";
        context.fillRect(0, 0, 400, 250);
        context.fillStyle = "#1f4fd8";
        context.fillRect(400, 250, 400, 250);
        return canvas.toDataURL("image/png");
      })()`,
    );
    const imageContent = '<p>Picture below.</p><img alt="Diagram" width="800" height="500" src="' + imageSource + '">';
    const imageDocumentId = await evaluate(
      cdp,
      `(async () => {
        const created = await fetch("/api/documents", { method: "POST" });
        if (!created.ok) throw new Error("create failed: " + created.status);
        const document = await created.json();
        const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Picture check", content: ${JSON.stringify(imageContent)}, paper_width: 0 }),
        });
        if (!saved.ok) throw new Error("save failed: " + saved.status);
        return document.id;
      })()`,
    );
    check("an image document is created through the API", Boolean(imageDocumentId));

    async function clickAt(point) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }

    async function rightClickAt(point) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "right",
        buttons: 2,
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "right",
        buttons: 0,
        clickCount: 1,
      });
    }

    function paintedImageSize() {
      return evaluate(
        cdp,
        `(() => {
          const image = document.querySelector(".doc-image");
          if (!image) return null;
          const box = image.getBoundingClientRect();
          return { width: Math.round(box.width), height: Math.round(box.height) };
        })()`,
      );
    }

    await cdp.send("Page.navigate", { url: base + "/doc/" + imageDocumentId });
    await waitForPage(cdp, base + "/doc/" + imageDocumentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);

    const originalBox = await paintedImageSize();
    check(
      "the stored image is painted wider than tall",
      Boolean(originalBox && originalBox.width > originalBox.height),
      JSON.stringify(originalBox),
    );
    const imagePoint = await evaluate(
      cdp,
      `(() => {
        const box = document.querySelector(".doc-image").getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`,
    );
    await clickAt(imagePoint);

    const leftClickState = await evaluate(
      cdp,
      `({
        menuOpen: !document.getElementById("imageMenu").hidden,
        selected: Boolean(document.querySelector(".doc-image-selection")),
      })`,
    );
    check(
      "a left click selects the image without opening its menu",
      leftClickState.menuOpen === false && leftClickState.selected === true,
      JSON.stringify(leftClickState),
    );

    // Move the caret away from the image, then right-click it: the context menu
    // alone has to select the picture and open the image menu.
    await clickAt(await evaluate(
      cdp,
      `(() => {
        const box = document.querySelector(".doc-line").getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`,
    ));
    await rightClickAt(imagePoint);

    const imageMenu = await evaluate(
      cdp,
      `(() => {
        const menu = document.getElementById("imageMenu");
        if (!menu || menu.hidden) return null;
        const buttons = Array.from(menu.querySelectorAll("[data-image-transform]"));
        const box = buttons.length ? buttons[0].getBoundingClientRect() : null;
        return {
          actions: buttons.map((button) => button.dataset.imageTransform),
          rotate: box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
          selected: Boolean(document.querySelector(".doc-image-selection")),
        };
      })()`,
    );
    check(
      "right-clicking the image selects it and opens a menu with the three transform actions",
      Boolean(imageMenu && imageMenu.rotate && imageMenu.selected) &&
        (imageMenu.actions || []).join(",") ===
          "rotate-90-clockwise,flip-horizontal,flip-vertical",
      JSON.stringify(imageMenu),
    );

    await clickAt(imageMenu.rotate);

    let turnedTag = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const stored = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${imageDocumentId}")).json())()`,
      );
      turnedTag = (String((stored && stored.content) || "").match(/<img[^>]*>/) || [""])[0];
      if (/width="500"/.test(turnedTag) && /height="800"/.test(turnedTag)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(
      "the turn is saved as new pixels with the sides swapped",
      /width="500"/.test(turnedTag) &&
        /height="800"/.test(turnedTag) &&
        /src="data:image\/png/.test(turnedTag),
      turnedTag,
    );
    check(
      "the image menu stays open for another turn",
      (await evaluate(cdp, `!document.getElementById("imageMenu").hidden`)) === true,
    );
    const turnedBox = await paintedImageSize();
    check(
      "the turned picture is painted taller than wide",
      Boolean(turnedBox && turnedBox.height > turnedBox.width),
      JSON.stringify(turnedBox),
    );

    // The corner radius field sits inside the menu, which uses arrow keys and
    // Backspace to move and delete the image. Its own keys have to survive.
    const radiusField = await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("imageRadiusInput");
        if (!input) return null;
        const box = input.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, value: input.value };
      })()`,
    );
    check("the image menu shows the corner radius", radiusField && radiusField.value === "0", JSON.stringify(radiusField));
    await clickAt(radiusField);
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
    const fieldAfterBackspace = await evaluate(
      cdp,
      `({
        value: document.getElementById("imageRadiusInput").value,
        images: document.querySelectorAll(".doc-image").length,
      })`,
    );
    check(
      "Backspace edits the radius field instead of removing the image",
      fieldAfterBackspace.value === "" && fieldAfterBackspace.images === 1,
      JSON.stringify(fieldAfterBackspace),
    );

    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("imageRadiusInput");
        input.value = "28";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`,
    );

    let radiusTag = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const stored = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${imageDocumentId}")).json())()`,
      );
      radiusTag = (String((stored && stored.content) || "").match(/<img[^>]*>/) || [""])[0];
      if (/data-radius="28"/.test(radiusTag)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check("the corner radius is saved on the image", /data-radius="28"/.test(radiusTag), radiusTag);
    check(
      "the painted image takes the corner radius",
      (await evaluate(
        cdp,
        `getComputedStyle(document.querySelector(".doc-image")).borderRadius`,
      )) === "28px",
    );

    // The placement row is the old Wrap left / Wrap right plus a middle button
    // that brings the picture back to its own line without resizing it.
    const storedImageTag = async () => {
      const stored = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${imageDocumentId}")).json())()`,
      );
      return (String((stored && stored.content) || "").match(/<img[^>]*>/) || [""])[0];
    };
    const waitForImageTag = async (predicate) => {
      let tag = "";
      for (let attempt = 0; attempt < 80; attempt += 1) {
        tag = await storedImageTag();
        if (predicate(tag)) {
          return tag;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return tag;
    };
    const clickPlacement = async (align) => {
      const point = await evaluate(
        cdp,
        `(() => {
          const box = document.querySelector('[data-image-align="${align}"]').getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        })()`,
      );
      await clickAt(point);
    };
    const placementState = () =>
      evaluate(
        cdp,
        `(() => {
          const image = document.querySelector(".doc-image");
          const editor = document.getElementById("editor");
          return {
            left: parseFloat(image.style.left),
            width: parseFloat(image.style.width),
            column: editor.clientWidth,
            menuOpen: !document.getElementById("imageMenu").hidden,
          };
        })()`,
      );

    await clickPlacement("left");
    const leftTag = await waitForImageTag((tag) => /class="wrap-left"/.test(tag));
    check("the left placement wraps the picture on the left", /class="wrap-left"/.test(leftTag), leftTag);
    const wrapped = await placementState();
    check(
      "the wrapped picture is painted at the left edge",
      Math.round(wrapped.left) === 0,
      JSON.stringify(wrapped),
    );
    const wrappedWidth = Math.round(wrapped.width);
    check(
      "the wrapped picture takes less than the column",
      wrappedWidth > 0 && wrappedWidth < wrapped.column,
      JSON.stringify(wrapped),
    );

    await clickPlacement("center");
    const centredTag = await waitForImageTag(
      (tag) => !/class=/.test(tag) && tag.includes(`data-width="${wrappedWidth}"`),
    );
    check(
      "the middle placement keeps the wrapped width",
      !/class=/.test(centredTag) && centredTag.includes(`data-width="${wrappedWidth}"`),
      centredTag,
    );
    const centred = await placementState();
    check(
      "the centred picture keeps its width and moves to the middle",
      Math.round(centred.width) === wrappedWidth &&
        Math.abs(centred.left - (centred.column - centred.width) / 2) <= 1,
      JSON.stringify(centred),
    );
    check(
      "the image menu stays open for another placement",
      centred.menuOpen === true,
      JSON.stringify(centred),
    );

    // A flip mirrors the pixels; it is not a turn, so the picture has to keep the
    // width it was painted at and the stored data-width must not move.
    const flipState = async (action) => {
      const before = await storedImageTag();
      const point = await evaluate(
        cdp,
        `(() => {
          const box = document.querySelector('[data-image-transform="${action}"]').getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        })()`,
      );
      await clickAt(point);
      const tag = await waitForImageTag((candidate) => candidate !== before);
      return { tag, box: await placementState() };
    };

    for (const action of ["flip-horizontal", "flip-vertical"]) {
      const flipped = await flipState(action);
      check(
        `a ${action} keeps the picture at the width it had`,
        Math.round(flipped.box.width) === wrappedWidth &&
          flipped.tag.includes(`data-width="${wrappedWidth}"`),
        JSON.stringify(flipped),
      );
    }

    await clickPlacement("right");
    const rightTag = await waitForImageTag((tag) => /class="wrap-right"/.test(tag));
    check("the right placement wraps the picture on the right", /class="wrap-right"/.test(rightTag), rightTag);
    const rightState = await placementState();
    check(
      "the right-wrapped picture is painted at the right edge",
      Math.abs(rightState.left - (rightState.column - rightState.width)) <= 1,
      JSON.stringify(rightState),
    );

    await clickPlacement("center");
    const backTag = await waitForImageTag((tag) => !/class=/.test(tag));
    check("the middle brings it back to its own line", !/class=/.test(backTag), backTag);

    // Download image hands over the stored bits themselves, under a name taken
    // from the picture's alt text. Capture the blob in the page instead of
    // letting the browser write a real file, then compare its bytes with the
    // data URL that is saved in the document.
    const storedBeforeDownload = await storedImageTag();
    const storedPayload =
      (storedBeforeDownload.match(/src="data:image\/png;base64,([^"]+)"/) || [])[1] || "";
    const expectedBytes = Buffer.from(storedPayload, "base64");
    await evaluate(
      cdp,
      `(() => {
        window.__graphoDownload = null;
        window.__graphoCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
          window.__graphoDownload = { blob, type: blob.type, size: blob.size };
          return window.__graphoCreateObjectURL.call(URL, blob);
        };
        window.__graphoAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download && window.__graphoDownload) {
            window.__graphoDownload.filename = this.download;
            return;
          }
          return window.__graphoAnchorClick.call(this);
        };
        return true;
      })()`,
    );
    const downloadPoint = await evaluate(
      cdp,
      `(() => {
        const box = document.querySelector('[data-image-action="download"]').getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`,
    );
    await clickAt(downloadPoint);
    const downloaded = await evaluate(
      cdp,
      `(async () => {
        const capture = window.__graphoDownload;
        URL.createObjectURL = window.__graphoCreateObjectURL;
        HTMLAnchorElement.prototype.click = window.__graphoAnchorClick;
        if (!capture) return null;
        const bytes = new Uint8Array(await capture.blob.arrayBuffer());
        return {
          filename: capture.filename,
          type: capture.type,
          size: capture.size,
          signature: Array.from(bytes.slice(0, 8)),
          menuOpen: !document.getElementById("imageMenu").hidden,
          images: document.querySelectorAll(".doc-image").length,
        };
      })()`,
    );
    check(
      "the image menu downloads the stored bitmap as a file",
      Boolean(downloaded) &&
        downloaded.filename === "diagram.png" &&
        downloaded.type === "image/png" &&
        downloaded.size === expectedBytes.length &&
        downloaded.signature.join(",") === "137,80,78,71,13,10,26,10",
      JSON.stringify({ ...downloaded, expectedSize: expectedBytes.length }),
    );
    check(
      "downloading an image closes its menu and leaves the picture in place",
      Boolean(downloaded) && downloaded.menuOpen === false && downloaded.images === 1,
      JSON.stringify(downloaded),
    );

    await cdp.send("Page.navigate", { url: base + "/doc/" + imageDocumentId });
    await waitForPage(cdp, base + "/doc/" + imageDocumentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    const reloadedBox = await paintedImageSize();
    check(
      "a reload keeps the turned picture",
      Boolean(reloadedBox && reloadedBox.height > reloadedBox.width),
      JSON.stringify(reloadedBox),
    );
    check(
      "a reload keeps the corner radius",
      (await evaluate(
        cdp,
        `getComputedStyle(document.querySelector(".doc-image")).borderRadius`,
      )) === "28px",
    );
    const reloadedPlacement = await placementState();
    check(
      "a reload keeps the centred picture at its width",
      Math.round(reloadedPlacement.width) === wrappedWidth &&
        Math.abs(reloadedPlacement.left - (reloadedPlacement.column - reloadedPlacement.width) / 2) <= 1,
      JSON.stringify(reloadedPlacement),
    );

    // Picking a file decodes it into an ImageBitmap. A file above the passthrough
    // limit is drawn into a canvas, so the bitmap has to stay open until that
    // draw: drawing a closed one throws "The image source is detached". Pick the
    // large file first, then a small one that is stored as it was read.
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    // A real 16x16 AVIF, embedded as base64 so the check needs no image tool.
    // It is small enough to be stored as it was read, unlike the noise PNG.
    const tinyAvif = Buffer.from(
      "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAeAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAmbWRhdAoGGAz/2wCAMhQVAAAASAAAQKPLgPoMSdol1iPasA==",
      "base64",
    );
    const noisePng = await evaluate(
      cdp,
      `(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 450;
        const context = canvas.getContext("2d");
        const pixels = context.createImageData(canvas.width, canvas.height);
        let seed = 1;
        for (let index = 0; index < pixels.data.length; index += 4) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          pixels.data[index] = seed & 255;
          pixels.data[index + 1] = (seed >>> 8) & 255;
          pixels.data[index + 2] = (seed >>> 16) & 255;
          pixels.data[index + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        return canvas.toDataURL("image/png");
      })()`,
    );
    const noiseBytes = Buffer.from(String(noisePng).split(",")[1], "base64");
    check(
      "the picker fixture is larger than the re-encode limit",
      noiseBytes.length > 600 * 1024,
      `${noiseBytes.length} bytes`,
    );
    imageDir = await mkdtemp(path.join(os.tmpdir(), "grapho-picker-"));
    const tinyPath = path.join(imageDir, "tiny.png");
    const avifPath = path.join(imageDir, "tiny.avif");
    const noisePath = path.join(imageDir, "noise.png");
    await writeFile(tinyPath, tinyPng);
    await writeFile(avifPath, tinyAvif);
    await writeFile(noisePath, noiseBytes);

    const pickerDocumentId = await evaluate(
      cdp,
      `(async () => {
        const created = await fetch("/api/documents", { method: "POST" });
        if (!created.ok) throw new Error("create failed: " + created.status);
        const document = await created.json();
        const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Picker check", content: "<p>Pictures below.</p>", paper_width: 0 }),
        });
        if (!saved.ok) throw new Error("save failed: " + saved.status);
        return document.id;
      })()`,
    );
    await cdp.send("Page.navigate", { url: base + "/doc/" + pickerDocumentId });
    await waitForPage(cdp, base + "/doc/" + pickerDocumentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);

    await cdp.send("DOM.enable");
    const pickerRoot = await cdp.send("DOM.getDocument");
    const pickerInput = await cdp.send("DOM.querySelector", {
      nodeId: pickerRoot.root.nodeId,
      selector: "#imageInput",
    });
    const storedImageTags = async () => {
      const stored = await evaluate(
        cdp,
        `(async () => (await fetch("/api/documents/${pickerDocumentId}")).json())()`,
      );
      return String((stored && stored.content) || "").match(/<img[^>]*>/g) || [];
    };
    const waitForStoredImages = async (count) => {
      let tags = [];
      for (let attempt = 0; attempt < 80; attempt += 1) {
        tags = await storedImageTags();
        if (tags.length >= count) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return tags;
    };
    const pickFile = async (filePath) => {
      await cdp.send("DOM.setFileInputFiles", { nodeId: pickerInput.nodeId, files: [filePath] });
      // Setting the files fires the change event; dispatch it only when the
      // handler has not already cleared the input.
      await evaluate(
        cdp,
        `(() => {
          const input = document.getElementById("imageInput");
          if (input.files.length) {
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return true;
        })()`,
      );
    };

    // AVIF is one more format the picker has to take. A small one is stored as
    // it was read, so its data URL keeps the image/avif type through the
    // sanitizer. It goes in while it is the only picture in the document: a
    // wrapped neighbour would share its hit area, and the download check below
    // needs a point that can only land on the AVIF.
    await pickFile(avifPath);
    const avifTags = await waitForStoredImages(1);
    const storedAvifTag = avifTags.find((tag) => /src="data:image\/avif;base64,/.test(tag)) || "";
    check(
      "picking an AVIF picture embeds its bytes as they were read",
      /width="16"/.test(storedAvifTag) &&
        /height="16"/.test(storedAvifTag) &&
        /alt="tiny"/.test(storedAvifTag),
      avifTags.join(" "),
    );
    const avifPainted = await evaluate(
      cdp,
      `(() => {
        const image = document.querySelector(".doc-image");
        if (!image) return null;
        const box = image.getBoundingClientRect();
        return {
          avif: image.src.startsWith("data:image/avif"),
          width: Math.round(box.width),
          height: Math.round(box.height),
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
      })()`,
    );
    check(
      "the AVIF picture is painted from its stored bytes",
      Boolean(
        avifPainted &&
          avifPainted.avif &&
          avifPainted.width > 0 &&
          avifPainted.height === avifPainted.width,
      ),
      JSON.stringify(avifPainted),
    );

    // Download image hands the saved AVIF bytes back out under its own
    // extension; the capture is the same one the image document check uses.
    await rightClickAt({
      x: avifPainted ? avifPainted.x : 0,
      y: avifPainted ? avifPainted.y : 0,
    });
    await evaluate(
      cdp,
      `(() => {
        window.__graphoDownload = null;
        window.__graphoCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
          window.__graphoDownload = { blob, type: blob.type, size: blob.size };
          return window.__graphoCreateObjectURL.call(URL, blob);
        };
        window.__graphoAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download && window.__graphoDownload) {
            window.__graphoDownload.filename = this.download;
            return;
          }
          return window.__graphoAnchorClick.call(this);
        };
        return true;
      })()`,
    );
    const avifDownloadPoint = await evaluate(
      cdp,
      `(() => {
        const button = document.querySelector('[data-image-action="download"]');
        const menu = document.getElementById("imageMenu");
        if (!button || !menu || menu.hidden) return null;
        const box = button.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`,
    );
    check(
      "right-clicking the AVIF picture opens its menu",
      Boolean(avifDownloadPoint),
      JSON.stringify(avifDownloadPoint),
    );
    if (avifDownloadPoint) {
      await clickAt(avifDownloadPoint);
    }
    const downloadedAvif = await evaluate(
      cdp,
      `(async () => {
        const capture = window.__graphoDownload;
        URL.createObjectURL = window.__graphoCreateObjectURL;
        HTMLAnchorElement.prototype.click = window.__graphoAnchorClick;
        if (!capture) return null;
        const bytes = new Uint8Array(await capture.blob.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 1) {
          binary += String.fromCharCode(bytes[index]);
        }
        return {
          filename: capture.filename,
          type: capture.type,
          size: capture.size,
          base64: btoa(binary),
        };
      })()`,
    );
    check(
      "the image menu downloads an AVIF picture as an .avif file",
      Boolean(downloadedAvif) &&
        downloadedAvif.filename === "tiny.avif" &&
        downloadedAvif.type === "image/avif" &&
        downloadedAvif.size === tinyAvif.length &&
        downloadedAvif.base64 === tinyAvif.toString("base64"),
      JSON.stringify({
        filename: downloadedAvif && downloadedAvif.filename,
        type: downloadedAvif && downloadedAvif.type,
        size: downloadedAvif && downloadedAvif.size,
        expectedSize: tinyAvif.length,
      }),
    );

    await pickFile(noisePath);
    const largeTags = await waitForStoredImages(2);
    const storedNoiseTag = largeTags.find((tag) => /width="600"/.test(tag)) || "";
    check(
      "picking a large picture re-encodes it and embeds it",
      /height="450"/.test(storedNoiseTag) && /src="data:image\//.test(storedNoiseTag),
      largeTags.join(" "),
    );

    await pickFile(tinyPath);
    const pickedTags = await waitForStoredImages(3);
    check(
      "picking a small picture keeps its natural size",
      pickedTags.some((tag) => /width="1"/.test(tag) && /height="1"/.test(tag)),
      pickedTags.join(" "),
    );
    const pickedPainted = await evaluate(cdp, `document.querySelectorAll(".doc-image").length`);
    check("the picked pictures are painted", pickedPainted === 3, String(pickedPainted));

    await evaluate(cdp, `fetch("/api/documents/${pickerDocumentId}", { method: "DELETE" })`).catch(
      () => null,
    );
    await rm(imageDir, { recursive: true, force: true });
    imageDir = null;

    // Focus mode is the editor's own chrome switch: it hides the bar, keeps the
    // document menu reachable, and asks the browser for fullscreen. The request
    // is stubbed here so the check does not depend on the headless window.
    await evaluate(
      cdp,
      `(() => {
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        window.__focusFullscreenRequests = 0;
        document.documentElement.requestFullscreen = () => {
          window.__focusFullscreenRequests += 1;
          return Promise.resolve();
        };
        document.getElementById("documentMenuButton").click();
        document.querySelector('[data-doc-action="focus"]').click();
        return true;
      })()`,
    );

    const focusOn = await evaluate(
      cdp,
      `(() => {
        const header = document.querySelector(".editor-header");
        const toolbar = document.getElementById("formatToolbar");
        const button = document.getElementById("documentMenuButton");
        const box = button.getBoundingClientRect();
        return {
          mode: document.body.classList.contains("is-focus-mode"),
          headerPosition: getComputedStyle(header).position,
          toolbarDisplay: getComputedStyle(toolbar).display,
          workspacePadding: getComputedStyle(document.querySelector(".editor-workspace")).paddingTop,
          paperMinHeight: parseFloat(getComputedStyle(document.getElementById("paper")).minHeight),
          label: document.getElementById("focusMenuItemLabel").textContent,
          requests: window.__focusFullscreenRequests,
          buttonVisible:
            box.width > 0 &&
            box.height > 0 &&
            box.right <= window.innerWidth + 1 &&
            box.bottom <= window.innerHeight + 1,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      })()`,
    );
    check("focus mode is entered from the document menu", focusOn.mode === true, JSON.stringify(focusOn));
    check(
      "focus mode hides the top bar and keeps the menu button",
      focusOn.headerPosition === "fixed" &&
        focusOn.toolbarDisplay === "none" &&
        focusOn.workspacePadding === "0px" &&
        focusOn.buttonVisible &&
        focusOn.label === "Exit focus mode",
      JSON.stringify(focusOn),
    );
    check(
      "focus mode asks the browser for fullscreen",
      focusOn.requests === 1,
      JSON.stringify(focusOn),
    );
    check(
      "focus mode lets the page fill the window without overflow",
      focusOn.paperMinHeight >= focusOn.innerHeight - 1 &&
        focusOn.scrollWidth <= focusOn.innerWidth + 1,
      JSON.stringify(focusOn),
    );

    await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        document.querySelector('[data-doc-action="focus"]').click();
        return true;
      })()`,
    );
    const focusOff = await evaluate(
      cdp,
      `({
        mode: document.body.classList.contains("is-focus-mode"),
        toolbarDisplay: getComputedStyle(document.getElementById("formatToolbar")).display,
        label: document.getElementById("focusMenuItemLabel").textContent,
      })`,
    );
    check(
      "the document menu leaves focus mode",
      focusOff.mode === false && focusOff.toolbarDisplay !== "none" && focusOff.label === "Focus mode",
      JSON.stringify(focusOff),
    );

    // The keyboard shortcut toggles focus mode without opening the menu.
    await evaluate(cdp, `window.__focusFullscreenRequests = 0`);
    await pressKey("F", "KeyF", 70, 10);
    const focusKeyOn = await evaluate(
      cdp,
      `({
        mode: document.body.classList.contains("is-focus-mode"),
        label: document.getElementById("focusMenuItemLabel").textContent,
        requests: window.__focusFullscreenRequests,
      })`,
    );
    check(
      "Ctrl+Shift+F enters focus mode without the menu",
      focusKeyOn.mode === true &&
        focusKeyOn.label === "Exit focus mode" &&
        focusKeyOn.requests === 1,
      JSON.stringify(focusKeyOn),
    );
    await pressKey("F", "KeyF", 70, 10);
    check(
      "Ctrl+Shift+F leaves focus mode",
      (await evaluate(cdp, `!document.body.classList.contains("is-focus-mode")`)) === true,
    );

    await evaluate(
      cdp,
      `(() => {
        window.__focusFullscreenRequests = 0;
        document.getElementById("documentMenuButton").click();
        document.querySelector('[data-doc-action="focus"]').click();
        return true;
      })()`,
    );
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    check(
      "Escape leaves focus mode",
      (await evaluate(cdp, `!document.body.classList.contains("is-focus-mode")`)) === true,
    );
    await evaluate(cdp, `delete document.documentElement.requestFullscreen`);

    // The checks above ended on the image picker's document, which has already
    // been removed from the library. Open the main editor document again for
    // the Markdown mode checks.
    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);

    // Markdown mode is a view over the same document: the paper turns into
    // editable source lines, typing Markdown is saved as the usual semantic
    // HTML, and toggling back renders that HTML again. It is per-visit state,
    // so it starts off after a reload.
    const contentBeforeMarkdown = (await readSavedDocument()).content;

    const enterMarkdown = async () => {
      await evaluate(
        cdp,
        `(() => {
          document.getElementById("documentMenuButton").click();
          document.querySelector('[data-doc-action="markdown"]').click();
          return true;
        })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    };
    const leaveMarkdown = enterMarkdown;

    await enterMarkdown();
    const markdownOn = await evaluate(
      cdp,
      `(() => {
        const lines = Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent);
        return {
          mode: document.body.classList.contains("is-markdown-mode"),
          label: document.getElementById("markdownMenuItemLabel").textContent,
          focused: document.activeElement ? document.activeElement.id : "",
          lineCount: lines.length,
          otherLines: document.querySelectorAll(".doc-line:not(.is-source)").length,
          headingLine: lines.find((text) => text === "# A heading") || "",
          listLine: lines.find((text) => text.startsWith("- one")) || "",
          quoteLine: lines.find((text) => text.startsWith("> A quote")) || "",
          fenceLine: lines.find((text) => text === String.fromCharCode(96).repeat(3)) || "",
          metrics: (() => {
            const line = document.querySelector(".doc-line.is-source");
            if (!line) return null;
            const style = getComputedStyle(line);
            return {
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
              paintedHeight: line.getBoundingClientRect().height,
            };
          })(),
        };
      })()`,
    );
    check(
      "Markdown mode is entered from the document menu",
      markdownOn.mode === true &&
        markdownOn.label === "Exit Markdown mode" &&
        markdownOn.focused === "docInput",
      JSON.stringify(markdownOn),
    );
    check(
      "Markdown source lines use the layout's mono metrics",
      markdownOn.metrics &&
        markdownOn.metrics.fontSize === "15px" &&
        markdownOn.metrics.lineHeight === "25.5px" &&
        Math.abs(markdownOn.metrics.paintedHeight - 25.5) < 0.5,
      JSON.stringify(markdownOn.metrics),
    );
    check(
      "Markdown mode paints the document as source lines",
      markdownOn.lineCount > 5 &&
        markdownOn.otherLines === 0 &&
        markdownOn.headingLine === "# A heading" &&
        markdownOn.listLine === "- one" &&
        markdownOn.quoteLine === "> A quote" &&
        markdownOn.fenceLine.length >= 3,
      JSON.stringify(markdownOn),
    );

    // Type real Markdown at the end of the document. The textarea input path is
    // the same one the browser uses for keystrokes.
    await pressKey("End", "End", 35, 2);
    await cdp.send("Input.insertText", {
      text: "\n# Typed heading\nA **bold** line with [a link](https://example.com).\n- alpha\n- beta",
    });
    const markdownSaved = await waitForSavedContent("<h1>Typed heading</h1>");
    check("typed Markdown is saved", markdownSaved, saved && saved.content);
    check(
      "Markdown typing is stored as the app's HTML",
      saved &&
        saved.content.includes("<b>bold</b>") &&
        saved.content.includes("example.com") &&
        !saved.content.includes("# Typed heading") &&
        !saved.content.includes("**bold**"),
      saved && saved.content,
    );

    // Every toolbar control is meant to work in Markdown mode too. A collapsed
    // bold click arms the next typed text (an empty "****" run would be stored
    // as literal text); typing turns it into real formatting, and undo removes
    // both the text and its markers as one step.
    const sourceBeforeBold = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")`,
    );
    await evaluate(
      cdp,
      `document.querySelector('[data-command="bold"]').click()`,
    );
    const boldPending = await evaluate(
      cdp,
      `document.querySelector('[data-command="bold"]').getAttribute("aria-pressed")`,
    );
    await cdp.send("Input.insertText", { text: "Q" });
    const sourceAfterBold = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")`,
    );
    await evaluate(
      cdp,
      `document.querySelector('[data-command="undo"]').click()`,
    );
    const sourceAfterUndo = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")`,
    );
    check(
      "the bold button formats the next typed text in the source",
      boldPending === "true" && sourceAfterBold === sourceBeforeBold + "**Q**",
      JSON.stringify({
        boldPending,
        sourceBeforeBold: sourceBeforeBold.slice(-40),
        sourceAfterBold: sourceAfterBold.slice(-40),
      }),
    );
    check(
      "undo takes the formatted text back",
      sourceAfterUndo === sourceBeforeBold,
      JSON.stringify({ sourceAfterUndo: sourceAfterUndo.slice(-40) }),
    );

    await leaveMarkdown();
    const markdownOff = await evaluate(
      cdp,
      `(() => {
        const heading = Array.from(document.querySelectorAll(".doc-line.is-h1")).map((line) => line.textContent);
        return {
          mode: document.body.classList.contains("is-markdown-mode"),
          label: document.getElementById("markdownMenuItemLabel").textContent,
          headings: heading,
          sourceLines: document.querySelectorAll(".doc-line.is-source").length,
        };
      })()`,
    );
    check(
      "leaving Markdown mode renders the saved HTML again",
      markdownOff.mode === false &&
        markdownOff.label === "Markdown mode" &&
        markdownOff.headings.includes("Typed heading") &&
        markdownOff.sourceLines === 0,
      JSON.stringify(markdownOff),
    );

    // A toggle with no edits must not rewrite the document, and entering again
    // must recover the Markdown source from the stored HTML.
    const contentAfterFirstPass = (await readSavedDocument()).content;
    await enterMarkdown();
    const roundTrippedSource = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")`,
    );
    await leaveMarkdown();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const contentAfterSecondPass = (await readSavedDocument()).content;
    check(
      "Markdown source round-trips from the stored HTML",
      roundTrippedSource.includes("# Typed heading") &&
        roundTrippedSource.includes("- alpha") &&
        roundTrippedSource.includes("[a link](https://example.com"),
      JSON.stringify(roundTrippedSource.slice(-200)),
    );
    check(
      "a no-op Markdown toggle leaves the stored document alone",
      contentAfterFirstPass === contentAfterSecondPass,
      JSON.stringify({
        before: contentAfterFirstPass && contentAfterFirstPass.slice(-80),
        after: contentAfterSecondPass && contentAfterSecondPass.slice(-80),
      }),
    );
    check(
      "the earlier Markdown edits were stored",
      contentBeforeMarkdown !== contentAfterFirstPass,
      JSON.stringify({ before: contentBeforeMarkdown && contentBeforeMarkdown.slice(-60) }),
    );

    // The mode is not remembered: a reload comes back in the normal rich view.
    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    check(
      "Markdown mode is off after a reload",
      (await evaluate(cdp, `document.body.classList.contains("is-markdown-mode")`)) === false,
    );

    // The keyboard shortcut toggles the view without opening the menu.
    await pressKey("M", "KeyM", 77, 10);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shortcutOn = await evaluate(
      cdp,
      `({
        mode: document.body.classList.contains("is-markdown-mode"),
        label: document.getElementById("markdownMenuItemLabel").textContent,
        sourceLines: document.querySelectorAll(".doc-line.is-source").length
      })`,
    );
    await pressKey("M", "KeyM", 77, 10);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shortcutOff = await evaluate(
      cdp,
      `({
        mode: document.body.classList.contains("is-markdown-mode"),
        label: document.getElementById("markdownMenuItemLabel").textContent,
        sourceLines: document.querySelectorAll(".doc-line.is-source").length
      })`,
    );
    check(
      "Ctrl+Shift+M toggles Markdown mode without the menu",
      shortcutOn.mode === true &&
        shortcutOn.label === "Exit Markdown mode" &&
        shortcutOn.sourceLines > 0 &&
        shortcutOff.mode === false &&
        shortcutOff.label === "Markdown mode" &&
        shortcutOff.sourceLines === 0,
      JSON.stringify({ shortcutOn, shortcutOff }),
    );

    // Every toolbar control edits the source in Markdown mode. Work on the last
    // line (a plain paragraph), then leave and come back to prove round-trip.
    const readSource = () =>
      evaluate(
        cdp,
        `Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")`,
      );
    const lastLine = (text) => text.split("\n").filter((line) => line.length).pop() || "";
    await enterMarkdown();
    await pressKey("End", "End", 35, 2);
    const beforeBullet = await readSource();
    await evaluate(cdp, `document.querySelector('[data-command="insertUnorderedList"]').click()`);
    const toggledBullet = await readSource();
    await evaluate(cdp, `document.querySelector('[data-command="insertUnorderedList"]').click()`);
    const restoredBullet = await readSource();
    check(
      "the list button toggles a Markdown bullet",
      lastLine(beforeBullet).startsWith("- ") !== lastLine(toggledBullet).startsWith("- ") &&
        lastLine(restoredBullet) === lastLine(beforeBullet),
      JSON.stringify({
        before: lastLine(beforeBullet).slice(0, 40),
        toggled: lastLine(toggledBullet).slice(0, 40),
        restored: lastLine(restoredBullet).slice(0, 40),
      }),
    );

    await evaluate(
      cdp,
      `(() => {
        document.getElementById("styleButton").click();
        document.querySelector('[data-block-style="h1"]').click();
        return true;
      })()`,
    );
    const headingSource = await readSource();
    check(
      "the style menu writes a Markdown heading marker",
      lastLine(headingSource).startsWith("# "),
      JSON.stringify(lastLine(headingSource).slice(0, 40)),
    );

    await evaluate(
      cdp,
      `(() => {
        document.getElementById("alignButton").click();
        document.querySelector('[data-align-value="center"]').click();
        return true;
      })()`,
    );
    const alignedSource = await readSource();
    check(
      "the align menu carries alignment as the documented HTML escape",
      lastLine(alignedSource).startsWith('<h1 data-align="center">'),
      JSON.stringify(lastLine(alignedSource).slice(0, 60)),
    );

    await leaveMarkdown();
    const alignedRich = await evaluate(
      cdp,
      `({
        headings: document.querySelectorAll(".doc-line.is-h1").length,
        mode: document.body.classList.contains("is-markdown-mode")
      })`,
    );
    const alignedSaved = await waitForSavedContent('data-align="center"');
    check(
      "Markdown toolbar changes render and save as rich HTML",
      alignedRich.mode === false && alignedRich.headings > 0 && alignedSaved,
      JSON.stringify({ alignedRich, alignedSaved, content: saved && saved.content && saved.content.slice(-120) }),
    );
    await enterMarkdown();
    const alignedAgain = await readSource();
    check(
      "the aligned heading round-trips through the source",
      lastLine(alignedAgain).includes('data-align="center"') && lastLine(alignedAgain).startsWith("<h1"),
      JSON.stringify(lastLine(alignedAgain).slice(0, 60)),
    );

    // Markdown mode and focus mode are independent: focus hides the bar but the
    // source keeps painting, and leaving focus does not leave Markdown mode.
    await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        document.querySelector('[data-doc-action="focus"]').click();
        return true;
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const focusedMarkdown = await evaluate(
      cdp,
      `({
        focus: document.body.classList.contains("is-focus-mode"),
        markdown: document.body.classList.contains("is-markdown-mode"),
        toolbar: getComputedStyle(document.getElementById("formatToolbar")).display,
        sourceLines: document.querySelectorAll(".doc-line.is-source").length
      })`,
    );
    check(
      "focus mode composes with Markdown mode",
      focusedMarkdown.focus === true &&
        focusedMarkdown.markdown === true &&
        focusedMarkdown.toolbar === "none" &&
        focusedMarkdown.sourceLines > 0,
      JSON.stringify(focusedMarkdown),
    );
    await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        document.querySelector('[data-doc-action="focus"]').click();
        return true;
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(
      "leaving focus mode keeps Markdown mode on",
      (await evaluate(
        cdp,
        `document.body.classList.contains("is-focus-mode") === false && document.body.classList.contains("is-markdown-mode") === true`,
      )) === true,
    );
    await leaveMarkdown();

    // A narrow viewport still paints a wrapped source view without overflow.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await enterMarkdown();
    const narrowMarkdown = await evaluate(
      cdp,
      `({
        sourceLines: document.querySelectorAll(".doc-line.is-source").length,
        overflow: document.documentElement.scrollWidth - window.innerWidth
      })`,
    );
    await leaveMarkdown();
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    check(
      "Markdown mode wraps without horizontal overflow on a narrow viewport",
      narrowMarkdown.sourceLines > 0 && narrowMarkdown.overflow <= 1,
      JSON.stringify(narrowMarkdown),
    );

    // A collapsed formatting click must not write literal marker runs: it arms
    // the next typed text, and leaving the mode without typing changes nothing.
    const contentBeforePending = (await readSavedDocument()).content;
    await enterMarkdown();
    await pressKey("Home", "Home", 36, 2);
    await evaluate(cdp, `document.querySelector('[data-command="bold"]').click()`);
    const pendingPressed = await evaluate(
      cdp,
      `document.querySelector('[data-command="bold"]').getAttribute("aria-pressed")`,
    );
    await leaveMarkdown();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const contentAfterPending = (await readSavedDocument()).content;
    check(
      "a collapsed bold click arms the next text instead of writing markers",
      pendingPressed === "true" &&
        contentAfterPending === contentBeforePending &&
        !String(contentAfterPending).includes("****"),
      JSON.stringify({
        pendingPressed,
        before: contentBeforePending && contentBeforePending.slice(-60),
        after: contentAfterPending && contentAfterPending.slice(-60),
      }),
    );

    // The armed mark wraps the next typed text: real formatting, not literal
    // asterisks, and it is saved.
    await enterMarkdown();
    await pressKey("Home", "Home", 36, 2);
    await evaluate(cdp, `document.querySelector('[data-command="bold"]').click()`);
    await cdp.send("Input.insertText", { text: "fresh" });
    const armedSource = await readSource();
    const armedSaved = await waitForSavedContent("<b>fresh</b>");
    await leaveMarkdown();
    check(
      "typing after a collapsed bold click saves bold text",
      armedSource.includes("**fresh**") &&
        armedSaved &&
        !String(saved.content).includes("****"),
      JSON.stringify({
        armed: armedSource.slice(-60),
        content: saved && saved.content && saved.content.slice(-90),
      }),
    );

    // A whole-document selection must not wrap heading/list/quote markers into
    // the text: the markers stay structural and the rich view keeps them.
    await enterMarkdown();
    await pressKey("Home", "Home", 36, 2);
    await pressKey("a", "KeyA", 65, 2);
    await evaluate(cdp, `document.querySelector('[data-command="bold"]').click()`);
    const bulkSource = await readSource();
    const bulkLines = bulkSource.split("\n").filter((line) => line.length);
    const corruptedLines = bulkLines.filter(
      (line) => /^\s*\*\*[#>\-]/.test(line) || /^\s*\*\*\d+\./.test(line),
    );
    await leaveMarkdown();
    const bulkRich = await evaluate(
      cdp,
      `({
        headings: document.querySelectorAll(".doc-line.is-h1, .doc-line.is-h2").length,
        literalMarkerLines: Array.from(document.querySelectorAll(".doc-line")).filter((line) => /^[#>-] /.test(line.textContent)).length
      })`,
    );
    check(
      "a whole-document bold selection keeps block markers out of the marks",
      corruptedLines.length === 0 &&
        bulkLines.some((line) => line.startsWith("# ")) &&
        bulkRich.headings > 0 &&
        bulkRich.literalMarkerLines === 0,
      JSON.stringify({
        corrupted: corruptedLines.slice(0, 3),
        sample: bulkLines.slice(0, 6),
        bulkRich,
      }),
    );

    // A blank line typed in the source is a real line break: it must come back
    // after leaving and re-entering the mode, in the editor and on disk.
    await enterMarkdown();
    await pressKey("Home", "Home", 36, 2);
    await pressKey("End", "End", 35, 0);
    await pressKey("Enter", "Enter", 13, 0);
    const blankSource = await readSource();
    const blankLines = blankSource.split("\n");
    const blankIndex = blankLines.findIndex((line) => line === "");
    await leaveMarkdown();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const blankSaved = (await readSavedDocument()).content;
    await enterMarkdown();
    const reenteredSource = await readSource();
    await leaveMarkdown();
    check(
      "a blank line typed in Markdown mode survives leaving and re-entering",
      blankIndex > 0 &&
        blankLines[blankIndex] === "" &&
        reenteredSource === blankSource &&
        String(blankSaved).includes("<p></p>"),
      JSON.stringify({
        blankIndex,
        around: blankLines.slice(Math.max(0, blankIndex - 1), blankIndex + 2),
        sameSource: reenteredSource === blankSource,
        hasEmptyParagraph: String(blankSaved).includes("<p></p>"),
      }),
    );

    // Images stay real image blocks while the mode is on: the source never
    // contains their base64 bytes, and toggling leaves the picture alone.
    const markdownImageDocumentId = await evaluate(
      cdp,
      `(async () => {
        const created = await fetch("/api/documents", { method: "POST" });
        const document = await created.json();
        const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const content = '<p>Before picture.</p><img alt="dot" width="1" height="1" src="' + png + '"><p>After picture.</p>';
        await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Markdown image", content, paper_width: 0 }),
        });
        return document.id;
      })()`,
    );
    await cdp.send("Page.navigate", { url: base + "/doc/" + markdownImageDocumentId });
    await waitForPage(cdp, base + "/doc/" + markdownImageDocumentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    await enterMarkdown();
    const markdownImageOn = await evaluate(
      cdp,
      `({
        images: document.querySelectorAll(".doc-image").length,
        source: Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")
      })`,
    );
    await leaveMarkdown();
    const markdownImageOff = await evaluate(
      cdp,
      `({
        images: document.querySelectorAll(".doc-image").length,
        sourceLines: document.querySelectorAll(".doc-line.is-source").length
      })`,
    );
    const storedMarkdownImage = await evaluate(
      cdp,
      `(async () => (await fetch("/api/documents/${markdownImageDocumentId}")).json())()`,
    );
    check(
      "images stay rendered image blocks in Markdown mode",
      markdownImageOn.images === 1 &&
        markdownImageOn.source.includes("Before picture.") &&
        markdownImageOn.source.includes("After picture.") &&
        !markdownImageOn.source.includes("data:image") &&
        markdownImageOff.images === 1 &&
        markdownImageOff.sourceLines === 0,
      JSON.stringify({ markdownImageOn: { images: markdownImageOn.images, source: markdownImageOn.source.slice(0, 120) }, markdownImageOff }),
    );
    check(
      "an untouched picture survives a Markdown toggle",
      /<img[^>]*alt="dot"/.test(String(storedMarkdownImage.content)) &&
        String(storedMarkdownImage.content).includes("Before picture."),
      String(storedMarkdownImage.content).slice(0, 160),
    );
    await evaluate(cdp, `fetch("/api/documents/${markdownImageDocumentId}", { method: "DELETE" })`).catch(
      () => null,
    );

    await evaluate(cdp, `fetch("/api/documents/${imageDocumentId}", { method: "DELETE" })`).catch(
      () => null,
    );

    // The link dialog can point at another Grapho page: it reads the library
    // when it opens, lists recent documents, filters them locally as the writer
    // types, and inserts a root-relative target. A typed web address keeps the
    // behavior it always had.
    const linkPages = await evaluate(
      cdp,
      `(async () => {
        const create = async (title, content) => {
          const response = await fetch("/api/documents", { method: "POST" });
          if (!response.ok) throw new Error("create failed: " + response.status);
          const document = await response.json();
          const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, content, paper_width: 0 }),
          });
          if (!saved.ok) throw new Error("save failed: " + saved.status);
          return document.id;
        };
        return {
          target: await create("Link target page", "<p>Target body.</p>"),
          source: await create("Link dialog source", "<p>Link this phrase now.</p>"),
          markdown: await create("Markdown link source", "<p>Go to the page now.</p>"),
        };
      })()`,
    );
    const targetHref = "/doc/" + linkPages.target;
    check("the link dialog test documents were created", Boolean(linkPages.target));

    async function clickFirstLine() {
      const point = await evaluate(
        cdp,
        `(() => {
          const line = document.querySelector(".doc-content > .doc-block .doc-line");
          const box = line.getBoundingClientRect();
          return { x: box.left + 5, y: box.top + box.height / 2 };
        })()`,
      );
      await clickAt(point);
    }

    async function selectWholeDocument() {
      await clickFirstLine();
      await pressKey("a", "KeyA", 65, 2);
    }

    async function openLinkDialogForTest() {
      await evaluate(cdp, `document.getElementById("linkButton").click()`);
      return waitForExpression(
        cdp,
        `Boolean(document.getElementById("linkDialog").open)`,
        PAGE_TIMEOUT_MS,
      );
    }

    async function waitForLinkResults() {
      return waitForExpression(
        cdp,
        `(() => {
          const results = document.getElementById("linkResults");
          return Boolean(
            results &&
            !results.hidden &&
            document.querySelectorAll("#linkResultsList .link-result").length > 0
          );
        })()`,
        PAGE_TIMEOUT_MS,
      );
    }

    async function savedLinkDocument(id) {
      return evaluate(
        cdp,
        `(async () => (await fetch(${JSON.stringify("/api/documents/" + id)})).json())()`,
      );
    }

    async function waitForSavedLinkContent(id, probe) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const stored = await savedLinkDocument(id);
        if (stored && stored.content && stored.content.includes(probe)) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }

    async function paintedLink() {
      return evaluate(
        cdp,
        `(() => {
          const link = document.querySelector(".m-link");
          return link ? { href: link.getAttribute("data-href"), text: link.textContent } : null;
        })()`,
      );
    }

    async function clickLinkResult(title) {
      return evaluate(
        cdp,
        `(() => {
          const row = Array.from(document.querySelectorAll("#linkResultsList .link-result")).find(
            (candidate) =>
              candidate.querySelector(".link-result-title").textContent === ${JSON.stringify(title)},
          );
          if (!row) return false;
          row.click();
          return true;
        })()`,
      );
    }

    async function pressEnter() {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        text: "\r",
        unmodifiedText: "\r",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }

    await cdp.send("Page.navigate", { url: base + "/doc/" + linkPages.source });
    await waitForPage(cdp, base + "/doc/" + linkPages.source, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);

    await selectWholeDocument();
    check("the link dialog opens", await openLinkDialogForTest());
    check("the link dialog lists recent documents", await waitForLinkResults());
    const linkPicker = await evaluate(
      cdp,
      `(() => {
        const rows = Array.from(document.querySelectorAll("#linkResultsList .link-result"));
        return {
          field: document.querySelector("#linkDialog .field > span").textContent,
          placeholder: document.getElementById("linkInput").placeholder,
          combobox: document.getElementById("linkInput").getAttribute("role"),
          expanded: document.getElementById("linkInput").getAttribute("aria-expanded"),
          listRole: document.getElementById("linkResultsList").getAttribute("role"),
          listLabel: document.getElementById("linkResultsLabel").textContent,
          rows: rows.map((row) => ({
            title: row.querySelector(".link-result-title").textContent,
            meta: row.querySelector(".link-result-meta").textContent,
            selected: row.getAttribute("aria-selected"),
          })),
        };
      })()`,
    );
    check(
      "the link field offers a web address or a page search",
      linkPicker.field === "Web address or search Grapho page" &&
        linkPicker.placeholder.includes("web address") &&
        linkPicker.combobox === "combobox" &&
        linkPicker.expanded === "true" &&
        linkPicker.listRole === "listbox",
      JSON.stringify(linkPicker),
    );
    check(
      "the page list starts with recent documents and leaves the current page out",
      linkPicker.listLabel === "Recent documents" &&
        linkPicker.rows.length > 0 &&
        linkPicker.rows.some((row) => row.title === "Link target page") &&
        linkPicker.rows.some((row) => row.title === "Markdown link source") &&
        linkPicker.rows.every((row) => row.title !== "Link dialog source") &&
        linkPicker.rows.every((row) => row.meta.startsWith("Edited ")) &&
        linkPicker.rows.every((row) => row.selected === "false"),
      JSON.stringify(linkPicker.rows),
    );

    check(
      "choosing a recent document puts that page in the link",
      await clickLinkResult("Link target page"),
    );
    const pageLink = await paintedLink();
    check(
      "choosing a recent document links the selected text to that page",
      pageLink && pageLink.href === targetHref && pageLink.text === "Link this phrase now.",
      JSON.stringify(pageLink),
    );
    check(
      "the page link is saved as a root-relative target",
      await waitForSavedLinkContent(linkPages.source, 'href="' + targetHref + '"'),
    );

    // A heading fragment rides the same root-relative link, so a deep link can
    // be written from the dialog; the store sanitizer keeps the fragment.
    await pressKey("z", "KeyZ", 90, 2);
    await selectWholeDocument();
    check("the link dialog reopens for a heading fragment", await openLinkDialogForTest());
    await waitForExpression(
      cdp,
      `document.activeElement && document.activeElement.id === "linkInput"`,
      PAGE_TIMEOUT_MS,
    );
    await cdp.send("Input.insertText", { text: targetHref + "#target-heading" });
    await pressEnter();
    const fragmentLink = await paintedLink();
    check(
      "a root-relative link keeps its heading fragment",
      fragmentLink && fragmentLink.href === targetHref + "#target-heading",
      JSON.stringify(fragmentLink),
    );
    check(
      "the fragment link is saved",
      await waitForSavedLinkContent(linkPages.source, 'href="' + targetHref + '#target-heading"'),
    );

    // The dialog still adds a web address: pasting one hides the page list and
    // Enter applies it to the selection.
    await pressKey("z", "KeyZ", 90, 2);
    await selectWholeDocument();
    check("the link dialog reopens for a web address", await openLinkDialogForTest());
    const fieldFocused = await waitForExpression(
      cdp,
      `document.activeElement && document.activeElement.id === "linkInput"`,
      PAGE_TIMEOUT_MS,
    );
    await cdp.send("Input.insertText", { text: "https://example.com/page" });
    check(
      "a typed web address is not searched as a page",
      fieldFocused &&
        (await waitForExpression(
          cdp,
          `document.getElementById("linkResults").hidden`,
          PAGE_TIMEOUT_MS,
        )),
    );
    await pressEnter();
    const addressLink = await paintedLink();
    check(
      "a typed web address still becomes the link",
      addressLink && addressLink.href === "https://example.com/page",
      JSON.stringify(addressLink),
    );
    check(
      "the typed web address is saved",
      await waitForSavedLinkContent(linkPages.source, 'href="https://example.com/page"'),
    );

    // Typing narrows the list to a search: the best match is offered, and
    // Enter links it without a click.
    await pressKey("z", "KeyZ", 90, 2);
    await selectWholeDocument();
    check("the link dialog reopens for a page search", await openLinkDialogForTest());
    await waitForExpression(
      cdp,
      `document.activeElement && document.activeElement.id === "linkInput"`,
      PAGE_TIMEOUT_MS,
    );
    await cdp.send("Input.insertText", { text: "target" });
    const pickedBySearch = await waitForExpression(
      cdp,
      `(() => {
        const rows = Array.from(document.querySelectorAll("#linkResultsList .link-result"));
        const selected = rows.filter((row) => row.getAttribute("aria-selected") === "true");
        return (
          rows.length === 1 &&
          selected.length === 1 &&
          selected[0].querySelector(".link-result-title").textContent === "Link target page"
        );
      })()`,
      PAGE_TIMEOUT_MS,
    );
    check("typing a page title filters the list and selects the match", pickedBySearch);
    await pressEnter();
    const keyboardLink = await paintedLink();
    check(
      "Enter on a matching page links it",
      keyboardLink && keyboardLink.href === targetHref,
      JSON.stringify(keyboardLink),
    );
    check(
      "the page link chosen with the keyboard is saved",
      await waitForSavedLinkContent(linkPages.source, 'href="' + targetHref + '"'),
    );

    // A caret inside a link opens the dialog in its edit state; the new target
    // replaces the old one instead of arming the marks for the next keystroke.
    await clickFirstLine();
    await pressKey("k", "KeyK", 75, 2);
    check(
      "a caret inside a page link opens the dialog in edit mode",
      await waitForExpression(
        cdp,
        `Boolean(
          document.getElementById("linkDialog").open &&
          document.getElementById("linkTitle").textContent === "Edit link" &&
          document.getElementById("linkInput").value === ${JSON.stringify(targetHref)}
        )`,
        PAGE_TIMEOUT_MS,
      ),
    );
    await waitForExpression(
      cdp,
      `(() => {
        const input = document.getElementById("linkInput");
        return (
          document.activeElement === input &&
          input.value.length > 0 &&
          input.selectionStart === 0 &&
          input.selectionEnd === input.value.length
        );
      })()`,
      PAGE_TIMEOUT_MS,
    );
    await cdp.send("Input.insertText", { text: "https://example.org/edited" });
    await pressEnter();
    const editedLink = await paintedLink();
    check(
      "editing a link from a collapsed caret replaces its target",
      editedLink && editedLink.href === "https://example.org/edited",
      JSON.stringify(editedLink),
    );
    check(
      "the edited link is saved",
      await waitForSavedLinkContent(linkPages.source, 'href="https://example.org/edited"'),
    );

    // Markdown mode gets the same page picker: the link is written into the
    // source and parses back to the usual stored anchor.
    await cdp.send("Page.navigate", { url: base + "/doc/" + linkPages.markdown });
    await waitForPage(cdp, base + "/doc/" + linkPages.markdown, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    await enterMarkdown();
    await selectWholeDocument();
    check("the link dialog opens in Markdown mode", await openLinkDialogForTest());
    check("the page list is available in Markdown mode", await waitForLinkResults());
    check(
      "choosing a page in Markdown mode inserts its link",
      await clickLinkResult("Link target page"),
    );
    const markdownSourceLine = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll(".doc-line.is-source")).map((line) => line.textContent).join("\\n")`,
    );
    check(
      "the page picker writes a Markdown link into the source",
      markdownSourceLine.includes("](" + targetHref + ")"),
      markdownSourceLine,
    );
    await leaveMarkdown();
    const markdownRichLink = await paintedLink();
    check(
      "the Markdown page link renders as a link",
      markdownRichLink && markdownRichLink.href === targetHref,
      JSON.stringify(markdownRichLink),
    );
    check(
      "the Markdown page link saves as the usual anchor",
      await waitForSavedLinkContent(linkPages.markdown, 'href="' + targetHref + '"'),
    );

    // On a phone-sized viewport the taller dialog has to stay inside the
    // screen instead of spilling past it.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 650,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Page.navigate", { url: base + "/doc/" + linkPages.target });
    await waitForPage(cdp, base + "/doc/" + linkPages.target, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);

    const compactToolbar = await evaluate(cdp, `(() => {
      const header = document.querySelector(".editor-header");
      const toolbar = document.getElementById("formatToolbar");
      const buttons = Array.from(toolbar.querySelectorAll("button")).filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth;
      });
      return {
        height: header.offsetHeight,
        fits: toolbar.scrollWidth === toolbar.clientWidth,
        actions: buttons.map((button) => button.dataset.command || button.id),
      };
    })()`);
    check(
      "the mobile toolbar fits its writing actions in one short row",
      compactToolbar.height <= 90 && compactToolbar.fits &&
        compactToolbar.actions.join(",") ===
          "styleButton,bold,italic,insertUnorderedList,insertOrderedList,linkButton,moreFormattingButton",
      JSON.stringify(compactToolbar),
    );

    async function tapToolbar(selector) {
      const point = await evaluate(cdp, `(() => {
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }

    await selectWholeDocument();
    await tapToolbar("#moreFormattingButton");
    check(
      "the overflow exposes the secondary actions and keeps the editor focused",
      await evaluate(cdp, `(() => {
        const menu = document.getElementById("moreFormattingMenu");
        const box = menu.getBoundingClientRect();
        return !menu.hidden && menu.querySelectorAll("button").length === 7 &&
          box.left >= 0 && box.right <= window.innerWidth && document.activeElement.id === "docInput";
      })()`),
    );
    await tapToolbar('[data-command="underline"]');
    check(
      "choosing underline formats the selection and dismisses the overflow",
      await evaluate(cdp, `document.querySelector(".m-u")?.textContent === "Target body." &&
        document.getElementById("moreFormattingMenu").hidden && document.activeElement.id === "docInput"`),
    );
    await tapToolbar("#moreFormattingButton");
    await tapToolbar('[data-command="undo"]');
    check("undo remains available from the overflow", await evaluate(cdp, `!document.querySelector(".m-u")`));

    await evaluate(cdp, `document.getElementById("moreFormattingButton").focus()`);
    await pressKey("Enter", "Enter", 13, 0, "\r");
    check(
      "keyboard activation focuses an overflow control",
      await evaluate(cdp, `document.getElementById("moreFormattingMenu").contains(document.activeElement)`),
    );
    await pressKey("Escape", "Escape", 27);
    check(
      "Escape returns keyboard focus to More formatting",
      await evaluate(cdp, `document.getElementById("moreFormattingMenu").hidden &&
        document.activeElement.id === "moreFormattingButton"`),
    );

    await selectWholeDocument();
    await tapToolbar("#linkButton");
    await waitForLinkResults();
    const narrowDialog = await evaluate(
      cdp,
      `(() => {
        const box = document.getElementById("linkDialog").getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          viewport: window.innerHeight,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()`,
    );
    await evaluate(cdp, `document.getElementById("linkCancel").click()`);
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    check(
      "returning to desktop restores the direct formatting controls",
      await waitForExpression(cdp, `(() => {
        const toolbar = document.getElementById("formatToolbar");
        return document.getElementById("moreFormattingButton").offsetWidth === 0 &&
          document.getElementById("moreFormattingMenu").childElementCount === 0 &&
          Array.from(toolbar.querySelectorAll("[data-toolbar-overflow]")).every((button) => button.offsetWidth > 0);
      })()`, PAGE_TIMEOUT_MS),
    );
    check(
      "the link dialog fits a narrow viewport",
      narrowDialog.height > 0 &&
        narrowDialog.top >= 0 &&
        narrowDialog.bottom <= narrowDialog.viewport &&
        narrowDialog.overflow <= 1,
      JSON.stringify(narrowDialog),
    );

    // Heading anchors are derived from the heading text, so a deep link opens
    // the document scrolled to that section without anything stored in the
    // file. The document menu copies the link while the caret is in a heading,
    // and repeated headings get a "-2" suffix so both stay addressable.
    const anchorDocumentId = await evaluate(
      cdp,
      `(async () => {
        const filler = [];
        for (let index = 0; index < 40; index += 1) {
          filler.push("<p>filler line " + index + "</p>");
        }
        const content =
          "<h1>Anchors check</h1>" +
          filler.join("") +
          "<h2>Second part</h2>" +
          "<h3>Second part</h3>" +
          filler.join("");
        const created = await fetch("/api/documents", { method: "POST" });
        if (!created.ok) throw new Error("create failed: " + created.status);
        const document = await created.json();
        const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Anchor check", content: content, paper_width: 0 }),
        });
        if (!saved.ok) throw new Error("save failed: " + saved.status);
        return document.id;
      })()`,
    );
    check("the anchor check document was created", Boolean(anchorDocumentId));

    const anchorUrl = base + "/doc/" + anchorDocumentId + "#second-part";
    await cdp.send("Page.navigate", { url: anchorUrl });
    await waitForPage(cdp, anchorUrl, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    let anchorOpen = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      anchorOpen = await evaluate(
        cdp,
        `(() => {
          const line = Array.from(document.querySelectorAll(".doc-line.is-h2")).find(
            (candidate) => candidate.textContent === "Second part",
          );
          if (!line) return null;
          const box = line.getBoundingClientRect();
          return { top: box.top, scrollY: window.scrollY, hash: location.hash };
        })()`,
      );
      if (anchorOpen && anchorOpen.scrollY > 0 && anchorOpen.top > 0 && anchorOpen.top < 240) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(
      "opening a #heading link scrolls that heading below the header",
      Boolean(anchorOpen) &&
        anchorOpen.hash === "#second-part" &&
        anchorOpen.scrollY > 0 &&
        anchorOpen.top > 0 &&
        anchorOpen.top < 240,
      JSON.stringify(anchorOpen),
    );

    // The duplicate heading has the deduplicated anchor.
    const duplicateAnchorUrl = base + "/doc/" + anchorDocumentId + "#second-part-2";
    await cdp.send("Page.navigate", { url: duplicateAnchorUrl });
    await waitForPage(cdp, duplicateAnchorUrl, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    let duplicateAnchorOpen = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      duplicateAnchorOpen = await evaluate(
        cdp,
        `(() => {
          const line = Array.from(document.querySelectorAll(".doc-line.is-h3")).find(
            (candidate) => candidate.textContent === "Second part",
          );
          if (!line) return null;
          return { top: line.getBoundingClientRect().top, scrollY: window.scrollY };
        })()`,
      );
      if (duplicateAnchorOpen && duplicateAnchorOpen.top > 0 && duplicateAnchorOpen.top < 240) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(
      "a repeated heading gets a -2 anchor of its own",
      Boolean(duplicateAnchorOpen) &&
        duplicateAnchorOpen.scrollY > 0 &&
        duplicateAnchorOpen.top > 0 &&
        duplicateAnchorOpen.top < 240,
      JSON.stringify(duplicateAnchorOpen),
    );

    // The menu item only exists while the caret is in a heading, and the link it
    // copies is the absolute URL of that heading.
    await cdp.send("Page.navigate", { url: base + "/doc/" + anchorDocumentId });
    await waitForPage(cdp, base + "/doc/" + anchorDocumentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    const paragraphPoint = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-line.is-p");
        const box = line.getBoundingClientRect();
        return { x: box.left + 6, y: box.top + box.height / 2 };
      })()`,
    );
    await clickAt(paragraphPoint);
    const paragraphMenu = await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        const item = document.getElementById("copyHeadingLink");
        const hidden = item.hidden;
        const display = getComputedStyle(item).display;
        document.getElementById("documentMenuButton").click();
        return { hidden, display };
      })()`,
    );
    check(
      "the copy-link item is not offered outside a heading",
      paragraphMenu.hidden === true && paragraphMenu.display === "none",
      JSON.stringify(paragraphMenu),
    );

    const headingPoint = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-line.is-h1");
        const box = line.getBoundingClientRect();
        return { x: box.left + 6, y: box.top + box.height / 2 };
      })()`,
    );
    await clickAt(headingPoint);
    // Stub the clipboard write so the copied address can be read back.
    await evaluate(
      cdp,
      `(() => {
        window.__copiedAnchorLink = "";
        try {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text) => {
                window.__copiedAnchorLink = text;
              },
            },
          });
        } catch (error) {
          window.__copiedAnchorLink = "unavailable";
        }
        return true;
      })()`,
    );
    const copyMenu = await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        const item = document.getElementById("copyHeadingLink");
        const visible = !item.hidden;
        const display = getComputedStyle(item).display;
        const label = item.textContent.trim();
        if (visible) {
          item.click();
        }
        return { visible, display, label };
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const copiedAnchorLink = await evaluate(cdp, `window.__copiedAnchorLink || ""`);
    const expectedAnchorLink = base + "/doc/" + anchorDocumentId + "#anchors-check";
    check(
      "the document menu offers a link to the heading the caret is in",
      copyMenu.visible && copyMenu.display !== "none" && copyMenu.label === "Copy link to heading",
      JSON.stringify(copyMenu),
    );
    check(
      "copying the heading link writes the anchored URL",
      copiedAnchorLink === expectedAnchorLink,
      copiedAnchorLink,
    );

    await evaluate(
      cdp,
      `fetch("/api/documents/" + encodeURIComponent(${JSON.stringify(anchorDocumentId)}), { method: "DELETE" })`,
    ).catch(() => null);

    // Closing a dialog has to leave the writer writing. Chrome restores focus
    // when a modal dialog closes without restoring the editing state, and can
    // drop it on the page body, so without the editor taking focus back the
    // keys arrive and nothing is typed until the page is reloaded. The typing
    // here is real key events on purpose: Input.insertText bypasses the path
    // the browser broke.
    async function typeCharacter(character) {
      const code = "Key" + character.toUpperCase();
      const virtualKeyCode = character.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: character,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        text: character,
        unmodifiedText: character,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: character,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
      });
    }

    async function clickSelector(selector) {
      const point = await evaluate(
        cdp,
        `(() => {
          const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        })()`,
      );
      await clickAt(point);
    }

    const dialogTypingId = await evaluate(
      cdp,
      `(async () => {
        const created = await fetch("/api/documents", { method: "POST" });
        if (!created.ok) throw new Error("create failed: " + created.status);
        const document = await created.json();
        const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Typing after a dialog",
            content: "<p>Close the dialog and keep typing.</p>",
          }),
        });
        if (!saved.ok) throw new Error("save failed: " + saved.status);
        return document.id;
      })()`,
    );

    // The whole line is selected before the dialog opens, so one typed letter
    // replaces it and the check can read the letter back from the paper.
    async function typesAfterDialog(close) {
      await cdp.send("Page.navigate", { url: base + "/doc/" + dialogTypingId });
      await waitForPage(cdp, base + "/doc/" + dialogTypingId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);
      await clickFirstLine();
      await pressKey("a", "KeyA", 65, 2);
      await clickSelector("#linkButton");
      const opened = await waitForExpression(
        cdp,
        `Boolean(document.getElementById("linkDialog").open)`,
        PAGE_TIMEOUT_MS,
      );
      // The dialog focuses its field after the frame that opens it, so a click
      // that arrives first is still a real click on a real button.
      await waitForExpression(
        cdp,
        `document.activeElement === document.getElementById("linkInput")`,
        PAGE_TIMEOUT_MS,
      );
      await close();
      const closed = await waitForExpression(
        cdp,
        `!document.getElementById("linkDialog").open`,
        PAGE_TIMEOUT_MS,
      );
      await typeCharacter("q");
      const blocks = await paintedBlocks(cdp);
      return {
        opened,
        closed,
        text: blocks.map((block) => block.text).join("|"),
        active: await evaluate(
          cdp,
          `document.activeElement ? document.activeElement.id || document.activeElement.tagName : ""`,
        ),
      };
    }

    function dialogTypingCheck(name, result) {
      check(
        name,
        result.opened && result.closed && result.text === "q",
        JSON.stringify(result),
      );
    }

    dialogTypingCheck(
      "typing works after the link dialog is cancelled",
      await typesAfterDialog(async () => {
        await clickSelector("#linkCancel");
      }),
    );
    dialogTypingCheck(
      "typing works after the link dialog adds a link",
      await typesAfterDialog(async () => {
        await cdp.send("Input.insertText", { text: "https://example.com/after-dialog" });
        await clickSelector("#linkApply");
      }),
    );
    dialogTypingCheck(
      "typing works after the link dialog is dismissed with Escape",
      await typesAfterDialog(async () => {
        await pressKey("Escape", "Escape", 27, 0);
      }),
    );
    dialogTypingCheck(
      "typing works after the link dialog is submitted with Enter",
      await typesAfterDialog(async () => {
        await cdp.send("Input.insertText", { text: "https://example.com/after-dialog" });
        await pressEnter();
      }),
    );

    // The delete dialog is opened from the same editor and its Cancel button
    // is the same kind of exit.
    const deleteCancelTyping = await (async () => {
      await cdp.send("Page.navigate", { url: base + "/doc/" + dialogTypingId });
      await waitForPage(cdp, base + "/doc/" + dialogTypingId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);
      await clickFirstLine();
      await pressKey("a", "KeyA", 65, 2);
      await evaluate(
        cdp,
        `(() => {
          document.getElementById("documentMenuButton").click();
          document.querySelector('[data-doc-action="delete"]').click();
        })()`,
      );
      const opened = await waitForExpression(
        cdp,
        `Boolean(document.getElementById("deleteDialog").open)`,
        PAGE_TIMEOUT_MS,
      );
      await clickSelector("#deleteCancel");
      const closed = await waitForExpression(
        cdp,
        `!document.getElementById("deleteDialog").open`,
        PAGE_TIMEOUT_MS,
      );
      await typeCharacter("q");
      const blocks = await paintedBlocks(cdp);
      return {
        opened,
        closed,
        text: blocks.map((block) => block.text).join("|"),
        active: await evaluate(
          cdp,
          `document.activeElement ? document.activeElement.id || document.activeElement.tagName : ""`,
        ),
      };
    })();
    dialogTypingCheck("typing works after the delete dialog is cancelled", deleteCancelTyping);

    const consoleErrors = cdp.events
      .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      .map((event) => event.params.args.map((arg) => arg.value || arg.description).join(" "));
    check("no console errors in the real editor", consoleErrors.length === 0, consoleErrors.join("\n"));

    // The library's card menu is placed by CSS rather than measured, and in
    // grid view it opens above its button. The opening animation starts from
    // --menu-shift, so the grid menu must start below its resting place and
    // rise out of the button, while the list menu settles down out of it.
    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    let libraryCards = 0;
    for (let attempt = 0; attempt < 60 && libraryCards === 0; attempt += 1) {
      // The loading placeholders are cards too; wait for the real ones.
      libraryCards = await evaluate(
        cdp,
        `document.querySelectorAll(".document-card:not(.document-card-skeleton)").length`,
      );
      if (libraryCards === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    check("the library lists the document as a card", libraryCards > 0);

    // The card menu's Duplicate document makes a brand new document: the copy
    // carries the same writing and its own id, and its card joins the library
    // without a reload.
    const duplicated = await evaluate(
      cdp,
      `(async () => {
        const sourceCard = Array.from(document.querySelectorAll(".document-card")).find(
          (candidate) =>
            candidate.querySelector(".document-card-title").textContent === ${JSON.stringify(longTitle)},
        );
        if (!sourceCard) return { error: "no source card" };
        sourceCard.querySelector(".card-menu-button").click();
        const item = sourceCard.querySelector(".card-duplicate");
        if (!item) return { error: "no duplicate item" };
        const menuOpen = !sourceCard.querySelector(".card-menu").hidden;
        const label = item.textContent.trim();
        item.click();

        for (let attempt = 0; attempt < 80; attempt += 1) {
          const copyCard = Array.from(document.querySelectorAll(".document-card")).find(
            (candidate) =>
              candidate.querySelector(".document-card-title").textContent ===
              ${JSON.stringify(longTitle + " (copy)")},
          );
          if (copyCard) {
            const copyId = copyCard.dataset.documentId;
            let focused = "";
            for (let frame = 0; frame < 40; frame += 1) {
              const active = document.activeElement;
              focused =
                active && active.closest(".document-card")
                  ? active.closest(".document-card").dataset.documentId
                  : "";
              if (focused === copyId) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const source = await (await fetch("/api/documents/${documentId}")).json();
            const copy = await (
              await fetch("/api/documents/" + encodeURIComponent(copyId))
            ).json();
            const listing = await (await fetch("/api/documents")).json();
            const toast = document.getElementById("toast");
            return {
              menuOpen,
              label,
              copyId,
              sourceId: source.id,
              copyTitle: copy.title,
              sameWriting: copy.content === source.content,
              listed: listing.documents.some((entry) => entry.id === copyId),
              cardCount: document.querySelectorAll(".document-card").length,
              firstCard: document.querySelector(".document-card").dataset.documentId,
              focused,
              toast: toast.textContent,
              toastVisible: toast.classList.contains("is-visible"),
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { error: "no copy card" };
      })()`,
    );
    check(
      "the card menu's Duplicate document creates a new document with the same writing",
      !duplicated.error &&
        duplicated.menuOpen &&
        duplicated.label === "Duplicate document" &&
        duplicated.sameWriting &&
        duplicated.copyTitle === longTitle + " (copy)" &&
        duplicated.copyId !== duplicated.sourceId &&
        duplicated.listed,
      JSON.stringify(duplicated),
    );
    check(
      "the duplicate gets its own card at the top of the library",
      !duplicated.error &&
        duplicated.firstCard === duplicated.copyId &&
        duplicated.cardCount === libraryCards + 1,
      JSON.stringify(duplicated),
    );
    check(
      "duplicating announces the copy and focuses its card",
      !duplicated.error &&
        duplicated.toast === "Document duplicated." &&
        duplicated.toastVisible &&
        duplicated.focused === duplicated.copyId,
      JSON.stringify(duplicated),
    );
    if (duplicated.copyId) {
      await evaluate(
        cdp,
        `fetch("/api/documents/" + encodeURIComponent(${JSON.stringify(duplicated.copyId)}), { method: "DELETE" })`,
      ).catch(() => null);
    }

    // Put the matching passage after the card preview. Search should find it,
    // display the surrounding text, and highlight the original spelling.
    const searchFixture = await evaluate(
      cdp,
      `(async () => {
        const filler = "filler words before the marker ".repeat(75);
        const content = "<p>" + filler + "</p><p>Needleword and R&amp;D notes</p>";
        const created = await fetch("/api/documents", { method: "POST" });
        if (!created.ok) throw new Error("create failed: " + created.status);
        const document = await created.json();
        const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Search depth check", content: content, paper_width: 0 }),
        });
        if (!saved.ok) throw new Error("save failed: " + saved.status);
        const listing = await (await fetch("/api/documents")).json();
        const summary = listing.documents.find((entry) => entry.id === document.id);
        return {
          id: document.id,
          excerptHasMarker: Boolean(summary && summary.excerpt.includes("Needleword")),
          previewHasMarker: Boolean(summary && summary.preview.includes("Needleword")),
        };
      })()`,
    );
    check(
      "the search fixture's marker is past both the excerpt and the preview",
      Boolean(searchFixture.id) &&
        searchFixture.excerptHasMarker === false &&
        searchFixture.previewHasMarker === false,
      JSON.stringify(searchFixture),
    );

    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".document-card:not(.document-card-skeleton)").length > 0`,
      PAGE_TIMEOUT_MS,
    );
    const searchField = await evaluate(
      cdp,
      `(() => {
        const box = document.getElementById("searchDocuments").getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      })()`,
    );
    await clickAt(searchField);
    await cdp.send("Input.insertText", { text: "needleword" });
    const readSearch = async () =>
      evaluate(
        cdp,
        `(() => ({
          value: document.getElementById("searchDocuments").value,
          ids: Array.from(document.querySelectorAll(".document-card")).map((card) => card.dataset.documentId),
          excerpt: document.querySelector(".document-search-excerpt:not([hidden])")?.textContent,
          match: document.querySelector(".document-search-excerpt mark")?.textContent,
          empty: !document.getElementById("emptyState").hidden,
        }))()`,
      );
    let deepSearch = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      deepSearch = await readSearch();
      if (deepSearch.ids.includes(searchFixture.id)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(
      "search finds and highlights a passage past the preview",
      deepSearch.value === "needleword" &&
        deepSearch.ids.includes(searchFixture.id) &&
        deepSearch.excerpt?.includes("Needleword and R&D notes") &&
        deepSearch.match === "Needleword" &&
        deepSearch.empty === false,
      JSON.stringify(deepSearch),
    );

    await evaluate(cdp, `document.getElementById("searchDocuments").select()`);
    await cdp.send("Input.insertText", { text: "R&D" });
    let ampersandSearch = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      ampersandSearch = await readSearch();
      if (ampersandSearch.match === "R&D") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(
      "search matches an ampersand typed into the field",
      ampersandSearch.value === "R&D" &&
        ampersandSearch.ids.includes(searchFixture.id) &&
        ampersandSearch.match === "R&D",
      JSON.stringify(ampersandSearch),
    );

    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("searchDocuments");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`,
    );
    await evaluate(
      cdp,
      `fetch("/api/documents/" + encodeURIComponent(${JSON.stringify(searchFixture.id)}), { method: "DELETE" })`,
    ).catch(() => null);

    const cardMenuShifts = await evaluate(
      cdp,
      `(() => {
        const documents = document.getElementById("documents");
        const toggle = document.getElementById("viewToggle");
        const shift = () => {
          const menu = documents.querySelector(".card-menu");
          return menu
            ? getComputedStyle(menu).getPropertyValue("--menu-shift").trim()
            : "";
        };
        const list = shift();
        toggle.click();
        const grid = shift();
        toggle.click();
        return { isGrid: documents.classList.contains("is-grid"), list, grid };
      })()`,
    );
    check(
      "the list card menu settles down out of its button",
      cardMenuShifts.list === "-6px",
      JSON.stringify(cardMenuShifts),
    );
    check(
      "the grid card menu settles up out of its button",
      cardMenuShifts.grid === "6px",
      JSON.stringify(cardMenuShifts),
    );

    // The list menu hangs over the rows below. Those rows are raised on hover,
    // so the card holding the open menu has to outrank every other card or a
    // row hovered behind the menu paints over it. Two extra documents make a
    // third row to hover.
    const layeringDocumentIds = await evaluate(
      cdp,
      `(async () => {
        const ids = [];
        for (const title of ["Layering first", "Layering second"]) {
          const created = await fetch("/api/documents", { method: "POST" });
          if (!created.ok) throw new Error("create failed: " + created.status);
          const document = await created.json();
          await fetch("/api/documents/" + encodeURIComponent(document.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, content: "<p>" + title + "</p>", paper_width: 0 }),
          });
          ids.push(document.id);
        }
        return ids;
      })()`,
    );
    check("the layering check has extra documents", layeringDocumentIds.length === 2);
    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    let layeringCards = 0;
    for (let attempt = 0; attempt < 60 && layeringCards < 3; attempt += 1) {
      layeringCards = await evaluate(
        cdp,
        `document.querySelectorAll(".document-card:not(.document-card-skeleton)").length`,
      );
      if (layeringCards < 3) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    check("the layering check sees three rows", layeringCards >= 3, String(layeringCards));
    const listRows = await evaluate(
      cdp,
      `(() => {
        if (document.getElementById("documents").classList.contains("is-grid")) {
          document.getElementById("viewToggle").click();
        }
        const cards = Array.from(document.querySelectorAll(".document-card"));
        return cards.map((card) => {
          const box = card.getBoundingClientRect();
          const button = card.querySelector(".card-menu-button").getBoundingClientRect();
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            buttonX: button.x + button.width / 2,
            buttonY: button.y + button.height / 2,
          };
        });
      })()`,
    );
    // The three-dots button only appears while its row is hovered.
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: listRows[0].x + 24,
      y: listRows[0].y + listRows[0].height / 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await clickAt({ x: listRows[0].buttonX, y: listRows[0].buttonY });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: listRows[2].x + listRows[2].width / 2,
      y: listRows[2].y + listRows[2].height / 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const menuOverRow = await evaluate(
      cdp,
      `(() => {
        const documents = document.getElementById("documents");
        const menu = documents.querySelector(".card-menu:not([hidden])");
        const cards = Array.from(documents.querySelectorAll(".document-card"));
        if (!menu || cards.length < 3) return { open: false };
        const menuBox = menu.getBoundingClientRect();
        const rowBox = cards[2].getBoundingClientRect();
        const top = Math.max(menuBox.top, rowBox.top) + 2;
        const bottom = Math.min(menuBox.bottom, rowBox.bottom) - 2;
        const hit = bottom > top
          ? document.elementFromPoint(menuBox.left + menuBox.width / 2, (top + bottom) / 2)
          : null;
        return {
          open: true,
          overlap: bottom > top,
          hoveredRow: cards[2].matches(":hover"),
          hitMenu: Boolean(hit && hit.closest(".card-menu")),
          openCardZ: getComputedStyle(menu.closest(".document-card")).zIndex,
          rowZ: getComputedStyle(cards[2]).zIndex,
        };
      })()`,
    );
    check(
      "an open card menu stays above the row hovered behind it",
      menuOverRow.open &&
        menuOverRow.overlap &&
        menuOverRow.hoveredRow &&
        menuOverRow.hitMenu,
      JSON.stringify(menuOverRow),
    );
    await evaluate(cdp, `document.body.click()`);
    for (const layeringId of layeringDocumentIds) {
      await evaluate(
        cdp,
        `fetch("/api/documents/${layeringId}", { method: "DELETE" })`,
      ).catch(() => null);
    }

    // Rich clipboard HTML is untrusted input from another program. Dispatch a
    // real paste event on the editor's hidden textarea so the event binding, the
    // clipboard reducer, the sanitizer, the debounced save, and a reload all run
    // end to end, then check the stored HTML and what the reload paints.
    const pasteHtml =
      "<h2>Pasted heading</h2>" +
      "<ul><li>one</li><li>Two <b>bold</b></li></ul>" +
      '<p>a <span style="font-style:italic">slanted</span> word</p>';
    const pasteText = "Pasted heading\none\nTwo bold\na slanted word";
    let pasteDocumentId = null;
    try {
      pasteDocumentId = await evaluate(
        cdp,
        `(async () => {
          const created = await fetch("/api/documents", { method: "POST" });
          if (!created.ok) throw new Error("create failed: " + created.status);
          const document = await created.json();
          const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Paste check", content: "<p></p>", paper_width: 0 }),
          });
          if (!saved.ok) throw new Error("save failed: " + saved.status);
          return document.id;
        })()`,
      );
      check("a paste document is created through the API", Boolean(pasteDocumentId));

      await cdp.send("Page.navigate", { url: base + "/doc/" + pasteDocumentId });
      await waitForPage(cdp, base + "/doc/" + pasteDocumentId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);

      const pasteEvent = await evaluate(
        cdp,
        `(() => {
          const clipboard = new DataTransfer();
          clipboard.setData("text/html", ${JSON.stringify(pasteHtml)});
          clipboard.setData("text/plain", ${JSON.stringify(pasteText)});
          const input = document.getElementById("docInput");
          const event = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          });
          return {
            input: Boolean(input),
            handled: input ? input.dispatchEvent(event) === false : false,
            html: clipboard.getData("text/html"),
          };
        })()`,
      );
      check(
        "the editor handles a real paste event dispatched on its textarea",
        pasteEvent.input && pasteEvent.handled && pasteEvent.html.includes("Pasted heading"),
        JSON.stringify(pasteEvent),
      );

      // The save is debounced, so read the API until it carries the paste.
      let pastedContent = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const stored = await evaluate(
          cdp,
          `(async () => (await fetch("/api/documents/${pasteDocumentId}")).json())()`,
        );
        pastedContent = String((stored && stored.content) || "");
        if (pastedContent.includes("Pasted heading")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      check(
        "the rich paste is saved as the document's semantic HTML",
        pastedContent.includes("<h2>Pasted heading</h2>") &&
          pastedContent.includes("<ul><li>one</li><li>Two <b>bold</b></li></ul>"),
        pastedContent,
      );
      check(
        "the pasted marks are stored as tags, not inline styles",
        pastedContent.includes("<b>bold</b>") && pastedContent.includes("<i>slanted</i>"),
        pastedContent,
      );
      check(
        "the paste drops the span wrapper and its style before saving",
        !pastedContent.includes("style=") && !pastedContent.includes("<span"),
        pastedContent,
      );

      await cdp.send("Page.navigate", { url: base + "/doc/" + pasteDocumentId });
      await waitForPage(cdp, base + "/doc/" + pasteDocumentId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);
      const pastedBlocks = await paintedBlocks(cdp);
      const pastedTexts = pastedBlocks.map((block) => block.text);
      equal("a reload paints the pasted heading first", pastedTexts[0], "Pasted heading");
      check(
        "a reload paints the pasted list items with bullets",
        pastedBlocks.length === 4 &&
          pastedBlocks[1].marker === "\u2022" &&
          pastedBlocks[2].marker === "\u2022" &&
          pastedTexts[1] === "one" &&
          pastedTexts[2] === "Two bold",
        JSON.stringify(pastedBlocks),
      );
      equal("a reload paints the pasted italic paragraph last", pastedTexts[3], "a slanted word");
    } finally {
      if (pasteDocumentId) {
        await evaluate(
          cdp,
          `fetch("/api/documents/${pasteDocumentId}", { method: "DELETE" })`,
        ).catch(() => null);
      }
    }

    // Markdown line shortcuts in the rendered editor go through the real
    // keyboard path: "- " starts a bullet and "# " starts a heading, both with
    // the marker consumed and the result saved as the app's HTML.
    let shortcutDocumentId = null;
    try {
      shortcutDocumentId = await evaluate(
        cdp,
        `(async () => {
          const created = await fetch("/api/documents", { method: "POST" });
          if (!created.ok) throw new Error("create failed: " + created.status);
          const document = await created.json();
          const saved = await fetch("/api/documents/" + encodeURIComponent(document.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Shortcut check", content: "<p></p>", paper_width: 0 }),
          });
          if (!saved.ok) throw new Error("save failed: " + saved.status);
          return document.id;
        })()`,
      );
      await cdp.send("Page.navigate", { url: base + "/doc/" + shortcutDocumentId });
      await waitForPage(cdp, base + "/doc/" + shortcutDocumentId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);

      const waitForShortcutContent = async (probe) => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const content = await evaluate(
            cdp,
            `(async () => {
              const response = await fetch("/api/documents/${shortcutDocumentId}");
              const document = await response.json();
              return document.content || "";
            })()`,
          );
          if (content && content.includes(probe)) {
            return content;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return "";
      };
      const typeChar = async (key, code, virtualKeyCode, text) => {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          text,
          unmodifiedText: text,
          windowsVirtualKeyCode: virtualKeyCode,
          nativeVirtualKeyCode: virtualKeyCode,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode: virtualKeyCode,
          nativeVirtualKeyCode: virtualKeyCode,
        });
      };

      const emptyLinePoint = await evaluate(
        cdp,
        `(() => {
          const line = document.querySelector(".doc-content > .doc-block .doc-line");
          const box = line.getBoundingClientRect();
          return { x: box.left + 40, y: box.top + box.height / 2 };
        })()`,
      );
      await clickAt(emptyLinePoint);

      await typeChar("-", "Minus", 189, "-");
      await typeChar(" ", "Space", 32, " ");
      await cdp.send("Input.insertText", { text: "item" });
      const bulletContent = await waitForShortcutContent("<ul><li>item</li></ul>");
      check(
        "typing - and a space saves a bullet list",
        Boolean(bulletContent),
        bulletContent,
      );
      const bulletBlocks = await paintedBlocks(cdp);
      check(
        "the shortcut paints a bullet item",
        bulletBlocks.length === 1 &&
          bulletBlocks[0].text === "item" &&
          bulletBlocks[0].marker === "\u2022",
        JSON.stringify(bulletBlocks),
      );

      await pressKey("Enter", "Enter", 13, 0);
      await typeChar("#", "Digit3", 51, "#");
      await typeChar(" ", "Space", 32, " ");
      await cdp.send("Input.insertText", { text: "Title" });
      const headingContent = await waitForShortcutContent("<h1>Title</h1>");
      check(
        "typing # and a space saves a Heading 1",
        Boolean(headingContent),
        headingContent,
      );
      check(
        "the heading marker is not left in the saved HTML",
        !headingContent.includes("#Title") && !headingContent.includes("# Title"),
        headingContent,
      );
      const headingPaint = await evaluate(
        cdp,
        `document.querySelector(".doc-block .doc-line.is-h1")?.textContent || ""`,
      );
      equal("the shortcut paints Heading 1", headingPaint, "Title");

      await cdp.send("Page.navigate", { url: base + "/doc/" + shortcutDocumentId });
      await waitForPage(cdp, base + "/doc/" + shortcutDocumentId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);
      const reloadedShortcut = await paintedBlocks(cdp);
      const reloadedHeading = await evaluate(
        cdp,
        `document.querySelector(".doc-block .doc-line.is-h1")?.textContent || ""`,
      );
      check(
        "the shortcut document reloads as a bullet list and a heading",
        reloadedShortcut.length === 2 &&
          reloadedShortcut[0].marker === "\u2022" &&
          reloadedShortcut[0].text === "item" &&
          reloadedHeading === "Title",
        JSON.stringify({ reloadedShortcut, reloadedHeading }),
      );
    } finally {
      if (shortcutDocumentId) {
        await evaluate(
          cdp,
          `fetch("/api/documents/${shortcutDocumentId}", { method: "DELETE" })`,
        ).catch(() => null);
      }
    }

    // The shortcuts page is one static page behind every top-right menu. Check
    // both sections, the links that reach it, and the narrow layout.
    await cdp.send("Page.navigate", { url: base + "/shortcuts" });
    await waitForPage(cdp, base + "/shortcuts", PAGE_TIMEOUT_MS);
    const shortcutsPage = await evaluate(
      cdp,
      `(() => {
        const link = document.querySelector('#pageMenu a[href="/shortcuts"]');
        return {
          path: location.pathname,
          headings: Array.from(document.querySelectorAll(".shortcuts-section h2")).map(
            (heading) => heading.textContent,
          ),
          rows: document.querySelectorAll(".shortcut-row").length,
          saveKey: Array.from(document.querySelectorAll(".shortcut-row kbd")).some(
            (key) => key.textContent === "Ctrl+S",
          ),
          menuLink: Boolean(link),
          current: link ? link.getAttribute("aria-current") : null,
        };
      })()`,
    );
    equal("the shortcuts page is served", shortcutsPage.path, "/shortcuts");
    check(
      "the shortcuts page has an editor section and an other section",
      shortcutsPage.headings[0] === "In the editor" &&
        shortcutsPage.headings[1] === "Outside the editor",
      JSON.stringify(shortcutsPage.headings),
    );
    check(
      "the shortcuts page lists the keys",
      shortcutsPage.rows >= 20 && shortcutsPage.saveKey,
      JSON.stringify(shortcutsPage),
    );
    check(
      "the page menu links to the shortcuts page and marks it current",
      shortcutsPage.menuLink && shortcutsPage.current === "page",
      JSON.stringify(shortcutsPage),
    );

    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    const libraryMenuShortcuts = await evaluate(
      cdp,
      `Boolean(document.querySelector('#libraryMenu a[href="/shortcuts"]'))`,
    );
    check("the library menu links to the shortcuts page", libraryMenuShortcuts);

    // Opening the page from the editor has to save a pending edit first.
    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    const documentMenuShortcuts = await evaluate(
      cdp,
      `Boolean(document.querySelector('#documentMenu a[href="/shortcuts"]'))`,
    );
    check("the document menu links to the shortcuts page", documentMenuShortcuts);

    const firstLinePoint = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-content > .doc-block .doc-line");
        const box = line.getBoundingClientRect();
        return { x: box.left + 40, y: box.top + box.height / 2 };
      })()`,
    );
    await clickAt(firstLinePoint);
    await pressKey("End", "End", 35, 0);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Z",
      code: "KeyZ",
      text: "Z",
      unmodifiedText: "Z",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Z",
      code: "KeyZ",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
    });
    await evaluate(cdp, `document.getElementById("shortcutsLink").click()`);
    await waitForPage(cdp, base + "/shortcuts", PAGE_TIMEOUT_MS);
    const savedBeforeLeaving = await evaluate(
      cdp,
      `(async () => (await fetch("/api/documents/${documentId}")).json())()`,
    );
    check(
      "opening the shortcuts page from the editor saves the pending edit first",
      Boolean(
        savedBeforeLeaving &&
          savedBeforeLeaving.content &&
          savedBeforeLeaving.content.includes("spaces.Z"),
      ),
      savedBeforeLeaving && savedBeforeLeaving.content,
    );

    // The narrow page wraps the key and the description instead of overflowing
    // the viewport.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Page.navigate", { url: base + "/shortcuts" });
    await waitForPage(cdp, base + "/shortcuts", PAGE_TIMEOUT_MS);
    const shortcutsMobile = await evaluate(
      cdp,
      `({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        rows: document.querySelectorAll(".shortcut-row").length,
      })`,
    );
    check(
      "the shortcuts page has no horizontal overflow at 390px",
      shortcutsMobile.scrollWidth <= shortcutsMobile.innerWidth + 1,
      `innerWidth ${shortcutsMobile.innerWidth}, scrollWidth ${shortcutsMobile.scrollWidth}`,
    );
    equal(
      "the shortcuts page keeps its rows on a narrow viewport",
      shortcutsMobile.rows,
      shortcutsPage.rows,
    );
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    // Ctrl+O searches the library from any page except the password gate. It
    // lists the real documents, filters as you type, and opens the selected
    // one in this tab or in another one.
    const paletteDocuments = await evaluate(
      cdp,
      `(async () => {
        const created = [];
        for (const title of ["Palette Alpha", "Palette Beta"]) {
          const response = await fetch("/api/documents", { method: "POST" });
          if (!response.ok) throw new Error("create failed: " + response.status);
          const document = await response.json();
          await fetch("/api/documents/" + encodeURIComponent(document.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, content: "<p>" + title + "</p>", paper_width: 0 }),
          });
          created.push({ id: document.id, title });
        }
        return created;
      })()`,
    );
    const paletteIds = new Map(paletteDocuments.map((entry) => [entry.title, entry.id]));

    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    const lazyPalette = await evaluate(
      cdp,
      `Boolean(document.querySelector("dialog.quick-open"))`,
    );
    check("the document search is not built before it is opened", lazyPalette === false);

    await pressKey("o", "KeyO", 79, 2);
    const paletteOpened = await waitForExpression(
      cdp,
      `(() => {
        const dialog = document.querySelector("dialog.quick-open[open]");
        const input = document.getElementById("quickOpenInput");
        return Boolean(
          dialog?.getAttribute("aria-label") === "Open by title" &&
          input?.placeholder === "Open by title" &&
          document.activeElement === input,
        );
      })()`,
      PAGE_TIMEOUT_MS,
    );
    check("Ctrl+O opens Open by title on the library", paletteOpened);

    const listedPaletteDocuments = await waitForExpression(
      cdp,
      `Array.from(document.querySelectorAll(".quick-open-title")).some(
        (title) => title.textContent === "Palette Beta",
      )`,
      5000,
    );
    const paletteSnapshot = await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("quickOpenInput");
        const list = document.getElementById("quickOpenList");
        return {
          titles: Array.from(document.querySelectorAll(".quick-open-title")).map(
            (title) => title.textContent,
          ),
          combobox: input ? input.getAttribute("role") : null,
          controls: input ? input.getAttribute("aria-controls") : null,
          expanded: input ? input.getAttribute("aria-expanded") : null,
          listRole: list ? list.getAttribute("role") : null,
        };
      })()`,
    );
    check(
      "the document search lists the library and exposes it as a combobox",
      listedPaletteDocuments &&
        paletteSnapshot.titles.includes("Palette Alpha") &&
        paletteSnapshot.titles.includes("Palette Beta") &&
        paletteSnapshot.combobox === "combobox" &&
        paletteSnapshot.controls === "quickOpenList" &&
        paletteSnapshot.expanded === "true" &&
        paletteSnapshot.listRole === "listbox",
      JSON.stringify(paletteSnapshot),
    );

    // Let the dialog's opening animation finish so the height check below is
    // not comparing a mid-animation transform with the settled layout.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const hintsAtOpen = await evaluate(
      cdp,
      `(() => {
        const hints = document.querySelector(".quick-open-hints");
        return {
          visibility: getComputedStyle(hints).visibility,
          opacity: getComputedStyle(hints).opacity,
          transition: getComputedStyle(hints).transitionDuration,
          footerHeight: document.querySelector(".quick-open-footer").getBoundingClientRect().height,
          dialogHeight: document.querySelector("dialog.quick-open[open]").getBoundingClientRect().height,
        };
      })()`,
    );
    check(
      "the shortcut hints start visible with a fade transition",
      hintsAtOpen.visibility === "visible" &&
        hintsAtOpen.opacity === "1" &&
        hintsAtOpen.transition.includes("0.24s"),
      JSON.stringify(hintsAtOpen),
    );

    await new Promise((resolve) => setTimeout(resolve, 3600));
    const hintsAfterTimeout = await evaluate(
      cdp,
      `(() => {
        const hints = document.querySelector(".quick-open-hints");
        return {
          visibility: getComputedStyle(hints).visibility,
          opacity: getComputedStyle(hints).opacity,
          hidden: hints.getAttribute("aria-hidden"),
          footerHeight: document.querySelector(".quick-open-footer").getBoundingClientRect().height,
          dialogHeight: document.querySelector("dialog.quick-open[open]").getBoundingClientRect().height,
        };
      })()`,
    );
    check(
      "the shortcut hints fade out after three seconds without moving the palette",
      hintsAfterTimeout.visibility === "hidden" &&
        hintsAfterTimeout.opacity === "0" &&
        hintsAfterTimeout.hidden === "true" &&
        Math.abs(hintsAfterTimeout.footerHeight - hintsAtOpen.footerHeight) < 0.5 &&
        Math.abs(hintsAfterTimeout.dialogHeight - hintsAtOpen.dialogHeight) < 0.5,
      JSON.stringify({ hintsAtOpen, hintsAfterTimeout }),
    );

    await cdp.send("Input.insertText", { text: "palette" });
    const filteredPalette = await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length === 2`,
      5000,
    );
    const filteredSnapshot = await evaluate(
      cdp,
      `({
        titles: Array.from(document.querySelectorAll(".quick-open-title")).map(
          (title) => title.textContent,
        ),
        marks: document.querySelectorAll(".quick-open-match").length,
        count: document.querySelector(".quick-open-count").textContent,
      })`,
    );
    check(
      "typing filters the document search and highlights the match",
      filteredPalette &&
        filteredSnapshot.titles.every((title) => title.startsWith("Palette ")) &&
        filteredSnapshot.marks >= 2 &&
        /\d+ of \d+/.test(filteredSnapshot.count),
      JSON.stringify(filteredSnapshot),
    );

    await cdp.send("Input.insertText", { text: "zzzz" });
    const emptyPalette = await waitForExpression(
      cdp,
      `(() => {
        const message = document.getElementById("quickOpenMessage");
        return Boolean(
          message &&
          !message.hidden &&
          message.textContent.includes("No matching titles"),
        );
      })()`,
      5000,
    );
    check("a search with no title match says so", emptyPalette);

    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("quickOpenInput");
        input.value = "palette";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length === 2`,
      5000,
    );
    const selectedBefore = await evaluate(
      cdp,
      `document.querySelector('.quick-open-option[aria-selected="true"] .quick-open-title').textContent`,
    );
    await pressKey("ArrowDown", "ArrowDown", 40, 0);
    const selectedAfter = await evaluate(
      cdp,
      `document.querySelector('.quick-open-option[aria-selected="true"] .quick-open-title').textContent`,
    );
    check(
      "the arrow keys move the selected document",
      Boolean(selectedBefore) &&
        Boolean(selectedAfter) &&
        selectedBefore !== selectedAfter &&
        selectedBefore.startsWith("Palette ") &&
        selectedAfter.startsWith("Palette "),
      JSON.stringify({ selectedBefore, selectedAfter }),
    );

    const chosenId = paletteIds.get(selectedAfter);
    await pressKey("Enter", "Enter", 13, 0);
    await waitForPage(cdp, base + "/doc/" + chosenId, PAGE_TIMEOUT_MS);
    equal(
      "Enter opens the selected document",
      await evaluate(cdp, `location.pathname`),
      "/doc/" + chosenId,
    );

    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    await pressKey("o", "KeyO", 79, 2);
    await waitForExpression(
      cdp,
      `Boolean(
        document.querySelector("dialog.quick-open[open]") &&
        document.getElementById("quickOpenInput"),
      )`,
      PAGE_TIMEOUT_MS,
    );
    const hintsReset = await evaluate(
      cdp,
      `(() => {
        const hints = document.querySelector(".quick-open-hints");
        return {
          visibility: getComputedStyle(hints).visibility,
          hidden: hints.getAttribute("aria-hidden"),
        };
      })()`,
    );
    check(
      "reopening the document search brings the shortcut hints back",
      hintsReset.visibility === "visible" && hintsReset.hidden === null,
      JSON.stringify(hintsReset),
    );
    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("quickOpenInput");
        input.value = "beta";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length === 1`,
      5000,
    );
    const betaUrl = base + "/doc/" + paletteIds.get("Palette Beta");
    await pressKey("Enter", "Enter", 13, 8);
    const newTab = await waitForNewPage(devtoolsPort, betaUrl, PAGE_TIMEOUT_MS);
    check(
      "Shift+Enter opens the document in another tab",
      Boolean(newTab),
      JSON.stringify(newTab),
    );
    check(
      "the document search closes when it opens another tab",
      await waitForExpression(
        cdp,
        `!document.querySelector("dialog.quick-open[open]")`,
        5000,
      ),
    );
    if (newTab) {
      await fetch(`http://127.0.0.1:${devtoolsPort}/json/close/${newTab.id}`).catch(
        () => null,
      );
    }

    // CDP key events do not carry the user activation a real key press does,
    // so the keyboard path above can only prove that a page opened. Chrome
    // picks a tab in the same window only when the navigation has user
    // activation; Runtime.evaluate's userGesture supplies it, and the row's
    // click handler then runs the same choose(true) code a real gesture runs.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await pressKey("o", "KeyO", 79, 2);
    await waitForExpression(
      cdp,
      `Boolean(
        document.querySelector("dialog.quick-open[open]") &&
        document.getElementById("quickOpenInput"),
      )`,
      PAGE_TIMEOUT_MS,
    );
    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("quickOpenInput");
        input.value = "beta";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length === 1`,
      5000,
    );
    const currentWindow = await cdp.send("Browser.getWindowForTarget", {});
    check(
      "Shift+clicking a document starts a new tab",
      await evaluate(
        cdp,
        `(() => {
          const option = document.querySelector(".quick-open-option");
          if (!option) return false;
          option.dispatchEvent(
            new MouseEvent("click", { bubbles: true, shiftKey: true }),
          );
          return true;
        })()`,
      ),
    );
    const shiftClickTab = await waitForNewPage(devtoolsPort, betaUrl, PAGE_TIMEOUT_MS);
    check(
      "Shift+clicking a document opens it in another tab",
      Boolean(shiftClickTab),
      JSON.stringify(shiftClickTab),
    );
    if (shiftClickTab) {
      const tabWindow = await cdp.send("Browser.getWindowForTarget", {
        targetId: shiftClickTab.id,
      });
      check(
        "opening a document in another tab stays in the same browser window",
        tabWindow.windowId === currentWindow.windowId,
        JSON.stringify({ currentWindow, tabWindow }),
      );
      await fetch(
        `http://127.0.0.1:${devtoolsPort}/json/close/${shiftClickTab.id}`,
      ).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // The editor has its own keyboard handling, so the palette has to sit above
    // it, and a pending edit has to reach disk before the palette navigates.
    await cdp.send("Page.navigate", { url: base + "/doc/" + documentId });
    await waitForPage(cdp, base + "/doc/" + documentId, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    const editorLinePoint = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-content > .doc-block .doc-line");
        const box = line.getBoundingClientRect();
        return { x: box.left + 40, y: box.top + box.height / 2 };
      })()`,
    );
    await clickAt(editorLinePoint);
    await pressKey("End", "End", 35, 0);
    await cdp.send("Input.insertText", { text: " palette-leave" });
    await pressKey("o", "KeyO", 79, 2);
    check(
      "Ctrl+O opens the document search in the editor",
      await waitForExpression(
        cdp,
        `(() => {
          const input = document.getElementById("quickOpenInput");
          return Boolean(
            document.querySelector("dialog.quick-open[open]") &&
            input &&
            document.activeElement === input,
          );
        })()`,
        PAGE_TIMEOUT_MS,
      ),
    );
    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("quickOpenInput");
        input.value = "beta";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length === 1`,
      5000,
    );
    await pressKey("Escape", "Escape", 27, 0);
    check(
      "Escape from the document search returns to the editor",
      await waitForExpression(
        cdp,
        `Boolean(
          document.getElementById("quickOpenInput") &&
          !document.querySelector("dialog.quick-open[open]"),
        )`,
        5000,
      ),
    );

    await pressKey("o", "KeyO", 79, 2);
    await waitForExpression(
      cdp,
      `Boolean(document.querySelector("dialog.quick-open[open]"))`,
      PAGE_TIMEOUT_MS,
    );
    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById("quickOpenInput");
        input.value = "beta";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length === 1`,
      5000,
    );
    await pressKey("Enter", "Enter", 13, 0);
    await waitForPage(
      cdp,
      base + "/doc/" + paletteIds.get("Palette Beta"),
      PAGE_TIMEOUT_MS,
    );
    const savedFromEditor = await evaluate(
      cdp,
      `(async () => (await fetch("/api/documents/${documentId}")).json())()`,
    );
    check(
      "opening a document from the editor saves the pending edit first",
      Boolean(
        savedFromEditor &&
          savedFromEditor.content &&
          savedFromEditor.content.includes("palette-leave"),
      ),
      savedFromEditor && savedFromEditor.content,
    );

    await cdp.send("Page.navigate", { url: base + "/storage" });
    await waitForPage(cdp, base + "/storage", PAGE_TIMEOUT_MS);
    await pressKey("o", "KeyO", 79, 2);
    check(
      "the document search opens on the storage page",
      await waitForExpression(
        cdp,
        `Boolean(document.querySelector("dialog.quick-open[open]"))`,
        PAGE_TIMEOUT_MS,
      ),
    );
    await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length > 0`,
      5000,
    );
    await pressKey("Escape", "Escape", 27, 0);
    check(
      "Escape closes the document search",
      await waitForExpression(
        cdp,
        `!document.querySelector("dialog.quick-open[open]")`,
        5000,
      ),
    );

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Page.navigate", { url: base + "/" });
    await waitForPage(cdp, base + "/", PAGE_TIMEOUT_MS);
    await pressKey("o", "KeyO", 79, 2);
    await waitForExpression(
      cdp,
      `Boolean(document.querySelector("dialog.quick-open[open]"))`,
      PAGE_TIMEOUT_MS,
    );
    const paletteMobile = await evaluate(
      cdp,
      `(() => {
        const dialog = document.querySelector("dialog.quick-open[open]");
        const box = dialog.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          left: box.left,
          right: box.right,
        };
      })()`,
    );
    check(
      "the document search fits a 390px viewport",
      paletteMobile.left >= 0 &&
        paletteMobile.right <= paletteMobile.innerWidth + 1 &&
        paletteMobile.scrollWidth <= paletteMobile.innerWidth + 1,
      JSON.stringify(paletteMobile),
    );
    await pressKey("Escape", "Escape", 27, 0);
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    await evaluate(
      cdp,
      `(async () => {
        for (const id of ${JSON.stringify(paletteDocuments.map((entry) => entry.id))}) {
          await fetch("/api/documents/" + encodeURIComponent(id), { method: "DELETE" });
        }
        return true;
      })()`,
    ).catch(() => null);

    await evaluate(
      cdp,
      `fetch("/api/documents/${documentId}", { method: "DELETE" })`,
    ).catch(() => null);
  } finally {
    if (cdp) {
      cdp.close();
    }
    const browserExited = browser
      ? new Promise((resolve) => browser.once("exit", resolve))
      : Promise.resolve();
    const serverExited = new Promise((resolve) => server.once("exit", resolve));
    if (browser && browser.exitCode === null) {
      browser.kill();
    }
    if (server.exitCode === null) {
      server.kill();
    }
    await Promise.race([Promise.all([browserExited, serverExited]), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (imageDir) {
      await rm(imageDir, { recursive: true, force: true }).catch(() => {});
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failures.length} failed`);
  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
