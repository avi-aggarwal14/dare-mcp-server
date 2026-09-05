#!/usr/bin/env node
/**
 * Credential-free tests for the setup wizard's pure parts: token normalisation and
 * the config-file writer. Never touches Dare and never touches a real config.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normaliseToken, looksLikeJwt, registerIn } from "../dist/setup.js";
import { writeStoredConfig, readStoredConfig, configPath } from "../dist/store.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2ln";
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

/* --- token normalisation ------------------------------------------------- */

test("accepts a bare JWT", () => assert.equal(normaliseToken(JWT), JWT));
test("strips a __client= prefix", () => assert.equal(normaliseToken(`__client=${JWT}`), JWT));
test("extracts from a full cookie header", () =>
  assert.equal(normaliseToken(`foo=1; __client=${JWT}; bar=2`), JWT));
test("strips surrounding quotes", () => assert.equal(normaliseToken(`"${JWT}"`), JWT));
test("strips stray whitespace and newlines", () =>
  assert.equal(normaliseToken(`  ${JWT.slice(0, 10)}\n${JWT.slice(10)}  `), JWT));
test("url-decodes", () => assert.equal(normaliseToken(encodeURIComponent(JWT)), JWT));
test("rejects the cookie name", () => assert.equal(looksLikeJwt(normaliseToken("__client")), false));
test("rejects junk", () => assert.equal(looksLikeJwt("not-a-token"), false));
test("accepts a real-shaped JWT", () => assert.equal(looksLikeJwt(JWT), true));

/* --- config registration ------------------------------------------------- */

const dir = mkdtempSync(join(tmpdir(), "dare-setup-test-"));

test("creates a config file that does not exist yet", () => {
  const path = join(dir, "fresh.json");
  registerIn(path, true);
  const json = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(json.mcpServers.dare, { command: "npx", args: ["-y", "dare-mcp-server"], type: "stdio" });
});

test("omits type for the desktop app shape", () => {
  const path = join(dir, "desktop.json");
  registerIn(path, false);
  const json = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(json.mcpServers.dare.type, undefined);
  assert.equal(json.mcpServers.dare.command, "npx");
});

test("preserves unrelated keys and other servers", () => {
  const path = join(dir, "existing.json");
  writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "foo" } } }));
  registerIn(path, true);
  const json = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(json.theme, "dark");
  assert.equal(json.mcpServers.other.command, "foo");
  assert.ok(json.mcpServers.dare);
});

test("backs up before overwriting", () => {
  const path = join(dir, "backup.json");
  writeFileSync(path, JSON.stringify({ keep: true }));
  const { backup } = registerIn(path, true);
  assert.ok(backup && existsSync(backup));
  assert.equal(JSON.parse(readFileSync(backup, "utf8")).keep, true);
});

test("refuses to clobber invalid JSON", () => {
  const path = join(dir, "broken.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => registerIn(path, true), /not valid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("is idempotent", () => {
  const path = join(dir, "twice.json");
  registerIn(path, true);
  registerIn(path, true);
  const json = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Object.keys(json.mcpServers).length, 1);
});

/* --- credential store ---------------------------------------------------- */

test("stores and reads back the token", () => {
  process.env.DARE_CONFIG_DIR = join(dir, "store");
  const written = writeStoredConfig({ clientToken: JWT });
  assert.equal(written, configPath());
  assert.equal(readStoredConfig().clientToken, JWT);
});

test("merges rather than replaces", () => {
  writeStoredConfig({ maxCreditsPerCall: 100 });
  const stored = readStoredConfig();
  assert.equal(stored.clientToken, JWT);
  assert.equal(stored.maxCreditsPerCall, 100);
});

test("returns empty for a missing store", () => {
  process.env.DARE_CONFIG_DIR = join(dir, "nope");
  assert.deepEqual(readStoredConfig(), {});
});

console.log(`\nPASS: ${passed} setup tests.`);
