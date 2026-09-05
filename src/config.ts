/**
 * Runtime configuration.
 *
 * Sources, highest precedence first:
 *   1. explicit overrides passed to `loadConfig`
 *   2. environment variables
 *   3. `~/.dare-mcp/config.json`, written by `dare-mcp-server setup`
 */
import { readStoredConfig } from "./store.js";

export interface DareConfig {
  /** Long-lived Clerk `__client` JWT copied from a signed-in trydare.com browser session. */
  clientToken?: string;
  /** Optional short-lived Clerk session JWT. Bypasses minting. Expires in ~60s. */
  sessionToken?: string;
  /** Optional explicit Clerk session id (sess_...). Auto-detected when omitted. */
  sessionId?: string;
  serverUrl: string;
  clerkFapiUrl: string;
  webUrl: string;
  clerkApiVersion: string;
  clerkJsVersion: string;
  /**
   * Hard ceiling on credits a single generation call may cost. Defaults to 500, which
   * admits any single Seedance 2.5 clip (max 320) while blocking runaway batches.
   * Set to 0 to disable.
   */
  maxCreditsPerCall: number;
  requestTimeoutMs: number;
  /**
   * Directories `dare_upload_media` may read local files from. Empty means local file
   * reads are refused. Remote (HTTP) deployments should always leave this empty.
   */
  uploadRoots: string[];
  /** Allow `dare_upload_media` to fetch arbitrary URLs. Disabled on the HTTP transport. */
  allowUrlUploads: boolean;
  /** Largest upload accepted, in bytes. */
  maxUploadBytes: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<DareConfig> = {}): DareConfig {
  const stored = readStoredConfig();
  return {
    clientToken: process.env.DARE_CLIENT_TOKEN?.trim() || stored.clientToken?.trim() || undefined,
    sessionToken: process.env.DARE_SESSION_TOKEN?.trim() || undefined,
    sessionId: process.env.DARE_SESSION_ID?.trim() || undefined,
    serverUrl: (process.env.DARE_SERVER_URL || "https://api.trydare.com").replace(/\/+$/, ""),
    clerkFapiUrl: (process.env.DARE_CLERK_FAPI_URL || "https://clerk.trydare.com").replace(/\/+$/, ""),
    webUrl: (process.env.DARE_WEB_URL || "https://trydare.com").replace(/\/+$/, ""),
    clerkApiVersion: process.env.DARE_CLERK_API_VERSION || "2025-04-10",
    clerkJsVersion: process.env.DARE_CLERK_JS_VERSION || "5.99.0",
    maxCreditsPerCall: num("DARE_MAX_CREDITS_PER_CALL", stored.maxCreditsPerCall ?? 500),
    requestTimeoutMs: num("DARE_REQUEST_TIMEOUT_MS", 120_000),
    uploadRoots: process.env.DARE_UPLOAD_ROOTS ? list("DARE_UPLOAD_ROOTS") : (stored.uploadRoots ?? []),
    allowUrlUploads: bool("DARE_ALLOW_URL_UPLOADS", true),
    maxUploadBytes: num("DARE_MAX_UPLOAD_BYTES", 512 * 1024 * 1024),
    ...overrides,
  };
}
