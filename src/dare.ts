import { extname, resolve, sep } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { randomUUID } from "node:crypto";
import type { DareConfig } from "./config.js";
import type { DareRpcClient } from "./rpc.js";
import { DareError } from "./errors.js";
import { IMAGE_MODELS, VIDEO_MODELS, estimateImageCredits, estimateVideoCredits, type MediaKind } from "./catalog.js";

export interface CreateOutcome {
  /** "created" on success; "insufficient_credits" when the balance is too low. */
  outcome?: "created" | "insufficient_credits" | string;
  ids?: string[];
  requiredCredits?: number;
  creditBalance?: number;
}

export interface UploadResult {
  uploadId: string;
  storageKey: string;
  storageUrl: string;
  mediaType: MediaKind;
  name: string;
}

/** Statuses that mean the job is finished, one way or another. Anything else is still in flight. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "success",
  "failed",
  "failure",
  "error",
  "cancelled",
  "canceled",
  "rejected",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

function mediaKindFromMime(mime: string): MediaKind | null {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return null;
}

function isBlockedIPv4(v4: string): boolean {
  const [a, b] = v4.split(".").map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Expands an IPv6 address to eight 16-bit groups; null if unparseable. */
function expandIPv6(ip: string): number[] | null {
  let text = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  // Trailing dotted quad (::ffff:127.0.0.1) -> two hex groups.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [, head, a, b, c, d] = dotted;
    const hi = ((Number(a) << 8) | Number(b)).toString(16);
    const lo = ((Number(c) << 8) | Number(d)).toString(16);
    text = `${head}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedIPv4(ip);
  if (!isIPv6(ip)) return true; // not an address at all: refuse
  const g = expandIPv6(ip);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d, in dotted OR hex form) and IPv4-compatible (::a.b.c.d):
  // judge the embedded IPv4.
  const isMapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const isCompat = g.slice(0, 6).every((x) => x === 0) && (g[6] !== 0 || g[7] !== 0);
  if (isMapped || isCompat) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    return isBlockedIPv4(v4);
  }
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2002) return isBlockedIPv4(`${g[1]! >> 8}.${g[1]! & 0xff}.${g[2]! >> 8}.${g[2]! & 0xff}`); // 6to4
  if (first === 0x0064 && g[1] === 0xff9b) return isBlockedIPv4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`); // NAT64
  return false;
}

/**
 * Resolves a hostname, refuses anything in a private or special-use range, and returns the
 * vetted addresses so the connection can be pinned to them (closing the resolve-then-fetch
 * rebinding window).
 */
async function assertPublicHost(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local")) {
    throw new DareError(`Refusing to fetch ${hostname}: local hostname.`, {
      code: "DARE_UPLOAD_FORBIDDEN",
      hint: "Only public URLs can be uploaded.",
    });
  }
  let entries: Array<{ address: string; family: number }>;
  try {
    entries = isIPv4(bare) || isIPv6(bare) ? [{ address: bare, family: isIPv4(bare) ? 4 : 6 }] : await dnsLookup(bare, { all: true });
  } catch {
    throw new DareError(`Could not resolve ${hostname}.`, { code: "DARE_NETWORK", hint: "Check the URL." });
  }
  if (entries.length === 0 || entries.some((e) => isBlockedAddress(e.address))) {
    throw new DareError(`Refusing to fetch ${hostname}: resolves to a private or reserved address.`, {
      code: "DARE_UPLOAD_FORBIDDEN",
      hint: "Only public URLs can be uploaded.",
    });
  }
  return entries.map((e) => ({ address: e.address, family: e.family === 6 ? 6 : 4 }));
}

