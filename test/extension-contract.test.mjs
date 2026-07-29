import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const extensionUrl = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionUrl), "utf8"));
const background = await readFile(new URL("background.js", extensionUrl), "utf8");
const content = await readFile(new URL("content.js", extensionUrl), "utf8");
const panel = await readFile(new URL("sidepanel.html", extensionUrl), "utf8");
const panelScript = await readFile(new URL("sidepanel.js", extensionUrl), "utf8");

test("manifest keeps the Chrome experiment local and minimally privileged", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(Number(manifest.minimum_chrome_version) >= 114, true);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "scripting", "sidePanel", "storage"].sort()
  );
  assert.equal("host_permissions" in manifest, false);
  assert.equal("content_scripts" in manifest, false);
  assert.equal("externally_connectable" in manifest, false);
});

test("every declared extension entry point exists", async () => {
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.web_accessible_resources.flatMap(({ resources }) => resources),
    ...[...panel.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  ];

  await Promise.all(files.map((file) => access(new URL(file, extensionUrl))));
});

test("page injection loads shared contracts before the overlay", () => {
  assert.match(background, /files:\s*\["shared\.js", "targeting\.js", "content\.js"\]/);
  assert.match(background, /redline:connect-tab/);
  assert.match(panelScript, /redline:connect-tab/);
  assert.doesNotMatch(content, /STORAGE_KEY\s*\|\|/);
  assert.doesNotMatch(panelScript, /STORAGE_KEY\s*\|\|/);
});

test("current-review writes are serialized by the service worker", () => {
  assert.match(background, /reviewMutationChain/);
  assert.match(background, /redline:mutate-review/);
  assert.doesNotMatch(content, /\[STORAGE_KEY\]\s*:/);
  assert.doesNotMatch(panelScript, /\[STORAGE_KEY\]\s*:/);
});

test("side-panel intent choices match the portable review enum", () => {
  const values = [...panel.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["triage", "agent", "designer"]);
});
