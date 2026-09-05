#!/usr/bin/env node
/**
 * Single entry point for the package.
 *
 *   dare-mcp-server            run the MCP server over stdio (what Claude launches)
 *   dare-mcp-server setup      interactive first-run wizard
 *   dare-mcp-server check      verify credentials and print the credit balance
 *   dare-mcp-server http       run the optional remote HTTP transport
 *   dare-mcp-server --version  print the version
 */
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION}

  MCP server for Dare (trydare.com) video and image generation.

Usage
  npx dare-mcp-server setup     Connect your Dare account and add it to Claude
  npx dare-mcp-server check     Verify your credentials and show your credit balance
  npx dare-mcp-server           Start the MCP server on stdio (Claude runs this for you)
  npx dare-mcp-server http      Start the optional HTTP transport for self-hosting

Options
  -h, --help        Show this help
  -v, --version     Show the version

Docs: https://github.com/avi-aggarwal14/dare-mcp-server
`;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  switch (command) {
    case "setup": {
      const { runSetup } = await import("./setup.js");
      process.exit(await runSetup());
      break;
    }
    case "check":
    case "doctor": {
      await import("./check.js");
      break;
    }
    case "http":
    case "serve:http": {
      await import("./http.js");
      break;
    }
    case "-v":
    case "--version":
    case "version": {
      console.log(SERVER_VERSION);
      break;
    }
    case "-h":
    case "--help":
    case "help": {
      console.log(HELP);
      break;
    }
    case undefined:
    case "stdio":
    case "serve": {
      await import("./stdio.js");
      break;
    }
    default: {
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
