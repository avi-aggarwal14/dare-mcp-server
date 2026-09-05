#!/usr/bin/env node
/**
 * `dare-mcp` is a thin alias for `dare-mcp-server`.
 *
 * It exists so both names resolve to the same working tool. All it does is hand
 * argv straight to the real CLI, in this same process — no extra spawn, no drift
 * in behaviour. The canonical package is pinned to an exact version in
 * package.json, so `dare-mcp@x.y.z` always runs `dare-mcp-server@x.y.z`.
 *
 * Everything real lives in https://github.com/avi-aggarwal14/dare-mcp-server
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

let cli;
try {
  cli = require.resolve("dare-mcp-server/dist/cli.js");
} catch {
  process.stderr.write(
    "dare-mcp: could not find its dependency `dare-mcp-server`.\n" +
      "Install it directly instead: npx dare-mcp-server setup\n",
  );
  process.exit(1);
}

await import(pathToFileURL(cli).href);
