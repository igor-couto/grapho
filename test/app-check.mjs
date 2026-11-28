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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

    // A view round trip should preserve both stacks. Edits made during a
    // Markdown visit become one reversible edit in the rich view.
    await pressKey("End", "End", 35, 2);
    await cdp.send("Input.insertText", { text: " RichHistoryMarker" });
    const markerVisible = () => evaluate(cdp, `document.querySelector(".doc-content").textContent.includes("RichHistoryMarker")`);
    check("the rich edit is visible before the Markdown round trip", await markerVisible());
    await enterMarkdown();
    await leaveMarkdown();
    await pressKey("z", "KeyZ", 90, 2);
    check("undo still works after an unchanged Markdown round trip", !(await markerVisible()));
    await enterMarkdown();
    await leaveMarkdown();
    await pressKey("Z", "KeyZ", 90, 10);
    check("redo still works after an unchanged Markdown round trip", await markerVisible());
    await enterMarkdown();
    await pressKey("End", "End", 35, 2);
    await cdp.send("Input.insertText", { text: " MarkdownHistoryMarker" });
    await leaveMarkdown();
    await pressKey("z", "KeyZ", 90, 2);
    check(
      "undo reverts Markdown edits in the rich view",
      (await markerVisible()) &&
        !(await evaluate(cdp, `document.querySelector(".doc-content").textContent.includes("MarkdownHistoryMarker")`)),
    );
    await pressKey("z", "KeyZ", 90, 2);
    check("the older rich edits are still undoable", !(await markerVisible()));

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
        const target = await create("Link target page",
          "<p>Target body.</p><h2>Target <em>heading</em></h2><h3>Target heading</h3><h1>Résumé</h1>");
        const filler = "<p>A paragraph of the release notes.</p>".repeat(30);
        return {
          blank: await create("Blank link source", ""),
          target,
          reader: await create("Release notes", filler + '<p>See <a href="/doc/' + target + '">the checklist</a>.</p>' + filler),
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

    await cdp.send("Page.navigate", { url: base + "/doc/" + linkPages.blank });
    await waitForPage(cdp, base + "/doc/" + linkPages.blank, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    await clickFirstLine();
    await pressKey("k", "KeyK", 75, 2);
    check("Ctrl+K opens the page picker at an empty caret", await waitForLinkResults());
    await cdp.send("Input.insertText", { text: "Link target page" });
    await pressEnter();
    const insertedLink = await paintedLink();
    check(
      "the page title becomes the linked label and is saved",
      insertedLink?.text === "Link target page" &&
        insertedLink.href === targetHref &&
        await waitForSavedLinkContent(linkPages.blank, 'href="' + targetHref + '">Link target page</a>'),
      JSON.stringify(insertedLink),
    );

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
        linkPicker.listRole === "grid",
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

    // Heading choices reuse the editor's deduplicated anchors and preserve
    // the selected words in the source document.
    await pressKey("z", "KeyZ", 90, 2);
    await selectWholeDocument();
    check("the link dialog reopens to choose a heading", await openLinkDialogForTest());
    await waitForExpression(
      cdp,
      `document.activeElement && document.activeElement.id === "linkInput"`,
      PAGE_TIMEOUT_MS,
    );
    await cdp.send("Input.insertText", { text: "Link target page" });
    await waitForLinkResults();
    await pressKey("ArrowRight", "ArrowRight", 39);
    check(
      "Right shows all headings in document order",
      await waitForExpression(cdp,
        `Array.from(document.querySelectorAll("#linkResultsList .link-heading .link-result-title"),
          (heading) => heading.textContent).join("|") === "Target heading|Target heading|Résumé"`,
        PAGE_TIMEOUT_MS),
    );
    await pressKey("ArrowLeft", "ArrowLeft", 37);
    check(
      "Left restores the search and its selected document",
      await evaluate(cdp, `linkInput.value === "Link target page" && linkResultsBack.hidden &&
        document.querySelector('#linkResultsList [aria-selected="true"] .link-result-title')
          ?.textContent === "Link target page"`),
    );
    await clickSelector("#linkResultsList .link-result-arrow");
    await waitForExpression(cdp, `document.querySelectorAll("#linkResultsList .link-heading").length === 3`, PAGE_TIMEOUT_MS);
    await pressKey("ArrowDown", "ArrowDown", 40);
    await pressEnter();
    const fragmentLink = await paintedLink();
    check(
      "choosing a repeated heading links its own anchor and keeps the selected wording",
      fragmentLink?.href === targetHref + "#target-heading-2" && fragmentLink.text === "Link this phrase now.",
      JSON.stringify(fragmentLink),
    );
    check(
      "the fragment link is saved",
      await waitForSavedLinkContent(linkPages.source, 'href="' + targetHref + '#target-heading-2"'),
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
    const readerUrl = base + "/doc/" + linkPages.reader;
    await cdp.send("Page.navigate", { url: readerUrl });
    await waitForPage(cdp, readerUrl, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    const readingTop = await evaluate(cdp, `(() => {
      const link = document.querySelector(".m-link");
      link.scrollIntoView({ block: "center", behavior: "instant" });
      return link.getBoundingClientRect().top;
    })()`);
    await tapToolbar(".m-link");
    check("tapping a link shows the destination's title and keeps the keyboard closed",
      await waitForExpression(cdp, `!linkPopover.hidden && linkDestination.textContent === "Link target page"
        && document.activeElement.id !== "docInput"`, PAGE_TIMEOUT_MS));
    await tapToolbar("#linkEdit");
    check("Edit opens the existing link", await evaluate(cdp,
      `linkDialog.open && linkInput.value === ${JSON.stringify(targetHref)}`));
    await tapToolbar("#linkCancel");
    await tapToolbar(".m-link");
    await tapToolbar("#linkOpen");
    await waitForPage(cdp, base + targetHref, PAGE_TIMEOUT_MS);
    await evaluate(cdp, "history.back()");
    await waitForPage(cdp, readerUrl, PAGE_TIMEOUT_MS);
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    check("Back returns to the paragraph that contained the link", await waitForExpression(cdp,
      `linkPopover.hidden && Math.abs(document.querySelector(".m-link").getBoundingClientRect().top - ${readingTop}) < 8`,
      PAGE_TIMEOUT_MS));

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

    // The context menu acts on the heading under the pointer, even while
    // the editing caret is elsewhere.
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
    const headingPoint = await evaluate(
      cdp,
      `(() => {
        const line = document.querySelector(".doc-line.is-h1");
        const box = line.getBoundingClientRect();
        return { x: box.left + 6, y: box.top + box.height / 2 };
      })()`,
    );
    await clickAt(headingPoint);
    await clickSelector("#documentMenuButton");
    check(
      "the document menu no longer offers to copy the heading link",
      await evaluate(cdp, `!document.querySelector("#documentMenu").textContent.includes("Copy link to heading")`),
    );
    await clickAt(paragraphPoint);
    await evaluate(
      cdp,
      `(() => {
        window.__copiedAnchorLink = "";
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text) => { window.__copiedAnchorLink = text; } },
        });
        document.addEventListener("contextmenu", (event) => {
          window.__usedCustomMenu = event.defaultPrevented;
          event.preventDefault();
        });
      })()`,
    );
    await rightClickAt(paragraphPoint);
    check(
      "a right click in a paragraph does not open heading options",
      await evaluate(cdp, `window.__usedCustomMenu === false && document.getElementById("headingMenu").hidden`),
    );
    await rightClickAt(headingPoint);
    check(
      "right-clicking a heading opens its context menu and focuses Copy link to heading",
      await evaluate(cdp, `window.__usedCustomMenu && !document.getElementById("headingMenu").hidden &&
        document.activeElement.id === "copyHeadingLink" &&
        document.activeElement.textContent.trim() === "Copy link to heading"`),
    );
    await clickSelector("#copyHeadingLink");
    const copiedAnchorLink = await evaluate(cdp, `window.__copiedAnchorLink`);
    check(
      "copying writes the URL of the clicked heading even when the caret is in a paragraph",
      copiedAnchorLink === base + "/doc/" + anchorDocumentId + "#anchors-check",
      copiedAnchorLink,
    );
    await clickAt(headingPoint);
    await pressKey("F10", "F10", 121, 8);
    check(
      "Shift+F10 opens the heading context menu from the caret",
      await evaluate(cdp, `document.activeElement.id === "copyHeadingLink"`),
    );
    await pressKey("Escape", "Escape", 27);
    check(
      "Escape closes the heading context menu and returns focus to the editor",
      await evaluate(cdp, `document.getElementById("headingMenu").hidden && document.activeElement.id === "docInput"`),
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

    await clickFirstLine();
    await pressKey("a", "KeyA", 65, 2);
    await cdp.send("Input.insertText", { text: "Last draft before deletion." });
    await evaluate(
      cdp,
      `(() => {
        document.getElementById("documentMenuButton").click();
        document.querySelector('[data-doc-action="delete"]').click();
        document.getElementById("deleteConfirm").click();
      })()`,
    );
    await waitForExpression(
      cdp,
      `location.pathname === "/" && Boolean(document.querySelector(".document-card[data-document-id]"))`,
      PAGE_TIMEOUT_MS,
    );
    const deletedRow = `#recentlyDeletedList [data-document-id="${dialogTypingId}"]`;
    const libraryRow = `#documents [data-document-id="${dialogTypingId}"]`;
    check(
      "the deleted document is absent from the library",
      !(await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(libraryRow)}))`)),
    );
    await evaluate(cdp, `document.getElementById("recentlyDeletedButton").click()`);
    check(
      "the deleted document appears in Recently deleted",
      await waitForExpression(cdp, `Boolean(document.querySelector(${JSON.stringify(deletedRow)}))`, PAGE_TIMEOUT_MS),
    );
    await clickSelector(deletedRow + " button");
    check(
      "restoring puts the original document back in the library",
      await waitForExpression(
        cdp,
        `!document.querySelector(${JSON.stringify(deletedRow)}) && Boolean(document.querySelector(${JSON.stringify(libraryRow)}))`,
        PAGE_TIMEOUT_MS,
      ),
    );
    const restoredDraft = await evaluate(
      cdp,
      `(async () => (await (await fetch("/api/documents/" + ${JSON.stringify(dialogTypingId)})).json()).content)()`,
    );
    check("the restored document includes the latest edit", restoredDraft === "<p>Last draft before deletion.</p>");
    await clickSelector("#recentlyDeletedClose");

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
        const filler = "<p>Filler words before the marker.</p>".repeat(90);
        const content = filler + "<p>Needleword and R&amp;<b>D</b> notes</p>" + filler;
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

    await clickSelector('.document-card[data-document-id="' + searchFixture.id + '"] .document-card-link');
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    check("opening the result scrolls to the matching words", await waitForExpression(cdp, `(() => {
      const hit = document.querySelector(".doc-search-match")?.getBoundingClientRect();
      const line = Array.from(document.querySelectorAll(".doc-line")).find(el => el.textContent.includes("Needleword"));
      const box = line?.getBoundingClientRect();
      return hit && box && scrollY > innerHeight && hit.top > 0 && hit.bottom < innerHeight &&
        hit.top < box.bottom && hit.bottom > box.top && hit.width < box.width;
    })()`, PAGE_TIMEOUT_MS));
    await clickSelector("#backToLibrary");
    check("Library restores the query and its results", await waitForExpression(cdp, `
      location.pathname === "/" && document.getElementById("searchDocuments")?.value === "R&D" &&
        document.querySelector(".document-search-excerpt mark")?.textContent === "R&D"`, PAGE_TIMEOUT_MS));

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
    const pastedList = "<ul><li>one<ol><li>child</li></ol></li><li>Two <b>bold</b></li></ul>";
    const codeText = "\n\nreturn 42;";
    const pasteHtml =
      "<h2>Pasted heading</h2>" +
      pastedList +
      "<pre><code>" + codeText + "</code></pre>" +
      '<p>a <span style="font-style:italic">slanted</span> word</p>';
    const pasteText = "Pasted heading\none\nchild\nTwo bold\n" + codeText + "\na slanted word";
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
          pastedContent.includes(pastedList),
        pastedContent,
      );
      check(
        "the pasted marks are stored as tags, not inline styles",
        pastedContent.includes("<b>bold</b>") && pastedContent.includes("<i>slanted</i>"),
        pastedContent,
      );
      check(
        "the pasted italic paragraph keeps only its semantic italic mark",
        pastedContent.includes("<p>a <i>slanted</i> word</p>") && !pastedContent.includes("style="),
        pastedContent,
      );

      await cdp.send("Page.navigate", { url: base + "/doc/" + pasteDocumentId });
      await waitForPage(cdp, base + "/doc/" + pasteDocumentId, PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);
      const pastedBlocks = await paintedBlocks(cdp);
      const pastedTexts = pastedBlocks.map((block) => block.text);
      equal("a reload paints the pasted heading first", pastedTexts[0], "Pasted heading");
      check(
        "a reload paints the numbered child between its bulleted parent and the next bullet",
        pastedBlocks.length === 6 &&
          pastedBlocks[1].marker === "\u2022" &&
          pastedBlocks[2].marker === "1." &&
          pastedBlocks[3].marker === "\u2022" &&
          pastedTexts[1] === "one" &&
          pastedTexts[2] === "child" &&
          pastedTexts[3] === "Two bold",
        JSON.stringify(pastedBlocks),
      );
      equal("a reload keeps both leading blank lines in the pasted code", pastedTexts[4], codeText);
      equal("a reload paints the pasted italic paragraph last", pastedTexts[5], "a slanted word");
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
    function paletteBounds() {
      return evaluate(cdp, `(() => {
        const dialog = document.querySelector("dialog.quick-open[open]").getBoundingClientRect();
        const input = document.getElementById("quickOpenInput").getBoundingClientRect();
        return { inputTop: input.top, bottom: dialog.bottom };
      })()`);
    }

    const noPaletteMatches = `(() => {
      const message = document.getElementById("quickOpenMessage");
      return Boolean(
        message && !message.hidden && message.textContent.includes("No matching titles"),
      );
    })()`;

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

    const fullPaletteBounds = await paletteBounds();
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

    const filteredPaletteBounds = await paletteBounds();
    await cdp.send("Input.insertText", { text: "zzzz" });
    const emptyPalette = await waitForExpression(cdp, noPaletteMatches, 5000);
    check("a search with no title match says so", emptyPalette);
    const emptyPaletteBounds = await paletteBounds();
    check(
      "filtering changes the palette height below the search field",
      Math.abs(fullPaletteBounds.inputTop - filteredPaletteBounds.inputTop) < 0.5 &&
        Math.abs(fullPaletteBounds.inputTop - emptyPaletteBounds.inputTop) < 0.5 &&
        fullPaletteBounds.bottom > filteredPaletteBounds.bottom &&
        filteredPaletteBounds.bottom > emptyPaletteBounds.bottom,
      JSON.stringify({ fullPaletteBounds, filteredPaletteBounds, emptyPaletteBounds }),
    );

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
      `document.querySelector("dialog.quick-open[open]")?.getAnimations().length === 0 &&
        document.querySelectorAll(".quick-open-option").length >= 2`,
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
    await cdp.send("Input.insertText", { text: "palettezzzz" });
    const mobileNoMatches = await waitForExpression(cdp, noPaletteMatches, 5000);
    const mobileEmptyBounds = await paletteBounds();
    await evaluate(cdp, `document.getElementById("quickOpenInput").select()`);
    await pressKey("Backspace", "Backspace", 8, 0);
    const mobileMatches = await waitForExpression(
      cdp,
      `document.querySelectorAll(".quick-open-option").length >= 2`,
      5000,
    );
    const mobileFullBounds = await paletteBounds();
    check(
      "clearing the search expands the palette downward on a 390px viewport",
      mobileNoMatches && mobileMatches &&
        Math.abs(mobileEmptyBounds.inputTop - mobileFullBounds.inputTop) < 0.5 &&
        mobileFullBounds.bottom > mobileEmptyBounds.bottom,
      JSON.stringify({ mobileEmptyBounds, mobileFullBounds }),
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

    async function openNewDraft() {
      await evaluate(cdp, `document.getElementById("newDocument").click()`);
      await waitForPage(cdp, base + "/doc/new/", PAGE_TIMEOUT_MS);
      await waitForEditor(cdp, PAGE_TIMEOUT_MS);
      return evaluate(cdp, `location.pathname.split("/").pop()`);
    }

    const emptyDraftId = await openNewDraft();
    equal(
      "a new draft focuses the default title",
      await evaluate(cdp, `document.activeElement.value`),
      "Untitled document",
    );
    await pressKey("Enter", "Enter", 13, 0);
    await cdp.send("Input.insertText", { text: "   " });
    await pressKey("s", "KeyS", 83, 2);
    await evaluate(cdp, `document.getElementById("backToLibrary").click()`);
    await waitForExpression(cdp, `location.pathname === "/"`, PAGE_TIMEOUT_MS);
    check(
      "leaving a whitespace-only untitled draft writes no file",
      !(emptyDraftId in JSON.parse(await readFile(path.join(dataDir, "metadata.json"), "utf8")).documents),
    );

    const titledDraftId = await openNewDraft();
    await evaluate(cdp, `(() => {
      const title = document.getElementById("documentTitle");
      title.value = "Title only";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("backToLibrary").click();
    })()`);
    check(
      "Library waits for the first save of a title-only draft",
      await waitForExpression(
        cdp,
        `document.querySelector('a[href="/doc/${titledDraftId}"]')?.textContent.includes("Title only")`,
        PAGE_TIMEOUT_MS,
      ),
    );
    const index = JSON.parse(await readFile(path.join(dataDir, "metadata.json"), "utf8"));
    equal("a title-only draft keeps its title in the index", index.documents[titledDraftId].title, "Title only");
    equal("a title-only draft keeps an empty Markdown file", await readFile(path.join(dataDir, "Title only.md"), "utf8"), "");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const bodyDraftId = await openNewDraft();
    check(
      "the draft editor fits a 390px viewport",
      await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`),
    );
    await pressKey("Enter", "Enter", 13, 0);
    await cdp.send("Input.insertText", { text: "Draft (with body text) remains" });
    const bodyDraftUrl = base + "/doc/" + bodyDraftId;
    await waitForPage(cdp, bodyDraftUrl, PAGE_TIMEOUT_MS);
    await cdp.send("Page.reload");
    await waitForEditor(cdp, PAGE_TIMEOUT_MS);
    equal(
      "an untitled draft with body text survives reload",
      await evaluate(cdp, `document.querySelector(".doc-line").textContent`),
      "Draft (with body text) remains",
    );
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    await evaluate(cdp, `document.getElementById("docInput").focus()`);
    await pressKey("End", "End", 35, 2);
    await pressKey("ArrowLeft", "ArrowLeft", 37, 10);
    await cdp.send("Input.insertText", { text: "here" });
    equal(
      "Ctrl+Shift+Left replaces only the word after a closing parenthesis",
      await evaluate(cdp, `document.querySelector(".doc-line").textContent`),
      "Draft (with body text) here",
    );
    await pressKey("z", "KeyZ", 90, 2);
    await pressKey("Home", "Home", 36, 2);
    await pressKey("ArrowRight", "ArrowRight", 39, 10);
    await cdp.send("Input.insertText", { text: "Page" });
    equal(
      "Ctrl+Shift+Right replaces only the word before an opening parenthesis",
      await evaluate(cdp, `document.querySelector(".doc-line").textContent`),
      "Page (with body text) remains",
    );

    await checkSpellcheck(cdp, base, pressKey, tapToolbar);
    await checkSpaces(cdp, base, dataDir);
    await checkBoards(cdp, base, dataDir);
    await checkDrawings(cdp, base, dataDir, pressKey);
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

async function checkBoards(cdp, base, dataDir) {
  const libraryUrl = base + "/?space=general";
  async function point(selector, top = false) {
    return evaluate(cdp, `(() => {
      const bounds = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + (${top} ? 4 : bounds.height / 2) };
    })()`);
  }

  async function dragCard(start, end) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...start });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 1, ...end });
  }

  async function dropCard(end) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...end });
  }

  async function waitForBoardSave(expected) {
    await waitForExpression(cdp, `(async () => {
      if (!location.pathname.startsWith("/doc/")) return false;
      const response = await fetch("/api/documents/" + location.pathname.split("/").at(-1) + "/board", { cache: "no-store" });
      return response.ok && (await response.json()).markdown.includes(${JSON.stringify(expected)});
    })()`, PAGE_TIMEOUT_MS);
  }

  await cdp.send("Page.navigate", { url: libraryUrl });
  await waitForPage(cdp, libraryUrl, PAGE_TIMEOUT_MS);
  check("New Document starts with a direct link", await evaluate(cdp, `!document.getElementById("newDocument").hasAttribute("aria-haspopup")`));
  await evaluate(cdp, `(() => {
    document.getElementById("libraryMenuButton").click();
    document.getElementById("extensionsButton").click();
    document.querySelector('[data-extension="boards"]').click();
    document.querySelector('#extensionsDialog button[type="submit"]').click();
  })()`);
  await waitForExpression(cdp, `(async () => {
    const response = await fetch("/api/extensions", { cache: "no-store" });
    return response.ok && (await response.json()).boards;
  })()`, PAGE_TIMEOUT_MS);
  // The switch belongs to the server, so this browser losing its local storage
  // must not turn Boards off.
  await evaluate(cdp, `localStorage.clear(); window.__graphoReloaded = true`);
  await cdp.send("Page.reload");
  // Wait for the new page before its state is read: the old one still answers
  // the next expression otherwise.
  await waitForExpression(cdp, `window.__graphoReloaded !== true`, PAGE_TIMEOUT_MS);
  await waitForExpression(cdp, `document.getElementById("newDocument")?.getAttribute("aria-haspopup") === "dialog" && document.getElementById("librarySpace").value === "general"`, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `document.getElementById("newDocument").click()`);
  check("New Document opens the type picker", await evaluate(cdp, `document.getElementById("newDocumentDialog").open`));
  equal("the picker offers Document and Board in the selected Space", await evaluate(cdp, `Array.from(
    document.querySelectorAll("#documentTypeOptions a:not([hidden])"),
    (link) => link.textContent.trim() + " " + link.pathname + link.search,
  ).join(", ")`), "Document /doc/new?space=general, Board /board/new?space=general");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check("the type picker is centered at 390px", await evaluate(cdp, `(() => {
    const rect = document.getElementById("newDocumentDialog").getBoundingClientRect();
    return rect.width > 0 && Math.abs(rect.left + rect.width / 2 - innerWidth / 2) <= 1
      && Math.abs(rect.top + rect.height / 2 - innerHeight / 2) <= 1;
  })()`));
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  await evaluate(cdp, `[...document.querySelectorAll("#documentTypeOptions a")].find((link) => new URL(link.href).pathname === "/doc/new").click()`);
  await waitForPage(cdp, base + "/doc/new/", PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  check("Document opens the regular editor", await evaluate(cdp, `Boolean(document.getElementById("docInput"))`));

  await cdp.send("Page.navigate", { url: libraryUrl });
  await waitForPage(cdp, libraryUrl, PAGE_TIMEOUT_MS);
  await waitForExpression(cdp, `document.getElementById("newDocument")?.getAttribute("aria-haspopup") === "dialog" && document.getElementById("librarySpace").value === "general"`, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `(() => {
    document.getElementById("newDocument").click();
    document.querySelector('#documentTypeOptions a[data-document-extension="boards"]').click();
  })()`);
  await waitForPage(cdp, base + "/board/new/", PAGE_TIMEOUT_MS);
  await waitForExpression(cdp, `document.getElementById("boardView")?.hidden === false`, PAGE_TIMEOUT_MS);
  check("Board opens on rendered starter columns and cards", await evaluate(cdp, `document.querySelectorAll(".board-column").length === 3
    && document.querySelectorAll(".board-card-list > li").length === 1
    && document.getElementById("boardEditor").hidden`));
  check("Add card sits directly below each column title", await evaluate(cdp, `[...document.querySelectorAll(".board-column")].every(
    (column) => column.querySelector("h2").nextElementSibling.matches(".board-add-card"),
  )`));
  await evaluate(cdp, `document.querySelector(".board-add-card").click()`);
  check("the wider card form has no placement fields", await evaluate(cdp, `(() => {
    const form = document.getElementById("boardItemForm");
    return form.getBoundingClientRect().width >= 580 && !form.querySelector("select");
  })()`));
  await evaluate(cdp, `document.getElementById("boardItemCancel").click()`);
  check("the columns are centered and fill the available page height", await evaluate(cdp, `(() => {
    const columns = [...document.querySelectorAll(".board-column")];
    const first = columns[0].getBoundingClientRect();
    const last = columns.at(-1).getBoundingClientRect();
    return Math.abs((first.left + last.right) / 2 - innerWidth / 2) <= 1
      && first.bottom === last.bottom && first.bottom < innerHeight && first.bottom > innerHeight - 60;
  })()`));

  let markdown = "# Launch plan\n\nBoard description.\n\n## To do\n    - Review: Read the draft.\n    - Publish:\n    ```\n        Check **links**.\n        - Submit\n    ```\n\n## In progress\n\n## Done\n\n## Later\n";
  await evaluate(cdp, `(() => {
    document.getElementById("boardMode").click();
    const source = document.getElementById("boardSource");
    source.value = ${JSON.stringify(markdown)};
    source.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("boardMode").click();
  })()`);
  equal("all board columns render on desktop", await evaluate(cdp, `document.querySelectorAll(".board-column").length`), 4);
  check("fenced card details render Markdown", await evaluate(cdp, `document.querySelector(".board-card-list li b")?.textContent === "links"`));
  await waitForBoardSave(markdown);
  equal("Markdown changes autosave", await readFile(path.join(dataDir, "Launch plan.md"), "utf8"), markdown);
  await evaluate(cdp, `(() => {
    document.getElementById("boardTitle").click();
    const input = document.getElementById("boardTitleInput");
    input.value = "Launch board";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  })()`);
  markdown = markdown.replace("# Launch plan", "# Launch board");
  await waitForBoardSave(markdown);
  const boardFile = path.join(dataDir, "Launch board.md");
  equal("renaming the board autosaves its title and filename", await readFile(boardFile, "utf8"), markdown);

  const firstCard = '[data-column="0"] .board-card[data-card="0"]';
  const secondCard = '[data-column="0"] .board-card[data-card="1"]';
  const nextColumn = '[data-column="1"]';
  const destination = await point(nextColumn);
  await dragCard(await point(firstCard), destination);
  await waitForExpression(cdp, `document.querySelector('[data-column="1"] .board-drop-gap') && document.querySelector(".board-drag-preview")`, PAGE_TIMEOUT_MS);
  check("the lifted card keeps its size and the destination opens a matching gap", await evaluate(cdp, `(() => {
    const gap = document.querySelector(".board-drop-gap");
    const preview = document.querySelector(".board-drag-preview");
    return gap.offsetHeight === preview.offsetHeight && document.querySelector(".board-column .board-card[hidden]");
  })()`));
  check("previewing a drag leaves Markdown alone", await evaluate(cdp, `document.getElementById("boardSource").value === ${JSON.stringify(markdown)}`));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await dropCard(destination);
  check("Escape restores the original card and removes the preview", await evaluate(cdp, `!document.querySelector(".board-drop-gap, .board-drag-preview")
    && !document.querySelector(${JSON.stringify(firstCard)}).hidden
    && document.getElementById("boardSource").value === ${JSON.stringify(markdown)}`));
  await waitForExpression(cdp, `document.querySelector(${JSON.stringify(firstCard)}).getAnimations().length === 0`, PAGE_TIMEOUT_MS);

  const reorderEnd = await point(firstCard, true);
  await dragCard(await point(secondCard), reorderEnd);
  await waitForExpression(cdp, `document.querySelector(".board-drop-gap")?.nextElementSibling?.dataset.card === "0"`, PAGE_TIMEOUT_MS);
  await dropCard(reorderEnd);
  equal("dragging within a column changes the card order", await evaluate(cdp, `document.querySelector(${JSON.stringify(firstCard)}).querySelector("h3").textContent`), "Publish");

  await dragCard(await point(secondCard), destination);
  await waitForExpression(cdp, `document.querySelector('[data-column="1"] .board-drop-gap')`, PAGE_TIMEOUT_MS);
  await dropCard(destination);
  equal("dragging puts the card in its destination column", await evaluate(cdp, `document.querySelector('[data-column="1"] .board-card h3').textContent`), "Review");
  check("dropping a card leaves its edit dialog closed", await evaluate(cdp, `!document.getElementById("boardItemDialog").open`));
  await waitForBoardSave("## In progress\n    - Review: Read the draft.");

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.reload");
  await waitForExpression(cdp, `document.querySelectorAll(".board-column").length === 4`, PAGE_TIMEOUT_MS);
  check("the board scrolls horizontally inside a 390px viewport", await evaluate(cdp, `(() => {
    const columns = document.getElementById("boardColumns");
    return columns.scrollWidth > columns.clientWidth && document.documentElement.scrollWidth <= innerWidth + 1;
  })()`));
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const grip = `${nextColumn} .board-card-grip`;
  await evaluate(cdp, `document.querySelector(${JSON.stringify(grip)}).scrollIntoView({block: "nearest", inline: "center", behavior: "instant"})`);
  const touchGrip = await point(grip);
  check("cards have a visible drag grip on touch screens", await evaluate(cdp, `document.querySelector(${JSON.stringify(grip)}).offsetWidth >= 32`));
  const touchEnd = { x: touchGrip.x, y: touchGrip.y + 20 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchGrip] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchEnd] });
  await waitForExpression(cdp, `document.querySelector(".board-drag-preview")`, PAGE_TIMEOUT_MS);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  check("a cancelled touch drag keeps the card in place", await evaluate(cdp, `!document.querySelector(".board-drag-preview") && document.querySelector('[data-column="1"] .board-card h3').textContent === "Review"`));
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await evaluate(cdp, `(() => {
    document.querySelector('[data-column="1"] .board-card h3 button').click();
    document.getElementById("boardItemTitle").value = "Review again";
    document.getElementById("boardItemForm").requestSubmit();
  })()`);
  equal("editing a card keeps it in its column on mobile", await evaluate(cdp, `document.querySelector('[data-column="1"] .board-card h3').textContent`), "Review again");
  await waitForBoardSave("## In progress\n    - Review again: Read the draft.");
  markdown = await readFile(boardFile, "utf8");
  check("visual card edits update the Markdown file", markdown.includes("## In progress\n    - Review again: Read the draft."));

  // Deleting a card asks first; the board only changes after confirmation.
  const deletePrompt = await evaluate(cdp, `(() => {
    document.querySelector('[data-column="1"] .board-card .board-card-delete').click();
    return {
      open: document.getElementById("boardCardDeleteDialog").open,
      heading: document.getElementById("boardCardDeleteTitle").textContent,
      description: document.getElementById("boardCardDeleteDescription").textContent,
      cardEditorOpen: document.getElementById("boardItemDialog").open,
      focus: document.activeElement?.id,
    };
  })()`);
  check("a card's delete button asks for confirmation", deletePrompt.open
    && deletePrompt.heading === "Delete this card?"
    && deletePrompt.description.includes("Review again")
    && !deletePrompt.cardEditorOpen, JSON.stringify(deletePrompt));
  equal("the card confirmation starts on Cancel", deletePrompt.focus, "boardCardDeleteCancel");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitForExpression(cdp, `!document.getElementById("boardCardDeleteDialog").open
    && document.activeElement?.classList.contains("board-card-delete")`, PAGE_TIMEOUT_MS);
  check("cancelling the card confirmation keeps the card and returns focus to its delete button", await evaluate(cdp,
    `document.querySelectorAll('[data-column="1"] .board-card').length === 1
      && document.querySelector('[data-column="1"] .board-card h3').textContent === "Review again"`));

  await evaluate(cdp, `document.querySelector('[data-column="1"] .board-card .board-card-delete').click()`);
  await waitForExpression(cdp, `document.getElementById("boardCardDeleteDialog").open`, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `document.getElementById("boardCardDeleteConfirm").click()`);
  await waitForExpression(cdp, `!document.getElementById("boardCardDeleteDialog").open
    && document.querySelectorAll('[data-column="1"] .board-card').length === 0
    && document.activeElement?.classList.contains("board-add-card")`, PAGE_TIMEOUT_MS);
  check("deleting a card removes it and moves focus to the column's Add card button", await evaluate(cdp,
    `!document.getElementById("boardCardDeleteDialog").open
      && document.querySelectorAll('[data-column="1"] .board-card').length === 0
      && document.activeElement?.classList.contains("board-add-card")`));
  await waitForExpression(cdp, `(async () => {
    const response = await fetch("/api/documents/" + location.pathname.split("/").at(-1) + "/board", { cache: "no-store" });
    return response.ok && !(await response.json()).markdown.includes("Review again");
  })()`, PAGE_TIMEOUT_MS);
  markdown = await readFile(boardFile, "utf8");
  check("deleting a card updates the Markdown file", !markdown.includes("Review again")
    && markdown.includes("## In progress"));
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  const boardUrl = await evaluate(cdp, "location.href");
  await evaluate(cdp, `document.getElementById("boardLibraryLink").click()`);
  await waitForExpression(cdp, `document.getElementById("newDocument")?.getAttribute("aria-haspopup") === "dialog"`, PAGE_TIMEOUT_MS);
  const boardRow = '[data-document-id="' + new URL(boardUrl).pathname.split("/").at(-1) + '"]';
  await waitForExpression(cdp, `document.querySelector(${JSON.stringify(boardRow)})`, PAGE_TIMEOUT_MS);
  check("a board shows the column icon in the library list", await evaluate(cdp, `(() => {
    if (document.getElementById("documents").classList.contains("is-grid")) {
      document.getElementById("viewToggle").click();
    }
    const row = document.querySelector(${JSON.stringify(boardRow)});
    return row.querySelector(".board-glyph-icon").getBoundingClientRect().width > 0
      && row.querySelector(".document-glyph-icon").getBoundingClientRect().width === 0;
  })()`));

  // A document whose Markdown already reads as a board converts from its card
  // menu: the card turns into a board and the document URL serves the board
  // page. A document with no columns is refused with a message and stays a
  // document. The fixtures are deleted again so the checks below are unchanged.
  const convertFixtures = await evaluate(cdp, `(async () => {
    const create = async (title, content) => {
      const made = await (await fetch("/api/documents", { method: "POST" })).json();
      await fetch("/api/documents/" + encodeURIComponent(made.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      return made.id;
    };
    return {
      boardId: await create("Converted plan", "<h2>To do</h2><ul><li>Review</li></ul><h2>Done</h2>"),
      plainId: await create("Plain notes", "<p>Just a paragraph.</p>"),
    };
  })()`);
  await cdp.send("Page.reload");
  await waitForExpression(cdp, `(() => {
    const card = document.querySelector('[data-document-id="${convertFixtures.boardId}"]');
    return card && !card.querySelector(".card-board").hidden;
  })()`, PAGE_TIMEOUT_MS);
  const convertMenu = await evaluate(cdp, `(() => {
    const card = document.querySelector('[data-document-id="${convertFixtures.boardId}"]');
    card.querySelector(".card-menu-button").click();
    const item = card.querySelector(".card-board");
    return {
      menuOpen: !card.querySelector(".card-menu").hidden,
      label: item.textContent.trim(),
      visible: item.getBoundingClientRect().width > 0,
    };
  })()`);
  check(
    "a document's card menu offers Convert to board",
    convertMenu.menuOpen && convertMenu.visible && convertMenu.label === "Convert to board",
    JSON.stringify(convertMenu),
  );
  const convertedCard = await evaluate(cdp, `(async () => {
    const card = () => document.querySelector('[data-document-id="${convertFixtures.boardId}"]');
    card().querySelector(".card-board").click();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (card().classList.contains("is-board")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const board = await (await fetch("/api/documents/${convertFixtures.boardId}/board", { cache: "no-store" })).json();
    const toast = document.getElementById("toast");
    return {
      boardFlagged: card().classList.contains("is-board"),
      glyph: card().querySelector(".board-glyph-icon").getBoundingClientRect().width,
      markdown: board.markdown,
      toast: toast.textContent,
      toastVisible: toast.classList.contains("is-visible"),
    };
  })()`);
  check(
    "Convert to board keeps the document's Markdown as the board source",
    convertedCard.boardFlagged &&
      convertedCard.glyph > 0 &&
      convertedCard.markdown.startsWith("# Converted plan") &&
      convertedCard.markdown.includes("## To do"),
    JSON.stringify(convertedCard),
  );
  check(
    "converting announces the new board",
    convertedCard.toast === "Document converted to a board." && convertedCard.toastVisible,
    JSON.stringify(convertedCard),
  );
  await cdp.send("Page.navigate", { url: base + "/doc/" + convertFixtures.boardId });
  await waitForExpression(cdp, `document.getElementById("boardView")?.hidden === false`, PAGE_TIMEOUT_MS);
  check("the converted document opens as a board", await evaluate(cdp, `(() => {
    const columns = [...document.querySelectorAll(".board-column")];
    return columns.length === 2
      && columns[0].querySelector(".board-heading-button").textContent === "To do"
      && columns[0].querySelector(".board-card h3 button").textContent === "Review";
  })()`));
  await cdp.send("Page.navigate", { url: libraryUrl });
  await waitForExpression(cdp, `(() => {
    const card = document.querySelector('[data-document-id="${convertFixtures.plainId}"]');
    return card && !card.querySelector(".card-board").hidden;
  })()`, PAGE_TIMEOUT_MS);
  const refusedConversion = await evaluate(cdp, `(async () => {
    const card = document.querySelector('[data-document-id="${convertFixtures.plainId}"]');
    card.querySelector(".card-menu-button").click();
    card.querySelector(".card-board").click();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const toast = document.getElementById("toast");
      if (toast.classList.contains("is-error") && toast.classList.contains("is-visible")) {
        const listing = await (await fetch("/api/documents")).json();
        return {
          toast: toast.textContent,
          stillDocument: !card.classList.contains("is-board"),
          listed: listing.documents.find((entry) => entry.id === "${convertFixtures.plainId}") ?? null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { toast: document.getElementById("toast").textContent, stillDocument: !card.classList.contains("is-board") };
  })()`);
  check(
    "a document without columns shows why it cannot become a board",
    refusedConversion.stillDocument &&
      !refusedConversion.listed?.board &&
      typeof refusedConversion.toast === "string" &&
      refusedConversion.toast.includes("no board columns"),
    JSON.stringify(refusedConversion),
  );
  await evaluate(cdp, `(() => {
    document.getElementById("libraryMenuButton").click();
    document.getElementById("extensionsButton").click();
    document.querySelector('[data-extension="boards"]').click();
  })()`);
  check("disabling Boards restores direct document creation", await evaluate(cdp, `!document.getElementById("newDocument").hasAttribute("aria-haspopup")`));
  check("Convert to board disappears when Boards is off", await evaluate(cdp, `(() => {
    const card = document.querySelector('[data-document-id="${convertFixtures.plainId}"]');
    return Boolean(card) && card.querySelector(".card-board").hidden;
  })()`));
  // The board page reads the switch from the server, so wait for the save
  // before opening the board or it could still render the board view.
  await waitForExpression(cdp, `(async () => {
    const response = await fetch("/api/extensions", { cache: "no-store" });
    return response.ok && !(await response.json()).boards;
  })()`, PAGE_TIMEOUT_MS);
  await cdp.send("Page.navigate", { url: boardUrl });
  await waitForExpression(cdp, `document.getElementById("boardEditor")?.hidden === false`, PAGE_TIMEOUT_MS);
  equal("disabling Boards leaves the saved source accessible", await evaluate(cdp, `document.getElementById("boardSource").value`), markdown);
  await evaluate(cdp, `(async () => {
    for (const id of ["${convertFixtures.boardId}", "${convertFixtures.plainId}"]) {
      await fetch("/api/documents/" + encodeURIComponent(id), { method: "DELETE" });
    }
  })()`);
}

