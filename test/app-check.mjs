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

    let blocks = await paintedBlocks(cdp);
    equal("editor paints every stored block", blocks.length, 11);
    equal("repeated spaces survive the sanitizer and reload", blocks[0].text, "First paragraph with  two  spaces.");
    equal("the empty paragraph survives", blocks[1].lines, 1);
    equal("the empty paragraph paints empty text", blocks[1].text, "");
    equal("hard breaks paint two lines", blocks[3].text, "Line one\nline two");
    equal("tabs are painted literally", blocks[4].text, "tab\there");
    equal("headings paint one line", blocks[5].text, "A heading");
    equal("list markers are painted", blocks[6].marker, "\u2022");
    equal("code keeps its newline and tab", blocks[9].text, "const x = 1;\n\treturn x;");

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
    equal("the paragraph count survives a real save and reload", blocks.length, 11);

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
    check("the editor still paints on a narrow viewport", mobile.blocks === 11 && mobile.lineCount > 0);
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
    const imageContent = '<p>Picture below.</p><img width="800" height="500" src="' + imageSource + '">';
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
    const noisePath = path.join(imageDir, "noise.png");
    await writeFile(tinyPath, tinyPng);
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

    await pickFile(noisePath);
    const largeTags = await waitForStoredImages(1);
    check(
      "picking a large picture re-encodes it and embeds it",
      largeTags.length === 1 &&
        /width="600"/.test(largeTags[0]) &&
        /height="450"/.test(largeTags[0]) &&
        /src="data:image\//.test(largeTags[0]),
      largeTags.join(" "),
    );

    await pickFile(tinyPath);
    const pickedTags = await waitForStoredImages(2);
    check(
      "picking a small picture keeps its natural size",
      pickedTags.some((tag) => /width="1"/.test(tag) && /height="1"/.test(tag)),
      pickedTags.join(" "),
    );
    const pickedPainted = await evaluate(cdp, `document.querySelectorAll(".doc-image").length`);
    check("the picked pictures are painted", pickedPainted === 2, String(pickedPainted));

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

    await evaluate(cdp, `fetch("/api/documents/${imageDocumentId}", { method: "DELETE" })`).catch(
      () => null,
    );

    const consoleErrors = cdp.events
      .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      .map((event) => event.params.args.map((arg) => arg.value || arg.description).join(" "));
    check("no console errors in the real editor", consoleErrors.length === 0, consoleErrors.join("\n"));

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