/** A fetch whose connections go only to addresses vetted by assertPublicHost. */
function pinnedFetch(url: URL, vetted: Array<{ address: string; family: 4 | 6 }>, signal: AbortSignal): Promise<Response> {
  const agent = new Agent({
    connect: {
      // Node calls lookup with {all:true} when autoSelectFamily is on and expects an array;
      // otherwise it expects (address, family). Serve both shapes from the vetted list.
      lookup: ((_hostname: string, opts: any, callback: any) => {
        if (opts && typeof opts === "object" && opts.all) {
          callback(null, vetted.map((v) => ({ address: v.address, family: v.family })));
        } else {
          const first = vetted[0]!;
          callback(null, first.address, first.family);
        }
      }) as any,
    },
  });
  // undici's fetch, not the global one, so the dispatcher is guaranteed to be honoured.
  return undiciFetch(url, { signal, redirect: "manual", dispatcher: agent }) as unknown as Promise<Response>;
}

/**
 * Dare's composer inserts an `@<storageKey>` mention into the prompt for every attached
 * asset (the stored `inputs.prompt` of real generations shows this). Append any that the
 * caller did not already place, so the server sees the same shape the web app sends.
 */
function withMentions(prompt: string, storageKeys: string[]): string {
  const missing = storageKeys.filter((key) => !prompt.includes(`@${key}`));
  if (missing.length === 0) return prompt;
  return `${prompt.trimEnd()} ${missing.map((key) => `@${key}`).join(" ")}`;
}

export interface ReferenceSummary {
  /** Seconds of video reference as Dare prices it (unknown lengths count as 30s). */
  pricedVideoSeconds: number;
  /** Seconds of video reference actually known, for limit checks. */
  knownVideoSeconds: number;
  /** Seconds of audio reference actually known, for limit checks. */
  knownAudioSeconds: number;
  countsByKind: Record<MediaKind, number>;
  /** Per-reference durations where known, for per-clip limits. */
  clipSeconds: Array<{ key: string; kind: MediaKind; seconds: number | null }>;
  /** Storage keys Dare reports as not found. */
  unresolved: string[];
}

export class DareService {
  constructor(
    private readonly rpc: DareRpcClient,
    private readonly config: DareConfig,
  ) {}

  /* ---------------- account ---------------- */

  async getCreditBalance(): Promise<unknown> {
    return this.rpc.call("credits.getBalance");
  }

  async getMediaInfo(storageKey: string): Promise<any> {
    return this.rpc.call("generations.getMediaInfo", { storageKey });
  }

  /**
   * Describes the attached references. A reference Dare cannot find is reported as
   * unresolved; any other failure (auth, network, server) is rethrown so the caller sees
   * the real cause rather than a misleading "check your storage keys".
   */
  private async summariseReferences(storageKeys: string[]): Promise<ReferenceSummary> {
    const summary: ReferenceSummary = {
      pricedVideoSeconds: 0,
      knownVideoSeconds: 0,
      knownAudioSeconds: 0,
      countsByKind: { image: 0, video: 0, audio: 0 },
      clipSeconds: [],
      unresolved: [],
    };
    if (storageKeys.length === 0) return summary;

    const infos = await Promise.all(
      storageKeys.map(async (key) => {
        try {
          return { key, info: await this.getMediaInfo(key) };
        } catch (err) {
          // Dare answers an unknown or unreadable storage key with NOT_FOUND or a 400
          // "couldn't read this file". Either way the reference is unusable; anything else
          // (auth, network, 5xx) is a real failure the caller must see.
          if (err instanceof DareError && (err.code === "DARE_NOT_FOUND" || (err.code === "DARE_BAD_REQUEST" && !err.issues))) {
            return { key, info: null };
          }
          throw err; // auth, network, 5xx, or a schema drift with field-level issues
        }
      }),
    );

    for (const { key, info } of infos) {
      const kind = (info?.mediaType ?? info?.kind) as MediaKind | undefined;
      if (!info || !kind || !(kind in summary.countsByKind)) {
        summary.unresolved.push(key);
        continue;
      }
      summary.countsByKind[kind] += 1;
      const raw = Number(info.durationSeconds);
      const seconds = Number.isFinite(raw) && raw > 0 ? raw : null;
      summary.clipSeconds.push({ key, kind, seconds });
      if (kind === "video") {
        summary.pricedVideoSeconds += seconds ?? 30; // Dare's estimator assumes 30s when unknown
        summary.knownVideoSeconds += seconds ?? 0;
      } else if (kind === "audio") {
        summary.knownAudioSeconds += seconds ?? 0;
      }
    }
    return summary;
  }

