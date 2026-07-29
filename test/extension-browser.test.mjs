import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";

const EXTENSION_SOURCE = dirname(fileURLToPath(new URL("../extension/manifest.json", import.meta.url)));
const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Redline extension fixture</title>
    <style>
      body { margin: 0; padding: 80px; font: 16px system-ui, sans-serif; }
      button { width: 220px; height: 56px; }
    </style>
  </head>
  <body>
    <button data-testid='checkout"primary\\button'>Complete checkout</button>
  </body>
</html>`;

let chromeProcess;
let chromeProfile;
let debuggingPort;
let fixtureServer;
let fixtureOrigin;
let extensionPath;
let worker;
let page;

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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

  close() {
    this.socket?.close();
  }
}

function findChrome() {
  const cachedRoots = [
    join(homedir(), ".cache", "puppeteer", "chrome"),
    join(homedir(), "Library", "Caches", "ms-playwright")
  ];
  const cachedChrome = cachedRoots.flatMap((root) => {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(
        root,
        entry.name,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      ));
  }).filter(existsSync).sort().reverse();

  return [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    ...cachedChrome,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean).find(existsSync);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForTarget(predicate, description) {
  let lastTargets = [];
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      if (response.ok) {
        lastTargets = await response.json();
        const target = lastTargets.find(predicate);
        if (target) return target;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chrome did not expose ${description}. Targets: ${JSON.stringify(lastTargets)}`);
}

