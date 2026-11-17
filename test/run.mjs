// Browser test runner for the editor.
//
// The editor's layout is measured from Canvas and painted into the DOM, so the
// only honest way to test carets, selections, and clicks is in a real browser.
// This script starts a small static server, launches headless Chrome, and asks
// the harness page for its results. It has no npm dependencies.
//
//   node test/run.mjs                 run every browser test
//   node test/run.mjs --screenshot    also save test/artifacts/editor.png
//   CHROME_PATH=... node test/run.mjs use a specific Chrome/Chromium binary

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT_FILE_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 120000;

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "google-chrome",
    "chromium",
  ];
  return candidates.filter(Boolean);
}

async function fileExists(candidate) {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch (error) {
    return false;
  }
}

function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) {
        pathname += "index.html";
      }
      const target = path.resolve(ROOT, "." + pathname);
      if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const info = await stat(target);
      if (!info.isFile()) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404);
      response.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function waitForPortFile(userDataDir, deadline) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(file, "utf8");
      const [port, wsPath] = contents.trim().split("\n");
      if (port && wsPath) {
        return { port: Number(port), wsPath: wsPath.trim() };
      }
    } catch (error) {
      // Chrome has not written it yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Chrome did not expose a DevTools port");
}

async function connectWebSocket(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  let closedError = null;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to Chrome DevTools")),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || "DevTools command failed"));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    events.push(message);
  });

  socket.addEventListener("close", () => {
    closedError = new Error("Chrome closed the DevTools connection");
    for (const entry of pending.values()) {
      entry.reject(closedError);
    }
    pending.clear();
  });

  function send(method, params) {
    if (closedError) {
      return Promise.reject(closedError);
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  return { send, events, close: () => socket.close() };
}

function collectDiagnostics(events) {
  const consoleMessages = [];
  const exceptions = [];
  for (const event of events) {
    if (event.method === "Runtime.consoleAPICalled") {
      const text = (event.params.args || [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type))
        .join(" ");
      consoleMessages.push({ type: event.params.type, text });
    } else if (event.method === "Runtime.exceptionThrown") {
      const details = event.params.exceptionDetails || {};
      exceptions.push(details.exception?.description || details.text || "unknown exception");
    } else if (event.method === "Log.entryAdded") {
      consoleMessages.push({
        type: "log:" + (event.params.entry.level || "info"),
        text: event.params.entry.text || "",
      });
    }
  }
  return { consoleMessages, exceptions };
}

async function launchChrome(pageUrl, userDataDir) {
  const candidates = findChrome();
  let executable = null;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      executable = candidate;
      break;
    }
  }
  if (!executable) {
    throw new Error("Could not find Chrome. Set CHROME_PATH to a Chrome or Chromium binary.");
  }

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate,MediaRouter",
    "--disable-sync",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--no-default-browser-check",
    "--no-first-run",
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDataDir,
    "--window-size=1280,900",
    pageUrl,
  ];
  const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

async function findPageTarget(port, pageUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === "page" && target.url && target.url.startsWith(pageUrl.split("?")[0]),
      );
      if (page && page.webSocketDebuggerUrl) {
        return page;
      }
    } catch (error) {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not expose the test page");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(
      details.exception?.description || details.text || "Evaluation failed in the page",
    );
  }
  return result.result ? result.result.value : undefined;
}

async function waitForPage(cdp, pageUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(
        cdp,
        "({ href: location.href, ready: document.readyState })",
      );
      if (state && state.href.startsWith(pageUrl) && state.ready === "complete") {
        return;
      }
    } catch (error) {
      // The page may still be navigating; its execution context is replaced.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The test page did not finish loading");
}

async function main() {
  const wantScreenshot = process.argv.includes("--screenshot");
  const { server, port: serverPort } = await startServer();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "grapho-editor-test-"));
  const pageUrl = `http://127.0.0.1:${serverPort}/test/harness.html`;
  let chrome = null;
  let cdp = null;

  try {
    chrome = await launchChrome(pageUrl, userDataDir);
    const { port } = await waitForPortFile(userDataDir, Date.now() + PORT_FILE_TIMEOUT_MS);
    const target = await findPageTarget(port, pageUrl, Date.now() + PORT_FILE_TIMEOUT_MS);
    cdp = await connectWebSocket(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await waitForPage(cdp, pageUrl, Date.now() + PORT_FILE_TIMEOUT_MS);

    const expression = `
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.__results) {
            clearInterval(timer);
            resolve(JSON.stringify(window.__results));
          } else if (Date.now() - started > ${TEST_TIMEOUT_MS}) {
            clearInterval(timer);
            reject(new Error("The harness page did not finish its tests"));
          }
        }, 50);
      })
    `;
    const raw = await evaluate(cdp, expression);
    const results = JSON.parse(raw);

    if (wantScreenshot) {
      try {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        const directory = path.join(ROOT, "test", "artifacts");
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, "editor.png");
        await writeFile(file, Buffer.from(shot.data, "base64"));
        console.log(`Screenshot: ${path.relative(ROOT, file)}`);
      } catch (error) {
        console.log(`Screenshot failed: ${error.message}`);
      }
    }

    const diagnostics = collectDiagnostics(cdp.events);
    for (const test of results.tests) {
      const label = test.ok ? "PASS" : "FAIL";
      console.log(`${label} ${test.name}${test.duration ? ` (${test.duration} ms)` : ""}`);
      if (!test.ok) {
        for (const line of String(test.detail || "").split("\n")) {
          console.log("     " + line);
        }
      } else if (process.argv.includes("--verbose") && test.detail) {
        for (const line of String(test.detail).split("\n")) {
          console.log("     " + line);
        }
      }
    }

    if (process.argv.includes("--verbose") && results.notes && results.notes.length) {
      console.log("\nNotes:");
      for (const note of results.notes) {
        console.log("  - " + note);
      }
    }

    if (diagnostics.consoleMessages.length) {
      console.log("\nConsole:");
      for (const message of diagnostics.consoleMessages) {
        console.log(`  [${message.type}] ${message.text}`);
      }
    }
    if (diagnostics.exceptions.length) {
      console.log("\nUncaught exceptions:");
      for (const exception of diagnostics.exceptions) {
        console.log("  " + exception);
      }
    }

    const failed = results.tests.filter((test) => !test.ok);
    console.log(
      `\n${results.tests.length - failed.length} passed, ${failed.length} failed` +
        (results.setupError ? `; setup error: ${results.setupError}` : ""),
    );
    if (results.setupError) {
      process.exitCode = 1;
    }
    if (failed.length || diagnostics.exceptions.length) {
      process.exitCode = 1;
    }
  } finally {
    if (cdp) {
      cdp.close();
    }
    if (chrome && chrome.child && chrome.child.exitCode === null) {
      chrome.child.kill();
      await Promise.race([chrome.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    server.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