async function checkDrawings(cdp, base, dataDir, pressKey) {
  const libraryUrl = base + "/?space=general";
  const pathCount = `document.querySelectorAll("#drawingInk path").length`;
  const saved = `document.getElementById("drawingStatus")?.textContent === "Saved"`;
  const canvasBackground = `document.getElementById("drawingCanvas").dataset.background`;
  const selectActive = `document.getElementById("drawingCanvas").dataset.tool === "select"
    && document.querySelector('#drawingToolbar [aria-pressed="true"]')?.dataset.drawTool === "select"`;
  const eventStart = cdp.events.length;
  function point(x, y) {
    return evaluate(cdp, `(() => {
      const rect = document.getElementById("drawingCanvas").getBoundingClientRect();
      return { x: rect.left + rect.width * ${x}, y: rect.top + rect.height * ${y} };
    })()`);
  }
  function openBackground() {
    return evaluate(cdp, `(() => {
      document.getElementById("drawingMore").click();
      document.querySelector('[data-draw-action="background"]').click();
    })()`);
  }
  function changeBackgroundColors(color, patternColor) {
    return evaluate(cdp, `(() => {
      const form = document.querySelector("#drawingBackgroundDialog form");
      for (const [name, value] of Object.entries(${JSON.stringify({ color, patternColor })})) {
        const input = form.elements.namedItem(name);
        input.value = value;
        input.dispatchEvent(new Event("input"));
      }
    })()`);
  }
  const fillsViewport = `(() => {
    const canvas = document.getElementById("drawingCanvas");
    const bounds = canvas.getBoundingClientRect();
    const { a, d } = canvas.getScreenCTM();
    const title = document.getElementById("drawingTitle");
    const titleBounds = title.getBoundingClientRect();
    return document.querySelector(".editor-header #drawingToolbar")
      && Math.abs(titleBounds.left + titleBounds.width / 2 - innerWidth / 2) < 1
      && getComputedStyle(title).textAlign === "center"
      && bounds.left === 0 && Math.abs(bounds.right - innerWidth) < 1
      && Math.abs(bounds.bottom - innerHeight) < 1 && Math.abs(a - d) < 0.001;
  })()`;

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: libraryUrl });
  await waitForExpression(cdp, `document.getElementById("librarySpace")?.value === "general"`, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `(() => {
    document.getElementById("libraryMenuButton").click();
    document.getElementById("extensionsButton").click();
    document.querySelector('[data-extension="draw"]').click();
    document.querySelector('#extensionsDialog button[type="submit"]').click();
    document.getElementById("newDocument").click();
  })()`);
  check("Draw adds a Drawing option in the selected Space", await evaluate(cdp, `(() => {
    const option = document.querySelector('[data-document-extension="draw"]');
    return document.getElementById("newDocumentDialog").open && !option.hidden
      && option.textContent.trim() === "Drawing" && option.search === "?space=general";
  })()`));
  await evaluate(cdp, `document.querySelector('[data-document-extension="draw"]').click()`);
  await waitForExpression(cdp, `document.getElementById("drawingTitle")?.disabled === false`, PAGE_TIMEOUT_MS);
  const id = await evaluate(cdp, `location.pathname.split("/").at(-1)`);
  const drawingUrl = base + "/doc/" + id + "?space=general";
  const drawingApi = base + "/api/documents/" + id + "/drawing";
  const getScene = () => fetch(drawingApi + "?scene=true&version=12").then((response) => response.json());
  check("new drawings start with Select active", await evaluate(cdp, selectActive));
  check("desktop drawing tools sit in the header above a centered title and full canvas", await evaluate(cdp, fillsViewport));
  await openBackground();
  check("a blank drawing offers background choices and focuses Dots by default", await evaluate(cdp, `(() => {
    const dialog = document.getElementById("drawingBackgroundDialog");
    return dialog.open && document.activeElement === dialog.querySelector('[value="dots"]')
      && [...dialog.querySelectorAll('input[name="background"]')].map(input => input.value).join() === "dots,grid,ruled,plain";
  })()`));
  await evaluate(cdp, `document.querySelector('#drawingBackgroundDialog [value="plain"]').click()`);
  await changeBackgroundColors("#123456", "#abcdef");
  await pressKey("Escape", "Escape", 27);
  check("dismissing the background dialog preserves the canvas and returns focus to More actions", await evaluate(cdp, `
    !document.getElementById("drawingBackgroundDialog").open && ${canvasBackground} === "dots"
    && document.activeElement.id === "drawingMore"`));
  await pressKey("p", "KeyP", 80);
  check("the drawing surface and canvas cannot receive focus", await evaluate(cdp, `(() => {
    const title = document.getElementById("drawingTitle");
    title.focus();
    return [...document.querySelectorAll(".drawing-surface, .drawing-canvas")].every(element => {
      element.focus();
      return !element.hasAttribute("tabindex") && document.activeElement === title;
    });
  })()`));
  equal("the untouched drawing stays a draft", (await fetch(drawingApi)).status, 404);
  const start = await point(0.2, 0.2);
  const end = await point(0.9, 0.4);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...start });
  check("drawing leaves the title field without focusing the canvas", await evaluate(cdp, `document.activeElement === document.body`));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...end });
  check("the mouse stroke appears before it is committed", await evaluate(cdp, `document.querySelector("#drawingInk path")?.getAttribute("d").includes("L")`));
  equal("an in-progress stroke is still a draft", (await fetch(drawingApi)).status, 404);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...end });
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  const original = await getScene();
  check("the pencil stroke autosaves and the draft becomes a drawing", original.elements.length === 1
    && original.elements[0].points.length >= 2 && (await evaluate(cdp, "location.href")) === drawingUrl);
  check("the right side of the desktop canvas accepts ink beyond the old square", original.elements[0].points.at(-1)[0] > 1000);

  await pressKey("z", "KeyZ", 90, 2);
  equal("Ctrl+Z undoes the full stroke", await evaluate(cdp, pathCount), 0);
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  equal("undo saves the empty drawing", (await getScene()).elements.length, 0);
  await pressKey("Z", "KeyZ", 90, 10);
  equal("Ctrl+Shift+Z restores the stroke", await evaluate(cdp, pathCount), 1);
  const savedPath = await evaluate(cdp, `document.querySelector("#drawingInk path").getAttribute("d")`);
  await evaluate(cdp, `(() => {
    const title = document.getElementById("drawingTitle");
    title.value = "Release sketch";
    title.dispatchEvent(new Event("input"));
  })()`);
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  const drawingFile = path.join(dataDir, "Release sketch.drawing.json");
  const disk = JSON.parse(await readFile(drawingFile, "utf8"));
  equal("redo saves the original pencil element with the same ID", JSON.stringify(disk.elements), JSON.stringify(original.elements));
  equal("the drawing file has the current scene version", disk.version, 12);

  await openBackground();
  await changeBackgroundColors("#254263", "#7cbfe8");
  check("color changes preview both colors inside the dialog before Apply", await evaluate(cdp, `(() => {
    const preview = getComputedStyle(document.querySelector('#drawingBackgroundDialog [data-background="grid"]'));
    return preview.backgroundColor === "rgb(37, 66, 99)" && preview.backgroundImage.includes("rgb(124, 191, 232)")
      && getComputedStyle(document.getElementById("drawingCanvas")).backgroundColor !== preview.backgroundColor;
  })()`));
  await evaluate(cdp, `(() => {
    const dialog = document.getElementById("drawingBackgroundDialog");
    dialog.querySelector('[value="grid"]').click();
    dialog.querySelector('[type="submit"]').click();
  })()`);
  const customGrid = `(() => {
    const style = getComputedStyle(document.getElementById("drawingCanvas"));
    return ${canvasBackground} === "grid" && style.backgroundColor === "rgb(37, 66, 99)"
      && style.backgroundImage.includes("rgb(124, 191, 232)");
  })()`;
  check("Apply updates the drawing pattern and both colors", await evaluate(cdp, customGrid));
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  const styledDisk = JSON.parse(await readFile(drawingFile, "utf8"));
  check("the drawing file stores the selected background and colors", styledDisk.background === "grid"
    && styledDisk.background_color === "#254263" && styledDisk.pattern_color === "#7cbfe8");
  await pressKey("z", "KeyZ", 90, 2);
  check("undo restores the previous pattern and theme colors", await evaluate(cdp, `
    ${canvasBackground} === "dots" && !getComputedStyle(document.getElementById("drawingCanvas")).getPropertyValue("--drawing-background-color")`));
  await pressKey("Z", "KeyZ", 90, 10);
  check("redo reapplies the pattern and colors", await evaluate(cdp, customGrid));
  equal("changing the background preserves the drawing", await evaluate(cdp, pathCount), 1);
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Page.reload");
  await waitForExpression(cdp, `${saved} && innerWidth === 390`, PAGE_TIMEOUT_MS);
  check("reloading a drawing resets the active tool to Select", await evaluate(cdp, selectActive));
  await openBackground();
  check("the saved pattern and colors reopen in a dialog that fits on a phone", await evaluate(cdp, `(() => {
    const dialog = document.getElementById("drawingBackgroundDialog");
    const bounds = dialog.getBoundingClientRect();
    return dialog.open && ${customGrid} && dialog.querySelector('input:checked').value === "grid"
      && dialog.querySelector('[name="color"]').value === "#254263" && dialog.querySelector('[name="patternColor"]').value === "#7cbfe8"
      && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
  })()`));
  await evaluate(cdp, `(() => {
    document.getElementById("drawingBackgroundResetColors").click();
    document.querySelector('#drawingBackgroundDialog [type="submit"]').click();
  })()`);
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  const resetScene = await getScene();
  check("resetting both colors saves a color-only edit and keeps Grid", resetScene.background === "grid"
    && resetScene.background_color === undefined && resetScene.pattern_color === undefined);
  equal("the same stroke reopens at 390px", await evaluate(cdp, `document.querySelector("#drawingInk path")?.getAttribute("d")`), savedPath);
  check("the phone canvas fills the viewport below its header and centered title", await evaluate(cdp, fillsViewport));
  check("wide desktop ink is visible when reopened on a phone", await evaluate(cdp, `(() => {
    const stroke = document.querySelector("#drawingInk path").getBoundingClientRect();
    return stroke.left >= 0 && stroke.right <= innerWidth && stroke.bottom <= innerHeight;
  })()`));
  check("the drawing fits without horizontal scrolling", await evaluate(cdp, `document.documentElement.scrollWidth === innerWidth`));
  check("each drawing tool can be tapped at 390px", await evaluate(cdp, `(() => {
    const buttons = [...document.querySelectorAll("#drawingToolbar [data-draw-tool], #drawingMore, #drawingAddImage")];
    return buttons.length === 11 && buttons.every((button) => {
      const { left, top, width, height } = button.getBoundingClientRect();
      return width > 0 && height > 0 && button.contains(document.elementFromPoint(left + width / 2, top + height / 2));
    });
  })()`));
  check("the arrow style panel opens within the phone viewport", await evaluate(cdp, `(() => {
    document.querySelector('[data-draw-tool="arrow"]').click();
    const panel = document.getElementById("drawingStylePanel");
    const collapsed = panel.hidden;
    document.getElementById("drawingStyleToggle").click();
    const box = panel.getBoundingClientRect();
    const swatch = panel.querySelector('[data-shape-style="stroke"] button');
    const swatchBox = swatch.getBoundingClientRect();
    const hit = document.elementFromPoint(swatchBox.left + swatchBox.width / 2, swatchBox.top + swatchBox.height / 2);
    const showsArrowheads = !document.getElementById("drawingArrowheads").hidden;
    document.getElementById("drawingStyleToggle").click();
    document.querySelector('[data-draw-tool="pencil"]').click();
    return collapsed && showsArrowheads
      && box.width > 0 && box.left >= 0 && box.right <= innerWidth
      && box.bottom <= innerHeight && swatch.contains(hit);
  })()`));
  const touchStart = await point(0.25, 0.55);
  const touchEnd = await point(0.5, 0.92);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchStart] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchEnd] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  equal("a cancelled touch drops only its unfinished stroke", await evaluate(cdp, pathCount), 1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchStart] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchEnd] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await evaluate(cdp, `document.getElementById("drawingLibraryLink").click()`);
  await waitForPage(cdp, libraryUrl, PAGE_TIMEOUT_MS);
  const phoneScene = await getScene();
  equal("returning to the library saves a touch stroke", phoneScene.elements.length, 2);
  check("the bottom of the phone canvas accepts ink beyond the old square", phoneScene.elements.at(-1).points.at(-1)[1] > 1000);
  const row = `[data-document-id="${id}"]`;
  await waitForExpression(cdp, `document.querySelector('${row}')`, PAGE_TIMEOUT_MS);
  check("the drawing has a pencil icon in the library", await evaluate(cdp, `document.querySelector('${row} .drawing-glyph-icon').getBoundingClientRect().width > 0`));
  await evaluate(cdp, `(() => {
    document.getElementById("libraryMenuButton").click();
    document.getElementById("extensionsButton").click();
    document.querySelector('[data-extension="draw"]').click();
  })()`);
  check("turning off Draw hides the creation option", await evaluate(cdp, `!document.getElementById("newDocument").hasAttribute("aria-haspopup")`));
  await cdp.send("Page.navigate", { url: drawingUrl });
  await waitForExpression(cdp, `${saved} && ${pathCount} === 2`, PAGE_TIMEOUT_MS);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForExpression(cdp, `(() => {
    const canvas = document.getElementById("drawingCanvas");
    const { width, height } = canvas.getBoundingClientRect();
    const view = canvas.viewBox.baseVal;
    return innerWidth === 1280 && Math.abs(view.width / view.height - width / height) < 0.001;
  })()`, PAGE_TIMEOUT_MS);
  await checkDrawingTools(cdp, pressKey, getScene, saved, dataDir);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  check("browser reports no Draw script errors or policy violations", !cdp.events.slice(eventStart).some(({ method, params }) =>
    method === "Runtime.exceptionThrown" || (method === "Log.entryAdded" && params.entry.source === "security")));
}

