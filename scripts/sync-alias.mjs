#!/usr/bin/env node
/**
 * Keeps alias/dare-mcp in lockstep with the canonical package.
 *
 * Run with --check (CI, prepublish) to fail on drift; run bare to fix it.
 * The alias pins an exact dependency, so a mismatch would ship a `dare-mcp`
 * that installs a different version of the thing it claims to be.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkgPath = join(root, "package.json");
const aliasPkgPath = join(root, "alias", "dare-mcp", "package.json");

const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const aliasPkg = JSON.parse(readFileSync(aliasPkgPath, "utf8"));

const version = rootPkg.version;
const drift = [];
if (aliasPkg.version !== version) drift.push(`version ${aliasPkg.version} -> ${version}`);
if (aliasPkg.dependencies["dare-mcp-server"] !== version) {
  drift.push(`dependency ${aliasPkg.dependencies["dare-mcp-server"]} -> ${version}`);
}

if (process.argv.includes("--check")) {
  if (drift.length) {
    console.error(`alias/dare-mcp is out of sync with ${version}:\n  ${drift.join("\n  ")}`);
    console.error("Run `npm run sync:alias` and commit the result.");
    process.exit(1);
  }
  console.log(`alias/dare-mcp is in sync at ${version}.`);
  process.exit(0);
}

if (!drift.length) {
  console.log(`alias/dare-mcp already in sync at ${version}.`);
  process.exit(0);
}

aliasPkg.version = version;
aliasPkg.dependencies["dare-mcp-server"] = version;
writeFileSync(aliasPkgPath, `${JSON.stringify(aliasPkg, null, 2)}\n`);
console.log(`alias/dare-mcp synced to ${version}:\n  ${drift.join("\n  ")}`);
