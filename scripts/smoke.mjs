#!/usr/bin/env node
/**
 * Credential-free smoke test: boots the stdio server, lists tools, and exercises
 * the two offline tools. Verifies the MCP handshake and schema wiring without
 * touching Dare or spending credits.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUESTS = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dare_estimate_cost", arguments: { kind: "video", model: "seedance-2-5", quality: "720p", duration_seconds: 10, count: 2 } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dare_list_models", arguments: { kind: "video", response_format: "json" } } },
];

// Isolate from any real stored credentials so the smoke test never touches a live account.
const child = spawn("node", ["dist/cli.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, DARE_CLIENT_TOKEN: "", DARE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "dare-smoke-")) },
});

let buffer = "";
const responses = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  }
});

for (const request of REQUESTS) child.stdin.write(`${JSON.stringify(request)}\n`);

await new Promise((r) => setTimeout(r, 2500));
child.kill();

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const init = responses.get(1);
if (init?.result?.serverInfo?.name !== "dare-mcp-server") fail("initialize did not return the expected serverInfo");

const tools = responses.get(2)?.result?.tools ?? [];
if (tools.length < 13) fail(`expected at least 13 tools, got ${tools.length}`);
for (const tool of tools) {
  if (!tool.description || tool.description.length < 40) fail(`tool ${tool.name} has a thin description`);
  if (!tool.inputSchema) fail(`tool ${tool.name} has no input schema`);
  if (!tool.annotations) fail(`tool ${tool.name} has no annotations`);
}

const estimate = responses.get(3)?.result?.structuredContent;
// 2 x (10s x $0.473 = $4.73 -> x1.5 / $0.06665 = 106.4 -> rounded up to 110) = 220, matching Dare's billing.
if (estimate?.estimated_total_credits !== 220) fail(`cost estimate drifted: ${JSON.stringify(estimate)}`);

const models = responses.get(4)?.result?.structuredContent?.video_models ?? [];
if (!models.some((m) => m.id === "seedance-2-5")) fail("seedance-2-5 missing from the catalogue");

console.log(`PASS: ${tools.length} tools, handshake ok, pricing stable.`);