async function checkDrawingTools(cdp, pressKey, getScene, saved, dataDir) {
  function choose(tool) {
    return evaluate(cdp, `document.querySelector('[data-draw-tool="${tool}"]').click()`);
  }
  async function gesture(from, to = from, modifiers = 0) {
    const [start, end] = await evaluate(cdp, `(() => {
      const matrix = document.getElementById("drawingCanvas").getScreenCTM();
      return ${JSON.stringify([from, to])}.map(([x, y]) => {
        const point = new DOMPoint(x, y).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      });
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, modifiers, ...start });
    if (to !== from) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, modifiers, ...end });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, modifiers, ...end });
  }
  async function savedElements() {
    await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
    return (await getScene()).elements;
  }
  function closeTo(actual, expected) {
    return actual?.length === 2 && actual.every((coordinate, index) => Math.abs(coordinate - expected[index]) <= 4);
  }

  const shapes = [
    ["rectangle", [40, 60], [180, 140]],
    ["diamond", [290, 80], [470, 170]],
    ["ellipse", [540, 80], [680, 170]],
    ["arrow", [750, 90], [930, 160]],
    ["line", [870, 340], [740, 260]],
  ];
  for (const [type, start, end] of shapes) {
    await choose(type);
    if (type === "rectangle") {
      await evaluate(cdp, `if (!document.getElementById("drawingStylePanel").hidden) document.getElementById("drawingStyleToggle").click()`);
    }
    await gesture(start, end);
  }
  const scene = await savedElements();
  for (const [type, start, end] of shapes) {
    const shape = scene.find((element) => element.type === type);
    check(`the ${type} tool saves both endpoints`, closeTo(shape?.start, start) && closeTo(shape?.end, end), JSON.stringify(shape));
  }

  await choose("rectangle");
  await gesture([20, 820], [160, 880], 8); // Shift
  const square = (await savedElements()).at(-1);
  check("holding Shift constrains a rectangle to a square", square?.type === "rectangle"
    && square.end[0] - square.start[0] === square.end[1] - square.start[1]);
  await pressKey("z", "KeyZ", 90, 2);
  await pressKey("v", "KeyV", 86);
  equal("V activates Select", await evaluate(cdp, `document.querySelector('[data-draw-tool="select"]').getAttribute("aria-pressed")`), "true");
  await gesture([270, 60], [700, 180]);
  await pressKey("Delete", "Delete", 46);
  equal("a marquee selects the enclosed shapes for deletion", JSON.stringify(await savedElements()),
    JSON.stringify(scene.filter(({ type }) => type !== "ellipse" && type !== "diamond")));
  await pressKey("z", "KeyZ", 90, 2);
  await gesture([120, 100], [180, 225]);
  const rectangleId = scene.find((element) => element.type === "rectangle")?.id;
  const moved = (await savedElements()).find((element) => element.id === rectangleId);
  check("dragging inside a rectangle moves both corners with its ID intact",
    closeTo(moved?.start, [100, 185]) && closeTo(moved?.end, [240, 265]), JSON.stringify(moved));
  await gesture([240, 265], [265, 305]);
  const resized = (await savedElements()).find((element) => element.id === rectangleId);
  check("dragging a selected corner resizes only that corner",
    closeTo(resized?.start, [100, 185]) && closeTo(resized?.end, [265, 305]), JSON.stringify(resized));
  await pressKey("z", "KeyZ", 90, 2);
  equal("undo restores the rectangle before resizing", JSON.stringify((await savedElements()).find((element) => element.id === rectangleId)), JSON.stringify(moved));

  await choose("text");
  await gesture([720, 820]);
  await waitForExpression(cdp, `document.activeElement?.id === "drawingTextEditor"`, PAGE_TIMEOUT_MS);
  const oversizedLabel = ["Wide label ".repeat(48), ...Array(95).fill("More text")].join("\n");
  await cdp.send("Input.insertText", { text: oversizedLabel });
  const textHasNoOutline = `getComputedStyle(document.getElementById("drawingTextEditor")).outlineStyle === "none"
    && !document.querySelector("#drawingSelection .drawing-selection-box")`;
  check("typing a drawing label shows no selection outline", await evaluate(cdp, textHasNoOutline));
  const textEditor = await evaluate(cdp, `(() => {
    const editor = document.getElementById("drawingTextEditor");
    editor.scrollLeft = 100;
    editor.scrollTop = 100;
    return {
      scrollLeft: editor.scrollLeft, scrollTop: editor.scrollTop,
      horizontalGutter: editor.offsetHeight - editor.clientHeight,
      verticalGutter: editor.offsetWidth - editor.clientWidth,
      scrollbarWidth: getComputedStyle(editor).scrollbarWidth,
    };
  })()`);
  check("oversized drawing text stays scrollable without visible scrollbars",
    textEditor.scrollLeft > 0 && textEditor.scrollTop > 0 && textEditor.horizontalGutter === 0
    && textEditor.verticalGutter === 0 && textEditor.scrollbarWidth === "none", JSON.stringify(textEditor));
  await pressKey("a", "KeyA", 65, 2);
  await cdp.send("Input.insertText", { text: "First line\nSecond line" });
  await pressKey("Enter", "Enter", 13, 2);
  const label = (await savedElements()).find((element) => element.type === "text");
  check("the text tool saves an editable multiline label", label?.text === "First line\nSecond line" && closeTo(label.at, [720, 820]), JSON.stringify(label));
  await choose("text");
  await gesture([730, 830]);
  await waitForExpression(cdp, `document.activeElement?.id === "drawingTextEditor"`, PAGE_TIMEOUT_MS);
  await pressKey("a", "KeyA", 65, 2);
  await cdp.send("Input.insertText", { text: "Revised label" });
  await pressKey("Enter", "Enter", 13, 2);
  const beforeErase = await savedElements();
  equal("editing a label preserves its identity", beforeErase.find((element) => element.id === label?.id)?.text, "Revised label");

  await choose("select");
  await gesture([730, 830]);
  check("selecting a drawing label shows its selection outline", await evaluate(cdp, `
    Number(document.querySelector("#drawingSelection .drawing-selection-box")?.getAttribute("x")) === ${label.at[0]}`));

  await choose("eraser");
  await gesture([275, 125], [710, 125]);
  const erased = await savedElements();
  equal("one eraser sweep removes both intersected shapes",
    JSON.stringify(erased), JSON.stringify(beforeErase.filter(({ type }) => type !== "ellipse" && type !== "diamond")));
  await pressKey("z", "KeyZ", 90, 2);
  equal("one undo restores the complete eraser sweep", JSON.stringify(await savedElements()), JSON.stringify(beforeErase));
  await pressKey("Z", "KeyZ", 90, 10);
  equal("redo repeats the erase", JSON.stringify(await savedElements()), JSON.stringify(erased));

  await cdp.send("Page.reload");
  const renderedIds = `[...document.querySelectorAll("#drawingInk [data-element-id]")].map((element) => element.dataset.elementId)`;
  await waitForExpression(cdp, `${saved} && ${renderedIds}.length > 0`, PAGE_TIMEOUT_MS);
  equal("a mixed drawing reopens with the saved objects in order", JSON.stringify(await evaluate(cdp, renderedIds)), JSON.stringify(erased.map(({ id }) => id)));
  equal("a reopened text object renders its edited label", await evaluate(cdp, `document.querySelector("#drawingInk text")?.textContent`), "Revised label");
  async function moreAction(action) {
    await evaluate(cdp, `document.getElementById("drawingMore").click()`);
    await evaluate(cdp, `document.querySelector('[data-draw-action="${action}"]').click()`);
  }
  await moreAction("select-all");
  await moreAction("duplicate");
  const copies = await savedElements();
  check("duplicating a selection gives each new object its own ID", copies.length === erased.length * 2
    && new Set(copies.map(({ id }) => id)).size === copies.length);
  await moreAction("delete");
  equal("Delete removes only the selected copies", JSON.stringify(await savedElements()), JSON.stringify(erased));

  await choose("ellipse");
  await evaluate(cdp, `if (document.getElementById("drawingStylePanel").hidden) document.getElementById("drawingStyleToggle").click()`);
  check("ellipse style omits corner controls", await evaluate(cdp,
    `!document.getElementById("drawingStylePanel").hidden && document.getElementById("drawingStyleEdges").hidden`));
  await choose("diamond");
  check("diamond style includes corner controls", await evaluate(cdp, `!document.getElementById("drawingStyleEdges").hidden`));
  await choose("rectangle");
  const styleButton = (group, label) => evaluate(cdp,
    `document.querySelector('[data-shape-style="${group}"] [aria-label="${label}"]').click()`);
  await styleButton("stroke", "Blue");
  await styleButton("fill", "Amber");
  await styleButton("width", "Thick");
  await styleButton("pattern", "Dotted");
  await styleButton("roughness", "Sketchy");
  await styleButton("edges", "Rounded corners");
  await gesture([950, 550], [1200, 700]);
  const styled = (await savedElements()).at(-1);
  check("a new shape inherits the style panel choices", styled.type === "rectangle"
    && styled.style?.stroke === "#307bd2" && styled.style.fill === "#f0c879"
    && styled.style.width === 3 && styled.style.pattern === "dotted"
    && styled.style.roughness === 1 && styled.style.edges === "rounded", JSON.stringify(styled));

  await choose("select");
  await gesture([1100, 620]);
  await evaluate(cdp, `(() => {
    const slider = document.getElementById("drawingStyleOpacity");
    slider.value = 45;
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  })()`);
  await styleButton("layers", "Send to back");
  const restyled = (await savedElements())[0];
  check("opacity and layer edits save on the selected shape", restyled.id === styled.id && restyled.style?.opacity === 45);
  await pressKey("z", "KeyZ", 90, 2);
  equal("undo restores the preceding layer order", (await savedElements()).at(-1).id, styled.id);
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  check("the saved SVG shape renders its stroke, fill, dash pattern and opacity", await evaluate(cdp, `(() => {
    const shape = document.querySelector('[data-element-id="${styled.id}"]');
    return shape?.tagName === "path" && shape.getAttribute("d").includes("Q")
      && shape.getAttribute("d").includes("C") && shape.getAttribute("stroke") === "#307bd2"
      && shape.getAttribute("fill") === "#f0c879" && shape.getAttribute("stroke-dasharray") === "0 12.5"
      && shape.getAttribute("opacity") === "0.45";
  })()`));

  await pressKey("a", "KeyA", 65);
  check("A opens the arrow panel with route and arrowheads", await evaluate(cdp, `(() => {
    return !document.getElementById("drawingStylePanel").hidden
      && !document.getElementById("drawingArrowType").hidden
      && !document.getElementById("drawingArrowheads").hidden
      && document.getElementById("drawingStyleBackground").hidden
      && document.getElementById("drawingStyleEdges").hidden;
  })()`));
  const chooseHead = (end, value) => evaluate(cdp, `(() => {
    const select = document.querySelector('[data-arrowhead="${end}_head"]');
    select.value = "${value}";
    select.dispatchEvent(new Event("change"));
  })()`);
  await styleButton("route", "Elbow arrow");
  await styleButton("stroke", "Red");
  await styleButton("pattern", "Dashed");
  await chooseHead("start", "triangle");
  await chooseHead("end", "bar");
  await gesture([850, 430], [1200, 610]);
  const arrow = (await savedElements()).at(-1);
  check("new arrows save their route, style, and independent endpoints", arrow.type === "arrow"
    && arrow.style?.route === "elbow" && arrow.style.start_head === "triangle" && arrow.style.end_head === "bar"
    && arrow.style.stroke === "#d94b58" && arrow.style.pattern === "dashed", JSON.stringify(arrow));
  await choose("select");
  await gesture([990, 430]);
  await chooseHead("end", "none");
  const updatedArrow = (await savedElements()).find(({ id }) => id === arrow.id);
  check("selecting the elbow route allows editing its arrowheads", updatedArrow?.style?.end_head === "none");
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  check("styled arrows render their stored route and endpoints on reload", await evaluate(cdp, `(() => {
    const arrow = document.querySelector('[data-element-id="${arrow.id}"]');
    const [shaft, heads] = arrow?.children ?? [];
    return shaft?.getAttribute("d").split("L").length === 4
      && heads?.getAttribute("d").split("M").length === 2
      && arrow.getAttribute("stroke") === "#d94b58";
  })()`));

  await pressKey("l", "KeyL", 76);
  check("L opens the line panel with Background and Edges", await evaluate(cdp, `(() => {
    return !document.getElementById("drawingStylePanel").hidden
      && !document.getElementById("drawingStyleBackground").hidden
      && !document.getElementById("drawingStyleEdges").hidden
      && document.getElementById("drawingArrowType").hidden;
  })()`));
  await styleButton("stroke", "Blue");
  await styleButton("fill", "Amber");
  await styleButton("edges", "Rounded corners");
  await gesture([790, 570]);
  await gesture([1060, 570]);
  await gesture([1060, 780]);
  await gesture([790, 570]);
  const closedLine = (await savedElements()).at(-1);
  check("clicking the first point closes a styled line", closedLine.type === "line" && closedLine.closed
    && closedLine.vertices.length === 1 && closeTo(closedLine.vertices[0], [1060, 570])
    && closedLine.style?.edges === "rounded" && closedLine.style.fill === "#f0c879", JSON.stringify(closedLine));
  await gesture([730, 910]);
  await gesture([940, 880]);
  await gesture([1130, 910]);
  await pressKey("Enter", "Enter", 13);
  const openLine = (await savedElements()).at(-1);
  check("Enter finishes an open line with its intermediate point", openLine.id !== closedLine.id
    && !!openLine.vertices?.length && !openLine.closed);
  await gesture([720, 840]);
  await gesture([840, 850]);
  await pressKey("Escape", "Escape", 27);
  equal("Escape discards unfinished line segments", (await savedElements()).at(-1).id, openLine.id);
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  check("only the closed line paints its saved background on reload", await evaluate(cdp, `(() => {
    const closed = document.querySelector('[data-element-id="${closedLine.id}"]');
    const open = document.querySelector('[data-element-id="${openLine.id}"]');
    return closed?.getAttribute("fill") === "#f0c879" && closed.getAttribute("d").endsWith("Z")
      && closed.getAttribute("stroke-linejoin") === "round"
      && open && !open.hasAttribute("fill") && !open.getAttribute("d").endsWith("Z");
  })()`));
  await choose("select");
  await gesture([1060, 620]);
  await gesture([1060, 570], [1120, 600]);
  const editedLine = (await savedElements()).find(({ id }) => id === closedLine.id);
  check("dragging a line handle edits its intermediate vertex", closeTo(editedLine?.vertices?.[0], [1120, 600]));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await waitForExpression(cdp, "innerWidth === 390", PAGE_TIMEOUT_MS);
  await choose("line");
  const touchPoints = await evaluate(cdp, `(() => {
    const box = document.getElementById("drawingCanvas").getBoundingClientRect();
    return [[0.52, 0.2], [0.83, 0.2], [0.8, 0.44], [0.52, 0.2]].map(([x, y]) => ({
      x: box.left + x * box.width, y: box.top + y * box.height,
    }));
  })()`);
  for (const touchPoint of touchPoints) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  const mobileLine = (await savedElements()).at(-1);
  check("touch taps close a line at 390px", mobileLine.id !== openLine.id && mobileLine.closed === true);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForExpression(cdp, `(() => {
    const canvas = document.getElementById("drawingCanvas");
    const bounds = canvas.getBoundingClientRect();
    return innerWidth === 1280 && Math.abs(bounds.width / bounds.height - canvas.viewBox.baseVal.width / canvas.viewBox.baseVal.height) < 0.001;
  })()`, PAGE_TIMEOUT_MS);
  await pressKey("p", "KeyP", 80);
  check("P opens the pencil panel with Pressure and Background", await evaluate(cdp, `(() => {
    return !document.getElementById("drawingStylePanel").hidden
      && !document.getElementById("drawingStylePressure").hidden
      && !document.getElementById("drawingStyleBackground").hidden
      && document.getElementById("drawingStyleLayers").hidden
      && document.getElementById("drawingStylePattern").hidden;
  })()`));
  await styleButton("stroke", "Red");
  await styleButton("fill", "Amber");
  await styleButton("width", "Thick");
  await styleButton("pressure", "Pressure sensitive");
  await evaluate(cdp, `(() => {
    const slider = document.getElementById("drawingStyleOpacity");
    slider.value = 65;
    slider.dispatchEvent(new Event("change"));
  })()`);
  async function tracePencil(points, pointerType) {
    const eventPoints = await evaluate(cdp, `(() => {
      const matrix = document.getElementById("drawingCanvas").getScreenCTM();
      return ${JSON.stringify(points)}.map(([x, y, force]) => {
        const p = new DOMPoint(x, y).matrixTransform(matrix);
        return { x: p.x, y: p.y, force };
      });
    })()`);
    for (const [index, point] of eventPoints.entries()) {
      const type = index === 0 ? "mousePressed" : "mouseMoved";
      await cdp.send("Input.dispatchMouseEvent", { type, button: "left", buttons: 1, pointerType, ...point });
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", button: "left", pointerType, ...eventPoints.at(-1), force: 0,
    });
    return (await savedElements()).at(-1);
  }
  const pen = await tracePencil([[990, 310, 0.14], [1100, 310, 0.25], [1100, 480, 0.9], [1020, 500, 0.85]], "pen");
  check("the pencil saves pen pressure samples and its style", pen.type === "pencil" && pen.style?.pressure === "variable"
    && pen.style.stroke === "#d94b58" && pen.style.fill === "#f0c879" && pen.style.width === 3 && pen.style.opacity === 65
    && pen.pressures.length === pen.points.length && pen.pressures[0] < 60 && pen.pressures.at(-1) > 190, JSON.stringify(pen));
  const mouse = await tracePencil([[850, 710], [858, 710], [1020, 735], [1040, 755]], "mouse");
  check("mouse strokes fall back to varying pressure", mouse.pressures?.length === mouse.points.length
    && new Set(mouse.pressures).size > 1, JSON.stringify(mouse));
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  check("pencil pressure and background both render after reload", await evaluate(cdp, `(() => {
    const stroke = document.querySelector('[data-element-id="${pen.id}"]');
    const [background, outline] = stroke?.children ?? [];
    const radii = [...(outline?.getAttribute("d") ?? "").matchAll(/A([0-9.]+)/g)].map(match => Number(match[1]));
    return background?.getAttribute("fill") === "#f0c879" && outline?.getAttribute("fill") === "#d94b58"
      && outline.getAttribute("stroke") === "none" && radii[0] > radii[1] * 1.5
      && stroke.getAttribute("opacity") === "0.65";
  })()`));
  await choose("select");
  await gesture([1070, 400]);
  await styleButton("pressure", "Uniform pressure");
  const uniform = (await savedElements()).find(({ id }) => id === pen.id);
  check("selected strokes can switch to uniform width and retain their pressure samples",
    uniform?.type === "pencil" && uniform.style?.pressure === undefined && Array.isArray(pen.pressures)
    && JSON.stringify(uniform.pressures) === JSON.stringify(pen.pressures));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await waitForExpression(cdp, "innerWidth === 390", PAGE_TIMEOUT_MS);
  await choose("pencil");
  await evaluate(cdp, `document.getElementById("drawingStyleToggle").click()`);
  check("the pencil pressure controls fit at 390px", await evaluate(cdp, `(() => {
    const controls = document.getElementById("drawingStylePressure").getBoundingClientRect();
    return controls.width > 0 && controls.right <= innerWidth && controls.bottom <= innerHeight;
  })()`));
  await styleButton("pressure", "Pressure sensitive");
  await evaluate(cdp, `document.getElementById("drawingStyleToggle").click()`);
  const touchStroke = await evaluate(cdp, `(() => {
    const box = document.getElementById("drawingCanvas").getBoundingClientRect();
    return [[0.45, 0.7], [0.48, 0.7], [0.85, 0.75]].map(([x, y]) => ({
      x: box.left + x * box.width, y: box.top + y * box.height,
    }));
  })()`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchStroke[0]] });
  for (const point of touchStroke.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const touchPencil = (await savedElements()).at(-1);
  check("touch strokes also fall back to varying pressure", touchPencil.id !== mouse.id
    && touchPencil.style?.pressure === "variable" && new Set(touchPencil.pressures).size > 1);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForExpression(cdp, `(() => {
    const canvas = document.getElementById("drawingCanvas");
    const bounds = canvas.getBoundingClientRect();
    return innerWidth === 1280 && Math.abs(bounds.width / bounds.height - canvas.viewBox.baseVal.width / canvas.viewBox.baseVal.height) < 0.001;
  })()`, PAGE_TIMEOUT_MS);
  await pressKey("t", "KeyT", 84);
  await evaluate(cdp, `if (document.getElementById("drawingStylePanel").hidden) document.getElementById("drawingStyleToggle").click()`);
  check("T offers exactly Hand-drawn, Normal, and Code", await evaluate(cdp, `(() => {
    const presets = [...document.querySelectorAll('[data-shape-style="font_family"] button')];
    return !document.getElementById("drawingTextFamily").hidden
      && document.getElementById("drawingStyleWidth").hidden
      && presets.map(button => button.getAttribute("aria-label")).join() === "Hand-drawn,Normal,Code";
  })()`));
  await styleButton("font_family", "Hand-drawn");
  await styleButton("font_size", "Extra large");
  await styleButton("text_align", "Align center");
  await styleButton("stroke", "Blue");
  await gesture([870, 240]);
  await cdp.send("Input.insertText", { text: "Engineering sketch\nDraft" });
  const codePreset = await evaluate(cdp, `(() => {
    const box = document.querySelector('[data-shape-style="font_family"] [aria-label="Code"]').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...codePreset });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...codePreset });
  check("switching fonts while typing keeps the label open in the chosen preset", await evaluate(cdp, `(() => {
    const editor = document.getElementById("drawingTextEditor");
    return !editor.hidden && editor.style.fontFamily.includes("monospace") && editor.style.textAlign === "center"
      && editor.value === "Engineering sketch\\nDraft";
  })()`));
  await styleButton("font_family", "Hand-drawn");
  await evaluate(cdp, `(() => {
    const slider = document.getElementById("drawingStyleOpacity");
    slider.value = 60;
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  })()`);
  await evaluate(cdp, `document.getElementById("drawingTextEditor").focus()`);
  await pressKey("Enter", "Enter", 13, 2);
  const styledText = (await savedElements()).at(-1);
  check("text saves its font, size, alignment and color", styledText.type === "text"
    && styledText.style?.font_family === "hand_drawn" && styledText.style.font_size === "xl"
    && styledText.style.text_align === "center" && styledText.style.stroke === "#307bd2"
    && styledText.style.opacity === 60, JSON.stringify(styledText));
  await choose("select");
  await gesture([880, 250]);
  await styleButton("layers", "Send to back");
  equal("selected text can move behind the other layers", (await savedElements())[0].id, styledText.id);
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `document.fonts.load("60px Kalam").then(() => true)`);
  check("the bundled font and center alignment render after reload", await evaluate(cdp, `(() => {
    const text = document.querySelector('[data-element-id="${styledText.id}"]');
    return text?.getAttribute("font-family").includes("Kalam") && text.getAttribute("font-size") === "60"
      && text.getAttribute("fill") === "#307bd2" && text.getAttribute("text-anchor") === "middle"
      && text.getAttribute("opacity") === "0.6"
      && text.children.length === 2 && Number(text.firstElementChild.getAttribute("x")) > ${styledText.at[0]}
      && [...document.fonts].some(font => font.family === "Kalam" && font.status === "loaded");
  })()`));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitForExpression(cdp, "innerWidth === 390", PAGE_TIMEOUT_MS);
  await choose("text");
  check("all three font presets are reachable at 390px", await evaluate(cdp, `(() => {
    document.getElementById("drawingStyleToggle").click();
    const buttons = [...document.querySelectorAll('[data-shape-style="font_family"] button')];
    return document.documentElement.scrollWidth === innerWidth && buttons.length === 3 && buttons.every(button => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    });
  })()`));

  const photo = await evaluate(cdp, `(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f0c879";
    ctx.fillRect(0, 0, 240, 120);
    ctx.fillStyle = "#307bd2";
    ctx.fillRect(30, 30, 180, 60);
    return canvas.toDataURL("image/png");
  })()`);
  const photoPath = path.join(dataDir, "drawing-photo.png");
  await writeFile(photoPath, Buffer.from(photo.split(",")[1], "base64"));
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const start = cdp.events.length;
    await evaluate(cdp, `document.getElementById("drawingTitle").focus()`);
    await pressKey("i", "KeyI", 73);
    check("I leaves the file picker closed while editing the drawing title",
      !cdp.events.slice(start).some(e => e.method === "Page.fileChooserOpened"));
    await evaluate(cdp, `document.getElementById("drawingTitle").blur()`);
    await pressKey("i", "KeyI", 73);
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#drawingImageInput" });
    check("I opens the drawing image picker at 390px", cdp.events.slice(start).some(e => e.method === "Page.fileChooserOpened"));
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [photoPath] });
    await waitForExpression(cdp, `document.querySelector('#drawingInk [data-type="image"]')`, PAGE_TIMEOUT_MS);
  } finally {
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false });
  }
  const inserted = (await savedElements()).at(-1);
  check("the picked photo is embedded and placed in the center", inserted.type === "image"
    && inserted.src === photo && inserted.alt === "drawing photo" && await evaluate(cdp, `(() => {
      const canvas = document.getElementById("drawingCanvas").viewBox.baseVal;
      const image = document.querySelector('#drawingInk [data-type="image"]').getBBox();
      return Math.abs(image.x + image.width / 2 - canvas.width / 2) < 2
        && Math.abs(image.y + image.height / 2 - canvas.height / 2) < 2
        && Math.abs(image.width / image.height - 2) < 0.02;
    })()`), JSON.stringify({ start: inserted.start, end: inserted.end }));
  await pressKey("z", "KeyZ", 90, 2);
  check("undo removes an inserted image", !(await savedElements()).some(item => item.id === inserted.id));
  await pressKey("Z", "KeyZ", 90, 10);
  check("redo restores the same image", (await savedElements()).some(item => item.id === inserted.id && item.src === photo));
  const center = inserted.start.map((value, i) => (value + inserted.end[i]) / 2);
  await gesture(center, [center[0] + 25, center[1] + 40]);
  const movedImage = (await savedElements()).at(-1);
  check("the image moves like other drawing objects", closeTo(movedImage.start, [inserted.start[0] + 25, inserted.start[1] + 40]));
  await gesture(movedImage.end, [movedImage.end[0] + 75, movedImage.end[1] + 30]);
  const resizedImage = (await savedElements()).at(-1);
  const [imageWidth, imageHeight] = resizedImage.end.map((value, i) => value - resizedImage.start[i]);
  check("corner resizing keeps the image's aspect ratio", imageWidth > movedImage.end[0] - movedImage.start[0]
    && Math.abs(imageWidth / imageHeight - 2) < 0.03);
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  check("the image reopens with the same pixels and size", await evaluate(cdp, `(() => {
    const image = document.querySelector('[data-element-id="${inserted.id}"]');
    return image?.getAttribute("href") === ${JSON.stringify(photo)}
      && Number(image.getAttribute("width")) === ${imageWidth}
      && Number(image.getAttribute("height")) === ${imageHeight};
  })()`));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForExpression(cdp, `(() => {
    const canvas = document.getElementById("drawingCanvas");
    const { width, height } = canvas.getBoundingClientRect();
    return innerWidth === 1280 && Math.abs(width / height - canvas.viewBox.baseVal.width / canvas.viewBox.baseVal.height) < 0.001;
  })()`, PAGE_TIMEOUT_MS);
  await choose("select");
  const beforePan = await savedElements();
  const screenPicture = `(() => {
    const { x, y } = document.querySelector('[data-element-id="${inserted.id}"]').getBoundingClientRect();
    return [x, y];
  })()`;
  const originalPosition = await evaluate(cdp, screenPicture);
  const { x, y } = await evaluate(cdp, `(() => {
    const box = document.getElementById("drawingCanvas").getBoundingClientRect();
    return { x: box.left + 300, y: box.top + 150 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "middle", buttons: 4, clickCount: 1, x, y });
  check("middle press shows the grabbing hand", await evaluate(cdp, `getComputedStyle(document.getElementById("drawingCanvas")).cursor === "grabbing"`));
  const end = { x: x + 100, y: y + 60 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "middle", buttons: 4, ...end });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "middle", clickCount: 1, ...end });
  check("middle drag pans the image with the canvas", closeTo(await evaluate(cdp, screenPicture), [originalPosition[0] + 100, originalPosition[1] + 60]));
  check("releasing middle restores the tool cursor without adding an undo step", await evaluate(cdp, `
    getComputedStyle(document.getElementById("drawingCanvas")).cursor === "default" && document.getElementById("drawingUndo").disabled`));
  equal("panning leaves the saved objects unchanged", JSON.stringify(await savedElements()), JSON.stringify(beforePan));
  const cameraAtPointer = `(() => {
    const canvas = document.getElementById("drawingCanvas");
    const view = canvas.viewBox.baseVal;
    const anchor = new DOMPoint(${x}, ${y}).matrixTransform(canvas.getScreenCTM().inverse());
    return { x: view.x, y: view.y, width: view.width, anchor: [anchor.x, anchor.y] };
  })()`;
  const initialCamera = await evaluate(cdp, cameraAtPointer);
  const wheel = (deltaX, deltaY) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  await wheel(0, -120);
  await waitForExpression(cdp, `${cameraAtPointer}.width < ${initialCamera.width}`, PAGE_TIMEOUT_MS);
  const zoomed = await evaluate(cdp, cameraAtPointer);
  check("wheel up zooms in around the pointer", initialCamera.anchor.every((value, index) => Math.abs(value - zoomed.anchor[index]) < 0.02));
  await wheel(0, 120);
  await waitForExpression(cdp, `Math.abs(${cameraAtPointer}.width - ${initialCamera.width}) < 0.02`, PAGE_TIMEOUT_MS);
  const zoomedOut = await evaluate(cdp, cameraAtPointer);
  check("wheel down zooms out around the same pointer", initialCamera.anchor.every((value, index) =>
    Math.abs(value - zoomedOut.anchor[index]) < 0.02));
  await wheel(80, 0);
  await waitForExpression(cdp, `${cameraAtPointer}.x > ${initialCamera.x} + 10`, PAGE_TIMEOUT_MS);
  const right = await evaluate(cdp, cameraAtPointer);
  check("side wheel pans right without zooming or moving vertically", Math.abs(right.width - initialCamera.width) < 0.02
    && Math.abs(right.y - initialCamera.y) < 0.02);
  await wheel(-80, 0);
  await waitForExpression(cdp, `Math.abs(${cameraAtPointer}.x - ${initialCamera.x}) < 0.02`, PAGE_TIMEOUT_MS);
  equal("wheel gestures leave the saved drawing unchanged", JSON.stringify(await savedElements()), JSON.stringify(beforePan));
  await gesture(resizedImage.start.map((coordinate, index) => (coordinate + resizedImage.end[index]) / 2));
  check("the image is selectable after panning", await evaluate(cdp, `
    Number(document.querySelector(".drawing-selection-box")?.getAttribute("x")) === ${resizedImage.start[0]}`));
  await wheel(0, -60);
  await waitForExpression(cdp, `${cameraAtPointer}.width < ${initialCamera.width}`, PAGE_TIMEOUT_MS);
  const dropPoint = await evaluate(cdp, `${cameraAtPointer}.anchor`);
  const dragData = { items: [], files: [photoPath], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type, x, y, data: dragData });
  }
  await waitForExpression(cdp, `document.querySelectorAll('#drawingInk [data-type="image"]').length === 2`, PAGE_TIMEOUT_MS);
  const dropped = (await savedElements()).at(-1);
  check("a file dropped after panning and zooming is embedded at the pointer", dropped.type === "image" && dropped.src === photo
    && dropped.id !== inserted.id && closeTo(dropped.start.map((value, i) => (value + dropped.end[i]) / 2), dropPoint));

  await choose("pencil");
  await evaluate(cdp, `if (!document.getElementById("drawingStylePanel").hidden) document.getElementById("drawingStyleToggle").click()`);
  const negative = await evaluate(cdp, `(() => {
    const view = document.getElementById("drawingCanvas").viewBox.baseVal;
    return [Math.ceil(view.x) + 20, Math.ceil(view.y) + 20];
  })()`);
  await gesture(negative, [negative[0] + 55, negative[1] + 35]);
  const newStroke = (await savedElements()).at(-1);
  check("drawing after panning and zooming saves ink at the correct world coordinates",
    newStroke.type === "pencil" && negative.every(value => value < 0) && closeTo(newStroke.points[0], negative));
  await cdp.send("Page.reload");
  await waitForExpression(cdp, saved, PAGE_TIMEOUT_MS);
  check("the dropped image reopens with its saved pixels", await evaluate(cdp, `
    document.querySelector('[data-element-id="${dropped.id}"]')?.getAttribute("href") === ${JSON.stringify(photo)}`));
  check("reopening fits strokes outside the original canvas origin", await evaluate(cdp, `(() => {
    const box = document.querySelector('[data-element-id="${newStroke.id}"]').getBoundingClientRect();
    return box.width > 0 && box.left >= -1 && box.right <= innerWidth;
  })()`));

  const imageCount = `document.querySelectorAll('#drawingInk [data-type="image"]').length`;
  const paste = await evaluate(cdp, `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(photo.split(",")[1])}), value => value.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], "pasted-screenshot.png", { type: "image/png" }));
    const pasteOn = target => !target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    const title = document.getElementById("drawingTitle");
    title.focus();
    const titleHandled = pasteOn(title);
    title.blur();
    return { titleHandled, canvasHandled: pasteOn(document.body) };
  })()`);
  check("pasting a clipboard image imports it on the drawing and leaves title paste alone", paste.canvasHandled && !paste.titleHandled);
  await waitForExpression(cdp, `${imageCount} === 3`, PAGE_TIMEOUT_MS);
  const pasted = (await savedElements()).at(-1);
  check("pasting a clipboard bitmap saves its pixels", pasted.type === "image" && pasted.src === photo && pasted.alt === "pasted screenshot");

  check("the selected drawing image can be copied and pasted back into the canvas", await evaluate(cdp, `(() => {
    const clipboardData = new DataTransfer();
    const options = { bubbles: true, cancelable: true, clipboardData };
    const copied = !document.body.dispatchEvent(new ClipboardEvent("copy", options));
    return copied && !document.body.dispatchEvent(new ClipboardEvent("paste", options));
  })()`));
  await waitForExpression(cdp, `${imageCount} === 4`, PAGE_TIMEOUT_MS);
  const copy = (await savedElements()).at(-1);
  check("the copied image saves as a separate object with the same pixels and description",
    copy.type === "image" && copy.id !== pasted.id && copy.src === pasted.src && copy.alt === pasted.alt);
}

async function checkSpaces(cdp, base, dataDir) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: base + "/storage" });
  await waitForPage(cdp, base + "/storage", PAGE_TIMEOUT_MS);
  await waitForExpression(cdp, `document.getElementById("spaceAdd")?.hidden === false`, PAGE_TIMEOUT_MS);
  const folder = path.join(dataDir, "work");
  const notes = "# Draft notes\n\nRecieve qzxqzxqz Markdown that was here before the Space.\n";
  await mkdir(folder);
  await writeFile(path.join(folder, "Draft notes.md"), notes);
  await evaluate(cdp, `(() => {
    document.getElementById("spaceAdd").click();
    document.getElementById("spaceName").value = "Work";
    const folder = document.getElementById("spaceFolder");
    folder.value = ${JSON.stringify(folder)};
    folder.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  check("the Space dialog fits a 390px viewport", await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`));
  await evaluate(cdp, `(() => {
    document.getElementById("spaceImport").click();
    document.getElementById("spaceForm").requestSubmit();
  })()`);
  await waitForExpression(cdp, `document.querySelector("#spaceList [data-space-id]")`, PAGE_TIMEOUT_MS);
  check("Storage reports the imported Markdown file", await evaluate(cdp, `document.getElementById("spaceStatus").textContent.includes("Imported 1 Markdown file.")`));
  equal("the import leaves the original Markdown untouched", await readFile(path.join(folder, "Draft notes.md"), "utf8"), notes);
  const space = await evaluate(cdp, `document.querySelector("#spaceList [data-space-id]").dataset.spaceId`);
  check("Space storage fits a 390px viewport", await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`));
  await cdp.send("Page.navigate", { url: base + "/" });
  await waitForExpression(cdp, `location.pathname === "/" && document.querySelector('#librarySpace option[value="${space}"]')`, PAGE_TIMEOUT_MS);
  check("the library Space picker fits a 390px viewport", await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`));

  async function chooseSpace(value) {
    await evaluate(cdp, `(() => {
      const picker = document.getElementById("librarySpace");
      picker.value = ${JSON.stringify(value)};
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
  }

  await chooseSpace(space);
  equal(
    "choosing a Space shows its imported document",
    await evaluate(cdp, `Array.from(document.querySelectorAll(".document-card-title"), (title) => title.textContent).join(", ")`),
    "Draft notes",
  );
  await evaluate(cdp, `document.getElementById("newDocument").click()`);
  await waitForPage(cdp, base + "/doc/new/", PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  const id = await evaluate(cdp, `location.pathname.split("/").pop()`);
  await evaluate(cdp, `(() => {
    const title = document.getElementById("documentTitle");
    title.value = "Space test document";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("backToLibrary").click();
  })()`);
  await waitForExpression(cdp, `location.pathname === "/" && document.querySelector('[data-document-id="${id}"]')`, PAGE_TIMEOUT_MS);
  equal("returning from the editor keeps the Space selected", await evaluate(cdp, `document.getElementById("librarySpace").value`), space);
  equal("a draft saves into the selected Space folder", await readFile(path.join(folder, "Space test document.md"), "utf8"), "");

  await evaluate(cdp, `(() => {
    const card = document.querySelector('[data-document-id="${id}"]');
    card.querySelector(".card-menu-button").click();
    card.querySelector(".card-move").click();
    document.getElementById("moveSpace").value = "";
    document.getElementById("actionConfirm").click();
  })()`);
  await waitForExpression(cdp, `!document.getElementById("actionDialog").open && !document.querySelector('[data-document-id="${id}"]')`, PAGE_TIMEOUT_MS);
  await chooseSpace("general");
  check("the same document appears in General after moving", await evaluate(cdp, `Boolean(document.querySelector('[data-document-id="${id}"]'))`));
  equal("the moved Markdown now lives in the main folder", await readFile(path.join(dataDir, "Space test document.md"), "utf8"), "");

  // Custom spelling words belong to the Space. General's list was filled by
  // the earlier spellcheck check, so those words are still wrong in Work.
  await chooseSpace(space);
  await waitForExpression(cdp, `document.querySelector('[data-document-id] .document-card-link')`, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `document.querySelector('[data-document-id] .document-card-link').click()`);
  await waitForPage(cdp, base + "/doc/", PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  const markedWords = ".doc-spelling-mark:not([hidden])";
  check("the Space marks both words while its dictionary is empty", await waitForExpression(cdp,
    `document.querySelectorAll(${JSON.stringify(markedWords)}).length === 2`, PAGE_TIMEOUT_MS));

  // Spelling marks are underline rectangles without text, so the word's point
  // comes from the painted text and the marks only say that it is marked.
  async function wordPoint(word) {
    return evaluate(cdp, `(() => {
      const word = ${JSON.stringify(word)};
      for (const line of document.querySelectorAll(".doc-line")) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.nodeValue.indexOf(word);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + word.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    })()`);
  }

  const uniqueMark = await wordPoint("qzxqzxqz");
  await cdp.send("Input.dispatchMouseEvent", { ...uniqueMark, button: "right", type: "mousePressed", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { ...uniqueMark, button: "right", type: "mouseReleased", clickCount: 1 });
  await waitForExpression(cdp, `!document.getElementById("spellingMenu").hidden`, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `document.querySelector("#spellingMenu .spelling-add").click()`);
  check("adding a word stores it in the Space's dictionary", await waitForExpression(cdp,
    `(async () => {
      const words = await fetch("/api/spelling/words?space=${space}").then((response) => response.json());
      return words.includes("qzxqzxqz");
    })()`, PAGE_TIMEOUT_MS));
  check("the word does not join General's dictionary", await evaluate(cdp,
    `fetch("/api/spelling/words").then((response) => response.json()).then((words) => !words.includes("qzxqzxqz"))`));
  check("the Space's document accepts the added word", await waitForExpression(cdp,
    `document.querySelectorAll(${JSON.stringify(markedWords)}).length === 1`, PAGE_TIMEOUT_MS));

  await cdp.send("Page.navigate", { url: base + "/doc/" + id });
  await waitForPage(cdp, base + "/doc/" + id, PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  await evaluate(cdp, `document.getElementById("docInput").focus()`);
  await cdp.send("Input.insertText", { text: "qzxqzxqz " });
  check("a Space's dictionary word is still misspelled in General", await waitForExpression(cdp,
    `document.querySelectorAll(${JSON.stringify(markedWords)}).length === 1`, PAGE_TIMEOUT_MS));
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

async function checkSpellcheck(cdp, base, pressKey, tap) {
  const content = '<p>We <strong>rec</strong><em>ieve</em> letters.</p>' +
    '<p>See https://misspeling.example and <code>misspeling</code>.</p><pre>misspeling</pre>';
  const id = await evaluate(cdp, `(async () => {
    const result = await fetch("/api/documents", { method: "POST" });
    const { id } = await result.json();
    const saved = await fetch("/api/documents/" + id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Spelling test", content: ${JSON.stringify(content)} }),
    });
    if (!saved.ok) throw new Error("Could not seed the spelling test");
    return id;
  })()`);
  const url = base + "/doc/" + id;
  const mark = ".doc-spelling-mark:not([hidden])";
  const receive = '#spellingMenu [data-replacement="receive"]';
  const firstLine = `document.querySelector(".doc-line")`;
  const wait = (expression) => waitForExpression(cdp, expression, 6000);
  const toggle = () => evaluate(cdp, `(() => {
    document.querySelector("#documentMenuButton").click();
    document.querySelector("#spellcheckToggle").click();
  })()`);

  async function clickWord(button) {
    const point = await evaluate(cdp, `(() => {
      const mark = document.querySelector(${JSON.stringify(mark)});
      const { x, y, width, height } = mark.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { ...point, button, type: "mousePressed", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { ...point, button, type: "mouseReleased", clickCount: 1 });
  }

  await cdp.send("Page.navigate", { url });
  await waitForPage(cdp, url, PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  check("spellcheck underlines split-format prose and skips code and URLs", await wait(
    `document.querySelectorAll(${JSON.stringify(mark)}).length === 1 &&
     ${firstLine}.parentElement.querySelector(${JSON.stringify(mark)}) !== null`,
  ));
  check("spellcheck enables the browser's native title field", await evaluate(cdp,
    `document.querySelector("#documentTitle").spellcheck && !document.querySelector("#docInput").spellcheck`));

  await clickWord("right");
  check("right-click offers the intended spelling correction", await wait(
    `!spellingMenu.hidden && document.querySelector(${JSON.stringify(receive)}) !== null`,
  ));
  await evaluate(cdp, `document.querySelector(${JSON.stringify(receive)}).click()`);
  check("correction preserves the word's split formatting and returns focus", await evaluate(cdp,
    `${firstLine}.textContent === "We receive letters." && ${firstLine}.querySelector(".m-b").textContent === "rec" &&
     ${firstLine}.querySelector(".m-i").textContent === "eive" && document.activeElement.id === "docInput"`));
  await pressKey("s", "KeyS", 83, 2);
  check("correction saves without spelling decoration", await wait(`(async () => {
    const saved = await fetch("/api/documents/${id}").then((result) => result.json());
    return saved.content.includes("<b>rec</b><i>eive</i>") && !saved.content.includes("doc-spelling");
  })()`));
  await pressKey("z", "KeyZ", 90, 2);
  check("a single undo restores the original misspelling and mark", await wait(
    `${firstLine}.textContent === "We recieve letters." && document.querySelector(${JSON.stringify(mark)}) !== null`,
  ));

  await clickWord("left");
  await pressKey("F10", "F10", 121, 8);
  check("shift+F10 opens suggestions at the caret", await wait(`!spellingMenu.hidden`));
  await pressKey("Escape", "Escape", 27, 0);
  check("Escape dismisses suggestions and restores typing focus", await evaluate(cdp,
    `spellingMenu.hidden && document.activeElement.id === "docInput"`));

  await pressKey("Home", "Home", 36, 2);
  await cdp.send("Input.insertText", { text: "teh" });
  check("an unfinished word stays unmarked after the spelling check", await wait(
    `${firstLine}.parentElement.querySelector(".doc-spelling-mark[hidden]") !== null`,
  ));
  await cdp.send("Input.insertText", { text: " " });
  check("finishing the word shows both misspellings", await wait(
    `${firstLine}.parentElement.querySelectorAll(${JSON.stringify(mark)}).length === 2`,
  ));
  for (let i = 0; i < 4; i += 1) await pressKey("Backspace", "Backspace", 8, 0);
  await pressKey("s", "KeyS", 83, 2);

  await evaluate(cdp, `document.querySelector("#documentTitle").focus()`);
  await pressKey("s", "KeyS", 83, 3);
  check("Ctrl+Alt+S clears spelling marks and keeps focus in the title", await evaluate(cdp,
    `document.querySelectorAll(".doc-spelling-mark").length === 0 && !document.querySelector("#documentTitle").spellcheck &&
     document.querySelector("#spellcheckToggle").getAttribute("aria-checked") === "false" &&
     document.activeElement.id === "documentTitle"`));
  await cdp.send("Page.reload");
  await waitForPage(cdp, url, PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  check("the spellcheck preference survives a reload", await evaluate(cdp,
    `document.querySelector("#spellcheckToggle").getAttribute("aria-checked") === "false"`));
  await toggle();
  check("turning spellcheck back on checks the document", await wait(`document.querySelector(${JSON.stringify(mark)}) !== null`));

  await pressKey("m", "KeyM", 77, 10);
  check("the spelling marks are absent from Markdown source", await evaluate(cdp,
    `document.body.classList.contains("is-markdown-mode") && !document.querySelector(".doc-spelling-mark")`));
  await pressKey("m", "KeyM", 77, 10);
  check("returning to rich text restores spelling marks", await wait(`document.querySelector(${JSON.stringify(mark)}) !== null`));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 650, deviceScaleFactor: 1, mobile: true });
  await tap(mark);
  check("a phone tap opens suggestions without a text keyboard and the menu fits", await wait(`(() => {
    if (spellingMenu.hidden || !document.querySelector(${JSON.stringify(receive)})) return false;
    const rect = spellingMenu.getBoundingClientRect();
    return document.activeElement.id !== "docInput" && rect.left >= 0 && rect.right <= innerWidth &&
      rect.top >= 0 && rect.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth + 1;
  })()`));
  await tap(receive);
  check("a phone tap applies the replacement", await evaluate(cdp, `${firstLine}.textContent === "We receive letters."`));
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  await pressKey("z", "KeyZ", 90, 2);
  check("undo makes the original word available to add to the dictionary", await wait(
    `${firstLine}.textContent === "We recieve letters." && document.querySelector(${JSON.stringify(mark)}) !== null`,
  ));
  await clickWord("right");
  await evaluate(cdp, `document.querySelector("#spellingMenu .spelling-add").click()`);
  check("adding a word clears its underline and preserves the text", await wait(
    `!document.querySelector(".doc-spelling-mark") && ${firstLine}.textContent === "We recieve letters."`,
  ));
  await cdp.send("Page.navigate", { url: base + "/doc/new" });
  await waitForPage(cdp, base + "/doc/new/", PAGE_TIMEOUT_MS);
  await waitForEditor(cdp, PAGE_TIMEOUT_MS);
  await pressKey("Enter", "Enter", 13, 0);
  await cdp.send("Input.insertText", { text: "Recieve and qzxqzxqz " });
  check("the custom word stays accepted in a new document with different capitalization", await wait(
    `document.querySelectorAll(${JSON.stringify(mark)}).length === 1 && ${firstLine}.textContent.includes("Recieve and qzxqzxqz")`,
  ));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