  /* ---------------- uploads ---------------- */

  private async assertReadableFile(filePath: string): Promise<string> {
    if (this.config.uploadRoots.length === 0) {
      throw new DareError("Local file uploads are disabled.", {
        code: "DARE_UPLOAD_FORBIDDEN",
        hint: "Set DARE_UPLOAD_ROOTS to a comma-separated list of directories this server may read from, or pass `url`/`base64` instead.",
      });
    }
    // Resolve symlinks on both sides: a lexical prefix check is defeated by a link inside
    // an allowed root that points at, say, the Claude config holding DARE_CLIENT_TOKEN.
    let real: string;
    try {
      real = await realpath(resolve(filePath));
    } catch {
      throw new DareError(`${filePath} does not exist or cannot be read.`, {
        code: "DARE_FILE_ERROR",
        hint: "Check the path.",
      });
    }
    const roots = await Promise.all(
      this.config.uploadRoots.map(async (root) => {
        try {
          return await realpath(resolve(root));
        } catch {
          return null;
        }
      }),
    );
    const allowed = roots.some(
      (base) => base !== null && (real === base || real.startsWith(base.endsWith(sep) ? base : base + sep)),
    );
    if (!allowed) {
      throw new DareError(`${real} is outside the permitted upload directories.`, {
        code: "DARE_UPLOAD_FORBIDDEN",
        hint: `Permitted roots: ${this.config.uploadRoots.join(", ")}. Move the file there or add its directory to DARE_UPLOAD_ROOTS.`,
      });
    }
    const info = await stat(real);
    if (!info.isFile()) {
      throw new DareError(`${real} is not a regular file.`, { code: "DARE_FILE_ERROR", hint: "Point at a media file." });
    }
    if (info.size > this.config.maxUploadBytes) {
      throw new DareError(`${real} is ${info.size} bytes, over the ${this.config.maxUploadBytes} byte limit.`, {
        code: "DARE_UPLOAD_TOO_LARGE",
        hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
      });
    }
    return real;
  }

