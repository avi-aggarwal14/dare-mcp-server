#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.clientToken && !config.sessionToken) {
    // stderr only: stdout is the JSON-RPC channel.
    process.stderr.write(
      `${SERVER_NAME}: DARE_CLIENT_TOKEN is not set. Tools will start but every Dare call will fail with ` +
        `DARE_UNAUTHORIZED until it is. See the README for how to copy the __client cookie.\n`,
    );
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`${SERVER_NAME} failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
