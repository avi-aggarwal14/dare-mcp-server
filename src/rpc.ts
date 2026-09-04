import type { ClerkTokenProvider } from "./auth.js";
import type { DareConfig } from "./config.js";
import { DareError, authError } from "./errors.js";

/**
 * Procedures that are safe to replay after an auth refresh. Anything that can
 * spend credits or mutate state is deliberately absent: Dare's create endpoint
 * has no idempotency key, so a blind retry can bill the account twice.
 */
const REPLAYABLE = new Set([
  "credits.getBalance",
  "billing.getSubscriptionStatus",
  "generations.get",
  "generations.getMediaInfo",
  "libraryItems.list",
  "uploads.list",
  "projects.list",
  "storage.generateUploadUrl",
]);

/**
 * Minimal oRPC client for Dare's RPC handler.
 *
 * Dare speaks the oRPC "RPC" protocol: POST {base}/rpc/{a}/{b} with a
 * `{ json, meta }` envelope in and out. `meta` describes non-JSON types
 * (Date, BigInt, Set, ...) by path; our inputs are plain JSON, so we send `[]`.
 */
export class DareRpcClient {
  constructor(
    private readonly config: DareConfig,
    private readonly auth: ClerkTokenProvider,
  ) {}

  async call<T = unknown>(procedure: string, input: unknown = {}, opts: { retryOnAuth?: boolean } = {}): Promise<T> {
    const mayRetry = (opts.retryOnAuth ?? true) && REPLAYABLE.has(procedure) && this.auth.canRefresh();
    const path = procedure.replace(/\./g, "/");
    const token = await this.auth.getToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.config.serverUrl}/rpc/${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          Origin: this.config.webUrl,
          Referer: `${this.config.webUrl}/`,
        },
        body: JSON.stringify({ json: input, meta: [] }),
      });
      // Read the body inside the abort window; a stalled body must not hang forever.
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new DareError(`Dare RPC ${procedure} timed out after ${this.config.requestTimeoutMs}ms.`, {
          code: "DARE_TIMEOUT",
          hint: "Retry, or raise DARE_REQUEST_TIMEOUT_MS. Generation is asynchronous — poll dare_get_generation rather than holding one long call open.",
        });
      }
      throw new DareError(`Could not reach Dare at ${this.config.serverUrl}: ${(err as Error).message}`, {
        code: "DARE_NETWORK",
        hint: "Check network access to api.trydare.com.",
      });
    } finally {
      clearTimeout(timer);
    }

    let envelope: any = null;
    let parsed = true;
    try {
      envelope = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
    }
    const payload = parsed && envelope && typeof envelope === "object" && "json" in envelope ? envelope.json : envelope;

    if (!response.ok) {
      // Status handling must come first: gateways and CDNs return HTML error pages.
      const code = parsed ? (payload?.code ?? "DARE_RPC_ERROR") : "DARE_RPC_ERROR";
      const message = parsed ? (payload?.message ?? `HTTP ${response.status}`) : `HTTP ${response.status}`;

      if (response.status === 401 || response.status === 403 || code === "UNAUTHORIZED") {
        this.auth.invalidate();
        if (mayRetry) {
          return this.call<T>(procedure, input, { retryOnAuth: false });
        }
        throw authError(
          `Dare rejected the request to ${procedure}: ${message}` +
            (REPLAYABLE.has(procedure) ? "" : " (not retried automatically — this call can spend credits)"),
        );
      }
      if (response.status === 404) {
        throw new DareError(`Dare has no procedure named ${procedure}.`, {
          code: "DARE_UNKNOWN_PROCEDURE",
          status: 404,
          hint: "Dare's internal API is undocumented and may have changed. The procedure names live in src/dare.ts; compare against a fresh capture from the Dare web app's network tab.",
        });
      }
      if (response.status === 429) {
        throw new DareError(`Dare rate-limited the request to ${procedure}.`, {
          code: "DARE_RATE_LIMITED",
          status: 429,
          hint: "Wait a few seconds and retry.",
        });
      }
      if (response.status >= 500) {
        throw new DareError(`Dare returned a server error for ${procedure} (HTTP ${response.status}).`, {
          code: "DARE_SERVER_ERROR",
          status: response.status,
          hint: "Transient on Dare's side. Retry shortly.",
        });
      }
      throw new DareError(`Dare RPC ${procedure} failed: ${message}`, {
        code: typeof code === "string" ? code : "DARE_RPC_ERROR",
        status: response.status,
      });
    }

    if (!parsed) {
      throw new DareError(`Dare returned a non-JSON success response for ${procedure}.`, {
        code: "DARE_BAD_RESPONSE",
        status: response.status,
        hint: "The private RPC contract may have changed. Re-check the procedure name against the Dare web app.",
      });
    }
    return payload as T;
  }
}
