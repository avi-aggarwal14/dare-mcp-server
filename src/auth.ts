import type { DareConfig } from "./config.js";
import { DareError, authError } from "./errors.js";

interface ClerkSession {
  id: string;
  status: string;
  last_active_at?: number;
  expire_at?: number;
}

interface CachedToken {
  jwt: string;
  expiresAtMs: number;
}

/**
 * Mints short-lived Clerk session JWTs for api.trydare.com from a long-lived `__client` cookie.
 *
 * Dare's web app authenticates every RPC call with `Authorization: Bearer <clerk session jwt>`.
 * Those JWTs live for ~60 seconds, so a headless client has to mint them on demand the same way
 * clerk-js does: read the client record from the Clerk Frontend API, pick the active session,
 * then POST to that session's `/tokens` endpoint.
 */
export class ClerkTokenProvider {
  private cached: CachedToken | null = null;
  private resolvedSessionId: string | null = null;
  private inFlight: Promise<string> | null = null;
  private generation = 0;

  constructor(private readonly config: DareConfig) {
    this.resolvedSessionId = config.sessionId ?? null;
  }

  /** True when the server has some credential to work with. */
  hasCredentials(): boolean {
    return Boolean(this.config.clientToken || this.config.sessionToken);
  }

  private fapiUrl(path: string): string {
    const url = new URL(`${this.config.clerkFapiUrl}${path}`);
    url.searchParams.set("__clerk_api_version", this.config.clerkApiVersion);
    url.searchParams.set("_clerk_js_version", this.config.clerkJsVersion);
    return url.toString();
  }

  private async fapiFetch(path: string, init: RequestInit = {}): Promise<any> {
    if (!this.config.clientToken) {
      throw authError("No DARE_CLIENT_TOKEN configured.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(this.fapiUrl(path), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Origin: this.config.webUrl,
          Referer: `${this.config.webUrl}/`,
          Cookie: `__client=${this.config.clientToken}`,
          Authorization: `Bearer ${this.config.clientToken}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new DareError(`Clerk request to ${path} timed out.`, {
          code: "DARE_TIMEOUT",
          hint: "Retry, or raise DARE_REQUEST_TIMEOUT_MS.",
        });
      }
      throw new DareError(`Could not reach Clerk at ${this.config.clerkFapiUrl}: ${(err as Error).message}`, {
        code: "DARE_NETWORK",
        hint: "Check network access to clerk.trydare.com.",
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new DareError(`Clerk response body for ${path} could not be read: ${(err as Error).message}`, {
        code: "DARE_NETWORK",
        hint: "Retry.",
      });
    } finally {
      clearTimeout(timer);
    }

    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body handled below */
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw authError(`Clerk rejected the client token (HTTP ${response.status}).`);
      }
      const detail = body?.errors?.[0]?.long_message ?? body?.errors?.[0]?.message ?? text.slice(0, 300);
      throw new DareError(`Clerk request to ${path} failed (HTTP ${response.status}): ${detail}`, {
        code: "DARE_CLERK_ERROR",
        status: response.status,
      });
    }
    return body;
  }

  private async resolveSessionId(): Promise<string> {
    if (this.resolvedSessionId) return this.resolvedSessionId;

    const body = await this.fapiFetch("/v1/client");
    const client = body?.response ?? body?.client ?? body;
    const sessions: ClerkSession[] = client?.sessions ?? [];

    if (sessions.length === 0) {
      throw authError("The Clerk client token carries no active sessions.");
    }
    const active =
      sessions.find((s) => s.id === client?.last_active_session_id) ??
      sessions.find((s) => s.status === "active") ??
      sessions[0];

    if (!active?.id) {
      throw authError("Could not identify an active Dare session on the client token.");
    }
    this.resolvedSessionId = active.id;
    return active.id;
  }

  /** Returns a session JWT valid for the next few seconds, minting one if needed. */
  async getToken(): Promise<string> {
    if (this.config.sessionToken) return this.config.sessionToken;

    if (!this.config.clientToken) {
      throw authError("Dare credentials are not configured.");
    }
    if (this.cached && this.cached.expiresAtMs > Date.now()) {
      return this.cached.jwt;
    }
    if (this.inFlight) return this.inFlight;

    // Tagged so a concurrent invalidate() can tell "my mint" from "a newer mint".
    const generation = ++this.generation;
    const pending = (async () => {
      const sessionId = await this.resolveSessionId();
      const body = await this.fapiFetch(`/v1/client/sessions/${sessionId}/tokens`, { method: "POST" });
      const jwt: string | undefined = body?.jwt ?? body?.response?.jwt;
      if (typeof jwt !== "string" || jwt.length === 0) {
        throw authError("Clerk returned no session JWT.");
      }
      // Only cache if no invalidate() landed while this mint was in flight.
      if (generation === this.generation) {
        // Clerk session tokens live ~60s; refresh at 45s to stay clear of the edge.
        this.cached = { jwt, expiresAtMs: Date.now() + 45_000 };
      }
      return jwt;
    })();

    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  /** True when invalidate() can actually produce a different token next time. */
  canRefresh(): boolean {
    return !this.config.sessionToken && Boolean(this.config.clientToken);
  }

  /** Drops caches so the next call re-resolves the session and mints a fresh token. */
  invalidate(): void {
    this.generation++;
    this.cached = null;
    this.inFlight = null;
    if (!this.config.sessionId) this.resolvedSessionId = null;
  }
}
