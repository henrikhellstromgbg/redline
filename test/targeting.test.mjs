import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInThisContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../extension/targeting.js", import.meta.url), "utf8");
runInThisContext(source, { filename: "extension/targeting.js" });

const { escapeAttributeValue, attributeSelector } = globalThis.RedlineTargeting;

test("escapes CSS quoted attribute values without treating them as identifiers", () => {
  assert.equal(escapeAttributeValue('quote"slash\\line\nbreak'), 'quote\\"slash\\\\line\\a break');
  assert.equal(attributeSelector("data-testid", 'quote"slash\\line\nbreak'), '[data-testid="quote\\"slash\\\\line\\a break"]');
});

test("replaces nulls and rejects dynamic attribute names", () => {
  assert.equal(escapeAttributeValue("a\0b"), "a\ufffdb");
  assert.throws(() => attributeSelector("data-testid] body", "x"), /Invalid attribute name/);
});