async function poll(operation, predicate, description) {
  let value;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

before(async () => {
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

  const chromePath = findChrome();
  assert.ok(chromePath, "Set CHROME_BIN (or CHROME_PATH) to Chrome/Chromium");
  debuggingPort = await freePort();
  chromeProfile = mkdtempSync(join(tmpdir(), "redline-extension-chrome-"));
  extensionPath = join(chromeProfile, "extension");
  cpSync(EXTENSION_SOURCE, extensionPath, { recursive: true });
  const testManifestPath = join(extensionPath, "manifest.json");
  const testManifest = JSON.parse(readFileSync(testManifestPath, "utf8"));
  testManifest.host_permissions = ["http://127.0.0.1/*"];
  testManifest.permissions.push("tabs");
  writeFileSync(testManifestPath, `${JSON.stringify(testManifest, null, 2)}\n`);
  chromeProcess = spawn(chromePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--disable-gpu",
    "--no-default-browser-check",
    "--no-first-run",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${chromeProfile}`,
    fixtureOrigin
  ], { stdio: "ignore" });

  const workerTarget = await waitForTarget(
    (target) => target.type === "service_worker" && target.url.endsWith("/background.js"),
    "the Redline service worker"
  );
  const pageTarget = await waitForTarget(
    (target) => target.type === "page" && target.url.startsWith(fixtureOrigin),
    "the fixture page"
  );
  worker = await new CdpClient(workerTarget.webSocketDebuggerUrl).connect();
  page = await new CdpClient(pageTarget.webSocketDebuggerUrl).connect();
  await worker.call("Runtime.enable");
  await page.call("Runtime.enable");
});

after(async () => {
  worker?.close();
  page?.close();
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  if (chromeProcess && chromeProcess.exitCode === null) {
    const exited = new Promise((resolve) => chromeProcess.once("exit", resolve));
    chromeProcess.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  if (chromeProfile) rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("unpacked extension captures one live annotation and persists exact target evidence", { timeout: 20_000 }, async () => {
  await poll(
    () => page.evaluate(`document.readyState`),
    (state) => state === "complete",
    "the fixture page to load"
  );
  const browserTab = await poll(
    () => worker.evaluate(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => (
      tab.url || tab.pendingUrl || ""
    ).startsWith(${JSON.stringify(fixtureOrigin)})))`),
    (tab) => tab?.status === "complete" && tab.url?.startsWith(fixtureOrigin),
    "the extension-visible fixture tab to load"
  );
  const connected = await worker.evaluate(`(async () => {
    const tab = await chrome.tabs.get(${browserTab.id});
    await connectToTab(tab);
    const key = "redline:tab-status:" + tab.id;
    const stored = await chrome.storage.session.get(key);
    return { tabId: tab.id, tab, status: stored[key] };
  })()`);
  assert.equal(connected.status?.state, "connected", `${connected.status?.message} ${JSON.stringify(connected.tab)}`);

  await poll(
    () => page.evaluate(`document.querySelectorAll("#redline-shared-review-overlay").length`),
    (count) => count === 1,
    "one injected overlay"
  );

  await worker.evaluate(`chrome.tabs.sendMessage(${connected.tabId}, { type: "redline:annotate" })`);
  const rect = await page.evaluate(`(() => {
    const rect = document.querySelector("button").getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
  })()`);

  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x - 6, y: rect.y - 6, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.right + 6, y: rect.bottom + 6, button: "left" });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.right + 6, y: rect.bottom + 6, button: "left", clickCount: 1 });
  await page.call("Input.insertText", { text: "Increase button contrast" });
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

  const review = await poll(
    () => worker.evaluate(`chrome.storage.local.get("redline.review.current").then((stored) => stored["redline.review.current"])`),
    (candidate) => candidate?.annotations?.length === 1,
    "the saved annotation"
  );
  const [annotation] = review.annotations;
  assert.equal(annotation.instruction, "Increase button contrast");
  assert.equal(annotation.target.testId, 'checkout"primary\\button');
  assert.equal(annotation.path, "/");
  assert.equal(
    await page.evaluate(`document.querySelectorAll(${JSON.stringify(annotation.target.selector)}).length`),
    1
  );

  const state = await worker.evaluate(`chrome.tabs.sendMessage(${connected.tabId}, { type: "redline:ping" })`);
  assert.equal(state.armed, false);

  await worker.evaluate(`(async () => {
    const tab = await chrome.tabs.get(${connected.tabId});
    await connectToTab(tab);
  })()`);
  assert.equal(await page.evaluate(`document.querySelectorAll("#redline-shared-review-overlay").length`), 1);

  const located = await worker.evaluate(`chrome.tabs.sendMessage(${connected.tabId}, {
    type: "redline:locate",
    id: ${JSON.stringify(annotation.id)}
  })`);
  assert.equal(located.ok, true);

  const panelTab = await worker.evaluate(`chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") })`);
  const panelTarget = await waitForTarget(
    (target) => target.type === "page" && target.url.endsWith("/sidepanel.html"),
    "the extension review panel"
  );
  const panel = await new CdpClient(panelTarget.webSocketDebuggerUrl).connect();
  await panel.call("Runtime.enable");
  try {
    const triageState = await poll(
      () => panel.evaluate(`({
        disabled: document.querySelector("#copy-button")?.disabled,
        intent: document.querySelector("#review-intent")?.value,
        count: document.querySelector("#annotation-count")?.textContent
      })`),
      (state) => state.disabled === true && state.intent === "triage" && state.count === "1 annotation",
      "the triage review panel UI"
    );
    assert.equal(triageState.disabled, true);

    await worker.evaluate(`mutateStoredReview({
      operation: "patch-review",
      patch: { intent: "agent", updatedAt: "2026-07-29T12:30:00.000Z" },
      mutationId: "test:intent-agent"
    })`);
    await poll(
      () => panel.evaluate(`({
        disabled: document.querySelector("#copy-button").disabled,
        helpHidden: document.querySelector("#copy-help").hidden
      })`),
      (state) => state.disabled === false && state.helpHidden === true,
      "agent handoff to become available"
    );

    await worker.evaluate(`mutateStoredReview({
      operation: "patch-review",
      patch: { intent: "designer", updatedAt: "2026-07-29T12:31:00.000Z" },
      mutationId: "test:intent-designer"
    })`);
    const designerState = await poll(
      () => panel.evaluate(`({
        disabled: document.querySelector("#copy-button").disabled,
        help: document.querySelector("#copy-help").textContent
      })`),
      (state) => state.disabled === true && state.help.includes("return to the designer"),
      "designer handoff to disable agent copy"
    );
    assert.equal(designerState.disabled, true);
  } finally {
    await panel.call("Page.close").catch(() => {});
    panel.close();
    await worker.evaluate(`chrome.tabs.remove(${panelTab.id}).catch(() => {})`);
  }

  const concurrentAnnotation = {
    ...annotation,
    id: "annotation_concurrent",
    instruction: "Keep this concurrent annotation",
    createdAt: "2026-07-29T13:00:00.000Z",
    updatedAt: "2026-07-29T13:00:00.000Z"
  };
  const concurrentResult = await worker.evaluate(`Promise.all([
    mutateStoredReview({
      operation: "patch-review",
      patch: { title: "Concurrent review title", updatedAt: "2026-07-29T13:00:00.000Z" },
      mutationId: "test:title"
    }),
    mutateStoredReview({
      operation: "append",
      annotation: ${JSON.stringify(concurrentAnnotation)},
      mutationId: "test:annotation"
    })
  ]).then(() => chrome.storage.local.get("redline.review.current"))`);
  const concurrentReview = concurrentResult["redline.review.current"];
  assert.equal(concurrentReview.title, "Concurrent review title");
  assert.deepEqual(
    concurrentReview.annotations.map((item) => item.instruction),
    ["Increase button contrast", "Keep this concurrent annotation"]
  );
});