  private async fetchRemote(url: string): Promise<{ bytes: Uint8Array; contentType?: string; name: string }> {
    if (!this.config.allowUrlUploads) {
      throw new DareError("URL uploads are disabled on this server.", {
        code: "DARE_UPLOAD_FORBIDDEN",
        hint: "Pass base64 bytes instead, or enable DARE_ALLOW_URL_UPLOADS on a trusted local deployment.",
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      // Follow redirects by hand so every hop is checked; a public URL that 302s to a
      // link-local metadata endpoint must not be fetched.
      let current = new URL(url);
      let response: Response | null = null;
      for (let hop = 0; hop < 5; hop++) {
        if (current.protocol !== "https:" && current.protocol !== "http:") {
          throw new DareError(`Unsupported URL scheme ${current.protocol}`, { code: "DARE_BAD_INPUT" });
        }
        const vetted = await assertPublicHost(current.hostname);
        const res = await pinnedFetch(current, vetted, controller.signal);
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) {
            throw new DareError(`${current} answered HTTP ${res.status} without a Location header.`, { code: "DARE_FETCH_ERROR" });
          }
          current = new URL(location, current);
          continue;
        }
        response = res;
        break;
      }
      if (!response) {
        throw new DareError(`Too many redirects fetching ${url}.`, { code: "DARE_FETCH_ERROR" });
      }
      if (!response.ok) {
        throw new DareError(`Could not download ${url} (HTTP ${response.status}).`, {
          code: "DARE_FETCH_ERROR",
          hint: "Check the URL is publicly reachable.",
        });
      }

      const limit = this.config.maxUploadBytes;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > limit) {
        throw new DareError(`${url} is ${declared} bytes, over the ${limit} byte limit.`, {
          code: "DARE_UPLOAD_TOO_LARGE",
          hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
        });
      }
      // Count bytes as they stream so a chunked response cannot exhaust memory first.
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) {
            await reader.cancel().catch(() => undefined);
            throw new DareError(`Download exceeded the ${limit} byte limit.`, {
              code: "DARE_UPLOAD_TOO_LARGE",
              hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
            });
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        bytes,
        contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || undefined,
        name: current.pathname.split("/").filter(Boolean).pop() || "upload",
      };
    } catch (err) {
      if (err instanceof DareError) throw err;
      if (controller.signal.aborted) {
        throw new DareError(`Download of ${url} timed out.`, { code: "DARE_TIMEOUT", hint: "Retry or use a faster host." });
      }
      throw new DareError(`Could not download ${url}: ${(err as Error).message}`, { code: "DARE_FETCH_ERROR" });
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadMedia(args: {
    source: { filePath?: string; url?: string; base64?: string };
    name?: string;
    contentType?: string;
    projectId?: string;
  }): Promise<UploadResult> {
    const { source } = args;
    let bytes: Uint8Array;
    let inferredName = args.name;
    let contentType = args.contentType;

    if (source.filePath) {
      const absolute = await this.assertReadableFile(source.filePath);
      const buffer = await readFile(absolute).catch((err) => {
        throw new DareError(`Could not read ${absolute}: ${(err as Error).message}`, {
          code: "DARE_FILE_ERROR",
          hint: "Check the file is readable.",
        });
      });
      bytes = new Uint8Array(buffer);
      inferredName ||= absolute.split(sep).filter(Boolean).pop() || "upload";
      contentType ||= MIME_BY_EXT[extname(absolute).slice(1).toLowerCase()];
    } else if (source.url) {
      const fetched = await this.fetchRemote(source.url);
      bytes = fetched.bytes;
      contentType ||= fetched.contentType;
      inferredName ||= fetched.name;
    } else if (source.base64) {
      const buffer = Buffer.from(source.base64, "base64");
      if (buffer.byteLength > this.config.maxUploadBytes) {
        throw new DareError(`Payload is ${buffer.byteLength} bytes, over the ${this.config.maxUploadBytes} byte limit.`, {
          code: "DARE_UPLOAD_TOO_LARGE",
          hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
        });
      }
      bytes = new Uint8Array(buffer);
      inferredName ||= "upload";
    } else {
      throw new DareError("No upload source given.", {
        code: "DARE_BAD_INPUT",
        hint: "Pass exactly one of file_path, url or base64.",
      });
    }

    // Fall back to the name's extension before giving up on the type.
    const nameExt = extname(inferredName ?? "").slice(1).toLowerCase();
    contentType ||= MIME_BY_EXT[nameExt];
    const mediaType = contentType ? mediaKindFromMime(contentType) : null;
    if (!contentType || !mediaType) {
      throw new DareError(`Could not determine the media type of "${inferredName}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Pass content_type explicitly, e.g. one of: ${Object.keys(EXT_BY_MIME).join(", ")}.`,
      });
    }
    const fileExtension = EXT_BY_MIME[contentType] || nameExt || "bin";

    // 1. Ask Dare for a signed PUT target.
    const signed = await this.rpc.call<{ storageKey?: string; storageUrl?: string; uploadUrl?: string }>(
      "storage.generateUploadUrl",
      { contentType, fileExtension },
    );
    if (!signed?.uploadUrl || !signed.storageKey) {
      throw new DareError("Dare did not return a usable upload URL.", {
        code: "DARE_BAD_RESPONSE",
        hint: "Retry; if it persists, the storage.generateUploadUrl contract has changed.",
      });
    }

    // 2. Upload the bytes straight to storage.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const put = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
        signal: controller.signal,
      });
      if (!put.ok) {
        throw new DareError(`Storage rejected the upload (HTTP ${put.status}).`, {
          code: "DARE_UPLOAD_FAILED",
          hint: "Retry; signed upload URLs are short-lived.",
        });
      }
    } catch (err) {
      if (err instanceof DareError) throw err;
      throw new DareError(
        controller.signal.aborted ? "Upload to storage timed out." : `Upload to storage failed: ${(err as Error).message}`,
        { code: "DARE_UPLOAD_FAILED", hint: "Retry." },
      );
    } finally {
      clearTimeout(timer);
    }

    // 3. Register the object as a Dare upload so it can be referenced.
    const created = await this.rpc.call<{ id?: string; assetId?: string; itemId?: string }>("uploads.create", {
      storageKey: signed.storageKey,
      name: inferredName,
      prompt: null,
      projectId: args.projectId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (!created?.id) {
      throw new DareError("Dare accepted the file but returned no upload id.", {
        code: "DARE_BAD_RESPONSE",
        hint: "Check dare_list_uploads — the file may still have registered.",
      });
    }

    return {
      uploadId: created.id,
      storageKey: signed.storageKey,
      storageUrl: signed.storageUrl ?? "",
      mediaType,
      name: inferredName ?? "upload",
    };
  }

  async listUploads(cursor?: string | null, limit = 50): Promise<unknown> {
    return this.rpc.call("uploads.list", { cursor: cursor ?? null, limit });
  }

  async deleteUpload(id: string): Promise<unknown> {
    return this.rpc.call("uploads.delete", { id });
  }

  /* ---------------- generations ---------------- */

  private enforceCostGuard(estimated: number, context: string): void {
    if (this.config.maxCreditsPerCall <= 0) return;
    if (!Number.isFinite(estimated)) {
      throw new DareError(`Could not estimate the cost of this ${context}, and a credit guard is active.`, {
        code: "DARE_COST_GUARD",
        hint: "Set DARE_MAX_CREDITS_PER_CALL=0 to proceed without an estimate, or use a model with a known price.",
      });
    }
    if (estimated > this.config.maxCreditsPerCall) {
      throw new DareError(
        `Estimated cost ${estimated.toFixed(2)} credits exceeds the DARE_MAX_CREDITS_PER_CALL guard of ${this.config.maxCreditsPerCall}.`,
        { code: "DARE_COST_GUARD", hint: "Lower duration, quality or count, or raise DARE_MAX_CREDITS_PER_CALL." },
      );
    }
  }

  /**
   * Builds the `generations.create` input.
   *
   * Dare's web client sends exactly these fields. The tool/model/prompt/rowCount values
   * it computes alongside them feed analytics and the optimistic UI only, and are never
   * transmitted — sending them here would just be rejected as unknown keys.
   */
  private createInput(spec: Record<string, unknown>, count: number, projectId?: string): Record<string, unknown> {
    return {
      spec,
      count,
      ...(projectId ? { projectId } : {}),
      metaEventId: `attempt_${randomUUID()}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async createVideo(args: {
    prompt: string;
    model: string;
    quality?: string;
    aspectRatio?: string;
    durationSeconds?: number;
    audioEnabled?: boolean;
    referenceStorageKeys?: string[];
    webLinkIds?: string[];
    count?: number;
    projectId?: string;
    /** Validate, price and build the spec, but do not submit. */
    dryRun?: boolean;
  }): Promise<CreateOutcome & { estimatedCredits: number; notes: string[]; spec: Record<string, unknown> }> {
    const spec = VIDEO_MODELS[args.model];
    if (!spec) {
      throw new DareError(`Unknown video model "${args.model}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Choose one of: ${Object.keys(VIDEO_MODELS).join(", ")}. Call dare_list_models for each model's limits.`,
      });
    }
    const bad = (message: string, hint: string): never => {
      throw new DareError(message, { code: "DARE_BAD_INPUT", hint });
    };
    const notes: string[] = [];

    /* ---- references ---- */
    const references = args.referenceStorageKeys ?? [];
    if (references.length > spec.maxReferences.total) {
      bad(
        spec.maxReferences.total === 0
          ? `${spec.name} does not accept reference media.`
          : `${spec.name} accepts at most ${spec.maxReferences.total} references; ${references.length} given.`,
        spec.maxReferences.total === 0 ? "Drop the references or choose a Seedance model." : "Drop some references and retry.",
      );
    }
    const refs = await this.summariseReferences(references);
    if (refs.unresolved.length > 0) {
      // Fail closed: an unknown reference could be a 30s clip that triples the bill.
      throw new DareError(
        `Dare does not recognise ${refs.unresolved.length} reference storage key(s): ${refs.unresolved.join(", ")}.`,
        {
          code: "DARE_REFERENCE_UNKNOWN",
          hint: "Use storage keys returned by dare_upload_media or listed by dare_list_uploads.",
        },
      );
    }
    for (const kind of ["image", "video", "audio"] as const) {
      const used = refs.countsByKind[kind];
      if (used === 0) continue;
      if (!spec.referenceKinds.includes(kind)) {
        bad(`${spec.name} does not accept ${kind} references.`, `Accepted kinds: ${spec.referenceKinds.join(", ") || "none"}.`);
      }
      const max = spec.maxReferences.perKind?.[kind];
      if (max !== undefined && used > max) {
        bad(`${spec.name} accepts at most ${max} ${kind} reference(s); ${used} given.`, `Reduce the number of ${kind} references.`);
      }
    }
    if (spec.audioRequiresVisual && refs.countsByKind.audio > 0 && refs.countsByKind.image + refs.countsByKind.video === 0) {
      bad(`${spec.name} needs an image or video reference alongside an audio reference.`, "Attach a visual reference too.");
    }
    if (spec.referenceClipSeconds) {
      const { min, max } = spec.referenceClipSeconds;
      const outOfRange = refs.clipSeconds.filter(
        (c) => c.kind !== "image" && c.seconds !== null && (c.seconds < min || c.seconds > max),
      );
      if (outOfRange.length > 0) {
        bad(
          `${spec.name} reference clips must be ${min}–${max}s long; ${outOfRange.map((c) => `${c.key} is ${c.seconds}s`).join(", ")}.`,
          "Trim the clip or choose a different reference.",
        );
      }
    }
    if (spec.combinedSecondsPerKind) {
      if (refs.knownVideoSeconds > spec.combinedSecondsPerKind) {
        bad(
          `${spec.name} accepts at most ${spec.combinedSecondsPerKind}s of combined video reference; ${refs.knownVideoSeconds}s given.`,
          "Trim or drop a reference clip.",
        );
      }
      if (refs.knownAudioSeconds > spec.combinedSecondsPerKind) {
        bad(
          `${spec.name} accepts at most ${spec.combinedSecondsPerKind}s of combined audio reference; ${refs.knownAudioSeconds}s given.`,
          "Trim or drop an audio reference.",
        );
      }
    }

    /* ---- per-model options, only where the model declares them ---- */
    const autoFromVideo = spec.autoDurationWithVideoReference && refs.countsByKind.video > 0;

    let quality: string | undefined;
    if (spec.qualities) {
      quality = args.quality ?? spec.defaults.quality;
      if (!quality || !spec.qualities.includes(quality)) {
        bad(`${spec.name} does not support quality "${quality}".`, `Supported qualities: ${spec.qualities.join(", ")}.`);
      }
    } else if (args.quality !== undefined) {
      notes.push(`${spec.name} has no quality setting; "${args.quality}" was ignored.`);
    }

    let aspectRatio: string | undefined;
    if (spec.aspectRatios) {
      aspectRatio = args.aspectRatio ?? spec.defaults.aspectRatio;
      if (!aspectRatio || !spec.aspectRatios.includes(aspectRatio)) {
        bad(`${spec.name} does not support aspect ratio "${aspectRatio}".`, `Supported aspect ratios: ${spec.aspectRatios.join(", ")}.`);
      }
    } else if (args.aspectRatio !== undefined) {
      notes.push(`${spec.name} has no aspect ratio setting; "${args.aspectRatio}" was ignored.`);
    }

    let durationSeconds: number | undefined;
    if (spec.durationsSeconds) {
      const allowed = references.length > 0 && spec.durationsWithReference ? spec.durationsWithReference : spec.durationsSeconds;
      durationSeconds = args.durationSeconds ?? (allowed.includes(spec.defaults.durationSeconds ?? -1) ? spec.defaults.durationSeconds : allowed[0]);
      if (durationSeconds === undefined || !allowed.includes(durationSeconds)) {
        bad(
          `${spec.name} does not support a ${durationSeconds}s duration${references.length > 0 && spec.durationsWithReference ? " with a reference attached" : ""}.`,
          `Supported durations (seconds): ${allowed.join(", ")}.`,
        );
      }
    } else if (args.durationSeconds !== undefined) {
      notes.push(`${spec.name} has a fixed length; duration ${args.durationSeconds}s was ignored.`);
    }

    if (autoFromVideo) {
      if (args.durationSeconds !== undefined || args.aspectRatio !== undefined) {
        notes.push(`A video reference is attached, so ${spec.name} derives duration and aspect ratio from it; the values you passed were ignored.`);
      }
      durationSeconds = undefined;
      aspectRatio = "auto";
    }

    /* ---- cost ---- */
    const count = args.count ?? 1;
    const perRow = estimateVideoCredits({
      model: args.model,
      quality,
      durationSeconds,
      audioEnabled: args.audioEnabled ?? true,
      referenceVideoSeconds: refs.pricedVideoSeconds,
      videoReferenceCount: refs.countsByKind.video,
    });
    const estimatedCredits = perRow * count;
    this.enforceCostGuard(estimatedCredits, "video generation");

    /* ---- spec, shaped exactly as Dare's composer shapes it ---- */
    const generationSpec: Record<string, unknown> = {
      tool: "create_video",
      prompt: withMentions(args.prompt, references),
      model: args.model,
    };
    if (spec.audioToggle) generationSpec.audioEnabled = args.audioEnabled ?? true;
    if (references.length > 0 || (args.webLinkIds?.length ?? 0) > 0) {
      generationSpec.context = { mediaStorageKeys: references, webLinkIds: args.webLinkIds ?? [] };
    }
    if (aspectRatio !== undefined) generationSpec.aspectRatio = aspectRatio;
    if (durationSeconds !== undefined) generationSpec.duration = `${durationSeconds}s`;
    if (quality !== undefined) generationSpec.quality = quality;

    if (args.dryRun) return { outcome: "dry_run", ids: [], estimatedCredits, notes, spec: generationSpec };
    const result = await this.rpc.call<CreateOutcome>("generations.create", this.createInput(generationSpec, count, args.projectId));
    return { ...result, estimatedCredits, notes, spec: generationSpec };
  }

  async createImage(args: {
    prompt: string;
    model: string;
    quality?: string;
    aspectRatio?: string;
    referenceStorageKeys?: string[];
    count?: number;
    projectId?: string;
    dryRun?: boolean;
  }): Promise<CreateOutcome & { estimatedCredits: number; notes: string[]; spec: Record<string, unknown> }> {
    const spec = IMAGE_MODELS[args.model];
    if (!spec) {
      throw new DareError(`Unknown image model "${args.model}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Choose one of: ${Object.keys(IMAGE_MODELS).join(", ")}.`,
      });
    }
    const bad = (message: string, hint: string): never => {
      throw new DareError(message, { code: "DARE_BAD_INPUT", hint });
    };
    const notes: string[] = [];

    let quality: string | undefined;
    if (spec.qualities) {
      quality = args.quality ?? spec.defaults.quality;
      if (!quality || !spec.qualities.includes(quality)) {
        bad(`${spec.name} does not support quality "${quality}".`, `Supported qualities: ${spec.qualities.join(", ")}.`);
      }
    } else if (args.quality !== undefined) {
      notes.push(`${spec.name} has no quality setting; "${args.quality}" was ignored.`);
    }
    const aspectRatio = args.aspectRatio ?? spec.defaults.aspectRatio;
    if (!spec.aspectRatios.includes(aspectRatio)) {
      bad(`${spec.name} does not support aspect ratio "${aspectRatio}".`, `Supported aspect ratios: ${spec.aspectRatios.join(", ")}.`);
    }

    const references = args.referenceStorageKeys ?? [];
    if (references.length > spec.maxReferences.total) {
      bad(`${spec.name} accepts at most ${spec.maxReferences.total} references; ${references.length} given.`, "Drop some references and retry.");
    }
    if (references.length > 0) {
      const refs = await this.summariseReferences(references);
      if (refs.unresolved.length > 0) {
        throw new DareError(`Dare does not recognise ${refs.unresolved.length} reference storage key(s): ${refs.unresolved.join(", ")}.`, {
          code: "DARE_REFERENCE_UNKNOWN",
          hint: "Use storage keys returned by dare_upload_media or listed by dare_list_uploads.",
        });
      }
      if (refs.countsByKind.video + refs.countsByKind.audio > 0) {
        bad(`${spec.name} accepts image references only.`, "Drop the video/audio references.");
      }
    }

    const count = args.count ?? 1;
    const estimatedCredits = estimateImageCredits(args.model, quality, aspectRatio, references.length) * count;
    this.enforceCostGuard(estimatedCredits, "image generation");

    const generationSpec: Record<string, unknown> = {
      tool: "create_image",
      prompt: withMentions(args.prompt, references),
      model: args.model,
    };
    if (references.length > 0) generationSpec.context = { mediaStorageKeys: references, webLinkIds: [] };
    generationSpec.aspectRatio = aspectRatio;
    if (quality !== undefined) generationSpec.quality = quality;

    if (args.dryRun) return { outcome: "dry_run", ids: [], estimatedCredits, notes, spec: generationSpec };
    const result = await this.rpc.call<CreateOutcome>("generations.create", this.createInput(generationSpec, count, args.projectId));
    return { ...result, estimatedCredits, notes, spec: generationSpec };
  }

  async getGeneration(id: string): Promise<any> {
    return this.rpc.call("generations.get", { id });
  }

  async cancelGeneration(id: string): Promise<unknown> {
    return this.rpc.call("generations.cancel", { id });
  }

  async deleteGeneration(id: string): Promise<unknown> {
    return this.rpc.call("generations.delete", { id });
  }

  async listLibrary(cursor?: string | null, limit = 25): Promise<unknown> {
    return this.rpc.call("libraryItems.list", { cursor: cursor ?? null, limit });
  }

  async listProjects(): Promise<unknown> {
    return this.rpc.call("projects.list");
  }

  /** Reads the status out of whatever shape Dare returns. */
  static statusOf(generation: any): string {
    const raw = generation?.status ?? generation?.generation?.status ?? generation?.state;
    return typeof raw === "string" ? raw.toLowerCase() : "";
  }

  /**
   * Polls until the generation reaches a known terminal status or the budget runs out.
   * Unknown statuses are treated as still-running, so a renamed in-progress state does
   * not get reported as finished.
   */
  async waitForGeneration(
    id: string,
    timeoutMs: number,
    intervalMs = 10_000,
  ): Promise<{ generation: any; status: string; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let last: any = await this.getGeneration(id);
    let status = DareService.statusOf(last);

    while (!TERMINAL_STATUSES.has(status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { generation: last, status: status || "unknown", timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
      last = await this.getGeneration(id);
      status = DareService.statusOf(last);
    }
    return { generation: last, status, timedOut: false };
  }
}
