import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

const OVERLAY_SOURCE = readFileSync(new URL("../overlay.js", import.meta.url), "utf8");
const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Redline browser fixture</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
      body > div:first-child { padding: 24px; }
      button { width: 140px; height: 40px; }
    </style>
  </head>
  <body>
    <div><div><button>Exact target</button></div></div>
    <div><div><div><div><button>Duplicate suffix decoy</button></div></div></div></div>
  </body>
</html>`;

let chrome;
let chromeProfile;
let debuggingPort;
let fixtureServer;
let fixtureOrigin;

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.listeners.get(message.method);
      if (!listeners) return;
      for (const listener of [...listeners]) listener(message.params || {});
    });
    return this;
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.off(method, listener);
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
  }

  off(method, listener) {
    this.listeners.get(method)?.delete(listener);
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Browser evaluation failed: ${detail}`);
    }
    return result.result.value;
  }

  async close() {
    try {
      await this.call("Page.close");
    } catch {}
    this.socket.close();
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  return candidates.find(existsSync);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForChrome(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chrome did not expose CDP: ${lastError || "timed out"}`);
}

async function openPage(path = "/") {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, {
    method: "PUT"
  });
  assert.equal(response.ok, true, `Could not create Chrome target: ${response.status}`);
  const target = await response.json();
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  const loaded = client.once("Page.loadEventFired");
  await client.call("Page.navigate", { url: fixtureOrigin + path });
  await loaded;
  return client;
}

async function inject(client) {
  return client.evaluate(`(0, eval)(${JSON.stringify(OVERLAY_SOURCE)}); true`);
}

async function clearStorage(client) {
  await client.evaluate(`localStorage.clear(); delete window.__redline; delete window.__redlineQueue`);
}

async function addTargetMark(client, instruction = "Fix the exact target") {
  return client.evaluate(`(() => {
    const target = [...document.querySelectorAll("button")]
      .find((element) => element.textContent === "Exact target");
    const rect = target.getBoundingClientRect();
    return window.__redline.addMark(
      { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      ${JSON.stringify(instruction)}
    );
  })()`);
}

before(async () => {
  fixtureServer = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

  const chromePath = findChrome();
  assert.ok(
    chromePath,
    "Set CHROME_BIN (or CHROME_PATH) to an installed Chrome or Chromium executable"
  );
  debuggingPort = await freePort();
  chromeProfile = mkdtempSync(join(tmpdir(), "redline-chrome-"));
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--no-default-browser-check",
      "--no-first-run",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${chromeProfile}`,
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  await waitForChrome(debuggingPort);
});

after(async () => {
  if (fixtureServer) {
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("injection is idempotent", { timeout: 10_000 }, async () => {
  const page = await openPage("/idempotent");
  try {
    await clearStorage(page);
    await inject(page);
    await page.evaluate(`window.__redline.__identity = "first"`);
    await inject(page);
    const state = await page.evaluate(`({
      roots: document.querySelectorAll("#rl-root").length,
      toolbars: document.querySelectorAll(".rl-toolbar").length,
      identity: window.__redline.__identity
    })`);
    assert.deepEqual(state, { roots: 1, toolbars: 1, identity: "first" });
  } finally {
    await page.close();
  }
});

test("captured selectors identify the exact element under duplicate DOM suffixes", async () => {
  const page = await openPage("/selectors");
  try {
    await clearStorage(page);
    await inject(page);
    const mark = await addTargetMark(page);
    const target = mark.elements.find((element) => element.text === "Exact target");
    assert.ok(target, "Expected the exact button to be among the captured candidates");
    assert.equal(typeof target.selector, "string");
    const resolution = await page.evaluate(`(() => {
      const selector = ${JSON.stringify(target.selector)};
      const matches = document.querySelectorAll(selector);
      return {
        count: matches.length,
        text: matches[0] && matches[0].textContent,
        rooted: selector.startsWith("body > ") || selector.startsWith("#") || selector.startsWith("[")
      };
    })()`);
    assert.deepEqual(resolution, { count: 1, text: "Exact target", rooted: true });
  } finally {
    await page.close();
  }
});

test("SPA navigation serializes marks into separate URL-scoped views", async () => {
  const page = await openPage("/one");
  try {
    await clearStorage(page);
    await inject(page);
    await addTargetMark(page, "First view");
    await page.evaluate(`history.pushState({}, "", "/two"); document.title = "Second view"`);
    // Deliberately add the next mark before the 500 ms URL watcher can run.
    await addTargetMark(page, "Second view");
    const queue = await page.evaluate(`window.__redline.finish(); window.__redlineQueue`);
    assert.equal(queue.version, 2);
    assert.equal(queue.views.length, 2);
    assert.deepEqual(
      queue.views.map((view) => new URL(view.url).pathname),
      ["/one", "/two"]
    );
    assert.deepEqual(
      queue.views.map((view) => view.items[0].instruction),
      ["First view", "Second view"]
    );
  } finally {
    await page.close();
  }
});

test("removing the last draft mark releases its route context", async () => {
  const page = await openPage("/removed-draft-old-route");
  try {
    await clearStorage(page);
    await inject(page);
    const first = await addTargetMark(page, "Remove me");
    await page.evaluate(`window.__redline.removeMark(${JSON.stringify(first.id)})`);
    await page.evaluate(`history.pushState({}, "", "/removed-draft-new-route")`);
    await addTargetMark(page, "Keep me");
    const queue = await page.evaluate(`window.__redline.finish(); window.__redlineQueue`);
    assert.equal(queue.views.length, 1);
    assert.equal(new URL(queue.views[0].url).pathname, "/removed-draft-new-route");
    assert.equal(queue.views[0].items[0].instruction, "Keep me");
  } finally {
    await page.close();
  }
});

test("a hard reload resumes successfully saved views", async () => {
  const page = await openPage("/reload-resume");
  try {
    await clearStorage(page);
    await inject(page);
    await addTargetMark(page, "Survive reload");
    await page.evaluate(`window.__redline.saveView()`);

    const loaded = page.once("Page.loadEventFired");
    await page.call("Page.reload", { ignoreCache: true });
    await loaded;
    await inject(page);

    const state = await page.evaluate(`({
      views: window.__redline.views.length,
      instruction: window.__redline.views[0].items[0].instruction,
      roots: document.querySelectorAll("#rl-root").length
    })`);
    assert.deepEqual(state, { views: 1, instruction: "Survive reload", roots: 1 });
  } finally {
    await page.close();
  }
});

test("Browse passes pointer events through to the reviewed page", async () => {
  const page = await openPage("/browse-events");
  try {
    await clearStorage(page);
    await inject(page);
    const state = await page.evaluate(`(() => {
      const target = [...document.querySelectorAll("button")]
        .find((element) => element.textContent === "Exact target");
      const rect = target.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      window.__redline.setMode("browse");
      const browseHit = document.elementFromPoint(point.x, point.y);
      window.__redline.setMode("draw");
      const drawHit = document.elementFromPoint(point.x, point.y);
      return {
        browseText: browseHit && browseHit.textContent,
        drawClass: drawHit && drawHit.className
      };
    })()`);
    assert.equal(state.browseText, "Exact target");
    assert.match(state.drawClass, /rl-draw-layer/);
  } finally {
    await page.close();
  }
});

test("keyboard shortcuts change mode but ignore focused page fields", async () => {
  const page = await openPage("/keyboard-shortcuts");
  try {
    await clearStorage(page);
    await inject(page);
    const state = await page.evaluate(`(() => {
      window.__redline.setMode("browse");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
      const afterR = window.__redline.mode;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
      const afterB = window.__redline.mode;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      const afterEscape = window.__redline.mode;
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
      return { afterR, afterB, afterEscape, whileTyping: window.__redline.mode };
    })()`);
    assert.deepEqual(state, {
      afterR: "draw",
      afterB: "browse",
      afterEscape: "browse",
      whileTyping: "browse"
    });
  } finally {
    await page.close();
  }
});

test("saved item edit and remove update the durable queue", async () => {
  const page = await openPage("/saved-edit-remove");
  try {
    await clearStorage(page);
    await inject(page);
    await addTargetMark(page, "Original wording");
    await page.evaluate(`window.__redline.saveView()`);
    const state = await page.evaluate(`(() => {
      const view = window.__redline.views[0];
      const item = view.items[0];
      const elementsBefore = JSON.stringify(item.elements);
      window.__redline.editSavedItem(view, item);
      const textarea = document.querySelector(".rl-popover textarea");
      textarea.value = "Updated wording";
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const afterEdit = JSON.parse(localStorage.getItem("redline.queue"));
      const elementsAfter = JSON.stringify(afterEdit.views[0].items[0].elements);
      window.__redline.removeSavedItem(view, item);
      const afterRemove = JSON.parse(localStorage.getItem("redline.queue"));
      return {
        instruction: afterEdit.views[0].items[0].instruction,
        elementsUnchanged: elementsBefore === elementsAfter,
        viewsAfterRemove: afterRemove.views.length
      };
    })()`);
    assert.deepEqual(state, {
      instruction: "Updated wording",
      elementsUnchanged: true,
      viewsAfterRemove: 0
    });
  } finally {
    await page.close();
  }
});

test("Finish, Reopen, and a second Finish preserve all views", async () => {
  const page = await openPage("/finish-reopen");
  try {
    await clearStorage(page);
    await inject(page);
    await addTargetMark(page, "Before reopen");
    let state = await page.evaluate(`window.__redline.finish(); ({
      finished: window.__redline.finished,
      toolbar: !!document.querySelector(".rl-toolbar"),
      toast: !!document.querySelector(".rl-toast")
    })`);
    assert.deepEqual(state, { finished: true, toolbar: false, toast: true });

    await page.evaluate(`[
      ...document.querySelectorAll(".rl-toast button")
    ].find((button) => button.textContent === "Reopen").click()`);
    state = await page.evaluate(`({
      finished: window.__redline.finished,
      toolbar: !!document.querySelector(".rl-toolbar"),
      mode: window.__redline.mode
    })`);
    assert.deepEqual(state, { finished: false, toolbar: true, mode: "browse" });

    await addTargetMark(page, "After reopen");
    const queue = await page.evaluate(`window.__redline.finish(); window.__redlineQueue`);
    assert.equal(queue.views.length, 2);
    assert.deepEqual(
      queue.views.map((view) => view.items[0].instruction),
      ["Before reopen", "After reopen"]
    );
  } finally {
    await page.close();
  }
});

test("teardown removes the instance keyboard handler", async () => {
  const page = await openPage("/teardown");
  try {
    await clearStorage(page);
    await page.evaluate(`(() => {
      const add = window.addEventListener;
      const remove = window.removeEventListener;
      const wrappers = new Map();
      window.__redlineKeydownCalls = 0;
      window.addEventListener = function (type, listener, options) {
        if (type !== "keydown") return add.call(this, type, listener, options);
        const wrapper = function (...args) {
          window.__redlineKeydownCalls++;
          return listener.apply(this, args);
        };
        wrappers.set(listener, wrapper);
        return add.call(this, type, wrapper, options);
      };
      window.removeEventListener = function (type, listener, options) {
        const actual = type === "keydown" ? wrappers.get(listener) || listener : listener;
        wrappers.delete(listener);
        return remove.call(this, type, actual, options);
      };
    })()`);
    await inject(page);
    await page.evaluate(`window.__redline.teardown(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }))`);
    assert.equal(await page.evaluate(`window.__redlineKeydownCalls`), 0);
  } finally {
    await page.close();
  }
});

test("teardown clears UI timeouts owned by the instance", async () => {
  const page = await openPage("/teardown-timeouts");
  try {
    await clearStorage(page);
    await page.evaluate(`(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeClearTimeout = window.clearTimeout.bind(window);
      const active = new Set();
      window.__activeRedlineTimeouts = active;
      window.setTimeout = function (callback, delay, ...args) {
        let id;
        id = nativeSetTimeout(function () {
          active.delete(id);
          callback(...args);
        }, delay);
        active.add(id);
        return id;
      };
      window.clearTimeout = function (id) {
        active.delete(id);
        return nativeClearTimeout(id);
      };
    })()`);
    await inject(page);
    await addTargetMark(page);
    const state = await page.evaluate(`(() => {
      window.__redline.togglePanel();
      document.querySelector(".rl-dot").click();
      const before = window.__activeRedlineTimeouts.size;
      window.__redline.teardown();
      return { before, after: window.__activeRedlineTimeouts.size };
    })()`);
    assert.ok(state.before > 0, "Expected the blink timer to be tracked before teardown");
    assert.equal(state.after, 0);
  } finally {
    await page.close();
  }
});

test("a pending clipboard rejection cannot restart work after teardown", async () => {
  const page = await openPage("/teardown-pending-clipboard");
  try {
    await clearStorage(page);
    await page.evaluate(`(() => {
      window.__legacyCopyCalls = 0;
      window.__rejectRedlineCopy = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => new Promise((resolve, reject) => {
            window.__rejectRedlineCopy = reject;
          })
        }
      });
      document.execCommand = () => {
        window.__legacyCopyCalls++;
        return true;
      };
    })()`);
    await inject(page);
    await addTargetMark(page);
    const state = await page.evaluate(`(async () => {
      window.__redline.finish();
      const button = [...document.querySelectorAll(".rl-toast button")]
        .find((candidate) => candidate.textContent === "Copy agent prompt");
      button.click();
      window.__redline.teardown();
      window.__rejectRedlineCopy(new Error("denied after teardown"));
      await Promise.resolve();
      await Promise.resolve();
      return {
        legacyCopyCalls: window.__legacyCopyCalls,
        root: !!document.querySelector("#rl-root")
      };
    })()`);
    assert.deepEqual(state, { legacyCopyCalls: 0, root: false });
  } finally {
    await page.close();
  }
});

test("handoff prompt contains parseable queue JSON and embedded overlay source", async () => {
  const page = await openPage("/prompt");
  let receiver;
  try {
    await clearStorage(page);
    await inject(page);
    await addTargetMark(page, "Prompt mark");
    await page.evaluate(`window.__redline.finish()`);
    const prompt = await page.evaluate(`window.__redline.buildHandoffPrompt(JSON.stringify(window.__redlineQueue))`);
    assert.doesNotMatch(prompt, /raw\.githubusercontent\.com/i);
    assert.doesNotMatch(prompt, /cdn\.jsdelivr\.net/i);
    assert.doesNotMatch(prompt, /github\.com\/[^\s]+\/(?:main|master)\/overlay\.js/i);
    assert.match(prompt, /window\.__redline/);
    assert.ok(prompt.length > 10_000, "Expected the overlay source to be embedded in the prompt");

    const delimiter = "Review queue JSON:\n";
    const queueStart = prompt.lastIndexOf(delimiter);
    assert.notEqual(queueStart, -1);
    const queueJson = prompt.slice(queueStart + delimiter.length).trim();
    const queue = JSON.parse(queueJson);
    assert.equal(queue.version, 2);
    assert.equal(queue.views[0].items[0].instruction, "Prompt mark");

    const sourceDelimiter = "Exact running overlay source (inject verbatim):\n";
    const sourceStart = prompt.indexOf(sourceDelimiter);
    assert.notEqual(sourceStart, -1);
    const overlaySource = prompt
      .slice(sourceStart + sourceDelimiter.length, queueStart)
      .trim();
    receiver = await openPage("/prompt-receiver");
    await clearStorage(receiver);
    const roundTrip = await receiver.evaluate(`(() => {
      localStorage.setItem("redline.queue", ${JSON.stringify(queueJson)});
      (0, eval)(${JSON.stringify(overlaySource)});
      return {
        views: window.__redline.views.length,
        instruction: window.__redline.views[0].items[0].instruction,
        toolbar: !!document.querySelector(".rl-toolbar")
      };
    })()`);
    assert.deepEqual(roundTrip, { views: 1, instruction: "Prompt mark", toolbar: true });
  } finally {
    if (receiver) await receiver.close();
    await page.close();
  }
});

test("storage failure retains the queue and never claims a durable save", async () => {
  const page = await openPage("/storage-failure");
  try {
    await clearStorage(page);
    await page.evaluate(`Storage.prototype.setItem = function () { throw new DOMException("blocked", "QuotaExceededError") }`);
    await inject(page);
    await addTargetMark(page, "Keep in memory");
    const state = await page.evaluate(`window.__redline.finish(); ({
      queue: window.__redlineQueue,
      text: document.querySelector("#rl-root").innerText,
      stored: localStorage.getItem("redline.queue")
    })`);
    assert.equal(state.queue.views[0].items[0].instruction, "Keep in memory");
    assert.equal(state.stored, null);
    assert.doesNotMatch(state.text, /Review saved/i);
    assert.match(state.text, /failed|not saved|copy/i);
  } finally {
    await page.close();
  }
});

test("SPA persistence failure is visible and retains the auto-archived view in memory", async () => {
  const page = await openPage("/spa-storage-failure");
  try {
    await clearStorage(page);
    await page.evaluate(`Storage.prototype.setItem = function () {
      throw new DOMException("blocked", "QuotaExceededError")
    }`);
    await inject(page);
    await addTargetMark(page, "Auto-archive in memory");
    await page.evaluate(`history.pushState({}, "", "/spa-storage-failure-next")`);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const state = await page.evaluate(`({
      views: window.__redlineQueue.views.length,
      instruction: window.__redlineQueue.views[0].items[0].instruction,
      stored: localStorage.getItem("redline.queue"),
      notice: document.querySelector("#rl-root").innerText
    })`);
    assert.equal(state.views, 1);
    assert.equal(state.instruction, "Auto-archive in memory");
    assert.equal(state.stored, null);
    assert.match(state.notice, /memory|not saved|copy|download/i);
  } finally {
    await page.close();
  }
});

test("a route change while an instruction is open keeps the mark on its original URL", async () => {
  const page = await openPage("/draft-original");
  try {
    await clearStorage(page);
    await inject(page);
    const state = await page.evaluate(`(() => {
      const layer = document.querySelector(".rl-draw-layer");
      const target = [...document.querySelectorAll("button")]
        .find((element) => element.textContent === "Exact target");
      const rect = target.getBoundingClientRect();
      layer.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, button: 0, clientX: rect.left, clientY: rect.top
      }));
      window.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, button: 0, clientX: rect.right, clientY: rect.bottom
      }));
      history.pushState({}, "", "/draft-new-route");
      target.textContent = "New route content";
      target.style.borderRadius = "19px";
      document.body.style.minHeight = "3000px";
      window.scrollTo(0, 400);
      const textarea = document.querySelector(".rl-popover textarea");
      textarea.value = "Belongs to original route";
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const queue = JSON.parse(localStorage.getItem("redline.queue"));
      const item = queue.views[0].items[0];
      const exactTarget = item.elements.find((element) => element.text === "Exact target");
      return {
        viewPath: new URL(queue.views[0].url).pathname,
        instruction: item.instruction,
        currentPath: location.pathname,
        capturedOldText: !!exactTarget,
        capturedOldRadius: exactTarget && exactTarget.styles.borderRadius,
        capturedScrollY: item.scroll.y
      };
    })()`);
    assert.deepEqual(state, {
      viewPath: "/draft-original",
      instruction: "Belongs to original route",
      currentPath: "/draft-new-route",
      capturedOldText: true,
      capturedOldRadius: "0px",
      capturedScrollY: 0
    });
  } finally {
    await page.close();
  }
});

test("captured text excludes hidden descendants", async () => {
  const page = await openPage("/visible-text");
  try {
    await clearStorage(page);
    await inject(page);
    const text = await page.evaluate(`(() => {
      const target = document.createElement("button");
      target.style.cssText = "position:fixed;left:300px;top:200px;width:180px;height:40px";
      target.append("Visible label");
      const hidden = document.createElement("span");
      hidden.hidden = true;
      hidden.textContent = "PRIVATE_HIDDEN_VALUE";
      target.appendChild(hidden);
      document.body.appendChild(target);
      const rect = target.getBoundingClientRect();
      const mark = window.__redline.addMark(
        { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        "Visible text only"
      );
      return mark.elements.find((element) => element.tag === "button" &&
        element.text.includes("Visible label")).text;
    })()`);
    assert.equal(text, "Visible label");
  } finally {
    await page.close();
  }
});

test("clipboard rejection is reported after the promise rejects", async () => {
  const page = await openPage("/clipboard-failure");
  try {
    await clearStorage(page);
    await page.evaluate(`Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) }
    }); document.execCommand = () => false`);
    await inject(page);
    await addTargetMark(page);
    const label = await page.evaluate(`(async () => {
      window.__redline.finish();
      const button = [...document.querySelectorAll(".rl-toast button")]
        .find((candidate) => candidate.textContent === "Copy agent prompt");
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return button.textContent;
    })()`);
    assert.match(label, /^Copy failed/);
  } finally {
    await page.close();
  }
});

test("valid version-1 queues migrate to one version-2 view", async () => {
  const page = await openPage("/migration");
  try {
    await clearStorage(page);
    const v1 = {
      version: 1,
      url: `${fixtureOrigin}/legacy`,
      createdAt: "2025-01-02T03:04:05.000Z",
      title: "Legacy review",
      viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 },
      items: [
        {
          id: 1,
          instruction: "Migrated item",
          rect: { x: 1, y: 2, w: 3, h: 4 },
          pageRect: { x: 1, y: 2, w: 3, h: 4 },
          elements: []
        }
      ]
    };
    await page.evaluate(`localStorage.setItem("redline.queue", ${JSON.stringify(JSON.stringify(v1))})`);
    await inject(page);
    const state = await page.evaluate(`({
      views: window.__redline.views,
      stored: JSON.parse(localStorage.getItem("redline.queue"))
    })`);
    assert.equal(state.stored.version, 2);
    assert.equal(state.stored.createdAt, v1.createdAt);
    assert.equal(state.views.length, 1);
    assert.equal(state.views[0].url, v1.url);
    assert.equal(state.views[0].items[0].instruction, "Migrated item");
  } finally {
    await page.close();
  }
});

test("a version-1 migration storage failure is labelled as in-memory only", async () => {
  const page = await openPage("/migration-storage-failure");
  try {
    await clearStorage(page);
    const v1 = {
      version: 1,
      url: `${fixtureOrigin}/legacy-failure`,
      createdAt: "2025-01-02T03:04:05.000Z",
      items: [
        {
          id: 1,
          instruction: "Migrated in memory",
          rect: { x: 1, y: 2, w: 3, h: 4 },
          pageRect: { x: 1, y: 2, w: 3, h: 4 },
          elements: []
        }
      ]
    };
    const original = JSON.stringify(v1);
    await page.evaluate(`(() => {
      localStorage.setItem("redline.queue", ${JSON.stringify(original)});
      Storage.prototype.setItem = function () {
        throw new DOMException("blocked", "QuotaExceededError")
      };
    })()`);
    await inject(page);
    const state = await page.evaluate(`({
      memoryVersion: window.__redlineQueue.version,
      stored: localStorage.getItem("redline.queue"),
      notice: document.querySelector("#rl-root").innerText
    })`);
    assert.equal(state.memoryVersion, 2);
    assert.equal(state.stored, original);
    assert.match(state.notice, /memory|failed|copy|download/i);
  } finally {
    await page.close();
  }
});

for (const invalidQueue of [
  { name: "corrupt", raw: "{ definitely-not-json", warning: /invalid|corrupt|parse/i },
  { name: "null", raw: "null", warning: /invalid|corrupt/i },
  { name: "false", raw: "false", warning: /invalid|corrupt/i },
  { name: "zero", raw: "0", warning: /invalid|corrupt/i },
  { name: "empty-string", raw: JSON.stringify(""), warning: /invalid|corrupt/i },
  {
    name: "future-version",
    raw: JSON.stringify({ version: 999, createdAt: "future", views: [] }),
    warning: /unsupported|future|newer|version/i
  }
]) {
  test(`${invalidQueue.name} queues remain unchanged and produce a visible warning`, async () => {
    const page = await openPage(`/invalid-${invalidQueue.name}`);
    try {
      await clearStorage(page);
      await page.evaluate(`localStorage.setItem("redline.queue", ${JSON.stringify(invalidQueue.raw)})`);
      await inject(page);
      const state = await page.evaluate(`({
        stored: localStorage.getItem("redline.queue"),
        text: document.querySelector("#rl-root").innerText
      })`);
      assert.equal(state.stored, invalidQueue.raw);
      assert.match(state.text, invalidQueue.warning);
    } finally {
      await page.close();
    }
  });
}
