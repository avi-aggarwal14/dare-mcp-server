#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";

/**
 * Stateless streamable-HTTP transport, for hosting the server behind a URL.
 *
 * Claude Code and the Claude desktop app both use the stdio entrypoint; this exists
 * for remote deployments. It is deliberately locked down: the tools here can spend
 * real credits, so anonymous access is refused rather than merely warned about.
 */

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_HOSTS = (process.env.DARE_ALLOWED_HOSTS ?? `127.0.0.1:${PORT},localhost:${PORT}`)
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = (process.env.DARE_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const BEARER = process.env.DARE_MCP_BEARER_TOKEN?.trim();

if (!BEARER) {
  process.stderr.write(
    "Refusing to start: DARE_MCP_BEARER_TOKEN is required for the HTTP transport.\n" +
      "These tools spend real Dare credits, so anonymous access is not allowed.\n" +
      "Generate one with:  openssl rand -hex 32\n",
  );
  process.exit(1);
}
if (BEARER.length < 24) {
  process.stderr.write("Refusing to start: DARE_MCP_BEARER_TOKEN must be at least 24 characters.\n");
  process.exit(1);
}

/**
 * Local file reads and URL fetches are disabled over HTTP: a remote caller could
 * otherwise ask the server to upload its own environment or config — which holds
 * DARE_CLIENT_TOKEN — and read it back from the returned storage URL.
 */
const config = loadConfig({ uploadRoots: [], allowUrlUploads: false });

const app = express();
app.disable("x-powered-by");

function bearerOk(header: unknown): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(BEARER!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
});

// Authenticate before parsing a body, so unauthenticated callers cannot make the
// process buffer megabytes of JSON.
app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  if (!bearerOk(req.headers.authorization)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
      id: null,
    });
    return;
  }
  next();
});
app.use("/mcp", express.json({ limit: "16mb" }));

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableDnsRebindingProtection: true,
    allowedHosts: ALLOWED_HOSTS,
    ...(ALLOWED_ORIGINS.length ? { allowedOrigins: ALLOWED_ORIGINS } : {}),
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(`request failed: ${(err as Error).stack}\n`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless; use POST /mcp." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, HOST, () => {
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${HOST}:${PORT}/mcp\n`);
  process.stderr.write(`DNS-rebinding protection on; allowed hosts: ${ALLOWED_HOSTS.join(", ")}\n`);
});
