import { extname, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import type { DareConfig } from "./config.js";
import type { DareRpcClient } from "./rpc.js";
import { DareError } from "./errors.js";
import { IMAGE_MODELS, VIDEO_MODELS, estimateImageCredits, estimateVideoCredits, type MediaKind } from "./catalog.js";

export interface CreateOutcome {
  outcome?: "insufficient_credits" | string;
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

function isBlockedAddress(ip: string): boolean {
  if (/^(127\.|10\.|169\.254\.|192\.168\.|0\.)/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export interface ReferenceSummary {
  /** Seconds of *video* reference material. */
  videoSeconds: number;
  countsByKind: Record<MediaKind, number>;
  /** Storage keys whose media info could not be read. */
  unresolved: string[];
}

export class DareService {
  constructor(
    private readonly rpc: DareRpcClient,
    private readonly config: DareConfig,
  ) {}

  /* ---------------- account ---------------- */

  async getCreditBalance(): Promise<unknown> {
    return this.rpc.call("credits.getBalance", {});
  }

  async getMediaInfo(storageKey: string): Promise<any> {
    return this.rpc.call("generations.getMediaInfo", { storageKey });
  }

  /**
   * Describes the attached references. Media info failures are reported rather than
   * swallowed, because the cost guard must fail closed: an unknown reference duration
   * can understate a Seedance 2.5 estimate several-fold.
   */
  private async summariseReferences(storageKeys: string[]): Promise<ReferenceSummary> {
    const summary: ReferenceSummary = {
      videoSeconds: 0,
      countsByKind: { image: 0, video: 0, audio: 0 },
      unresolved: [],
    };
    if (storageKeys.length === 0) return summary;

    const infos = await Promise.all(
      storageKeys.map(async (key) => {
        try {
          return { key, info: await this.getMediaInfo(key) };
        } catch {
          return { key, info: null };
        }
      }),
    );

    for (const { key, info } of infos) {
      if (!info) {
        summary.unresolved.push(key);
        continue;
      }
      const kind = (info.mediaType ?? info.kind) as MediaKind | undefined;
      if (kind && kind in summary.countsByKind) {
        summary.countsByKind[kind] += 1;
      } else {
        summary.unresolved.push(key);
        continue;
      }
      if (kind === "video") {
        const seconds = Number(info.durationSeconds ?? 0);
        if (Number.isFinite(seconds)) summary.videoSeconds += seconds;
      }
    }
    return summary;
  }

  /* ---------------- uploads ---------------- */

  private assertReadableFile(filePath: string): string {
    const absolute = resolve(filePath);
    if (this.config.uploadRoots.length === 0) {
      throw new DareError("Local file uploads are disabled.", {
        code: "DARE_UPLOAD_FORBIDDEN",
        hint: "Set DARE_UPLOAD_ROOTS to a comma-separated list of directories this server may read from, or pass `url`/`base64` instead.",
      });
    }
    const allowed = this.config.uploadRoots.some((root) => {
      const base = resolve(root);
      return absolute === base || absolute.startsWith(base.endsWith(sep) ? base : base + sep);
    });
    if (!allowed) {
      throw new DareError(`${absolute} is outside the permitted upload directories.`, {
        code: "DARE_UPLOAD_FORBIDDEN",
        hint: `Permitted roots: ${this.config.uploadRoots.join(", ")}. Move the file there or add its directory to DARE_UPLOAD_ROOTS.`,
      });
    }
    return absolute;
  }

  private async fetchRemote(url: string): Promise<{ bytes: Uint8Array; contentType?: string; name: string }> {
    if (!this.config.allowUrlUploads) {
      throw new DareError("URL uploads are disabled on this server.", {
        code: "DARE_UPLOAD_FORBIDDEN",
        hint: "Pass base64 bytes instead, or enable DARE_ALLOW_URL_UPLOADS on a trusted local deployment.",
      });
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new DareError(`Unsupported URL scheme ${parsed.protocol}`, { code: "DARE_BAD_INPUT" });
    }
    // Block SSRF into loopback / link-local / private ranges.
    try {
      const { address } = await dnsLookup(parsed.hostname);
      if (isBlockedAddress(address)) {
        throw new DareError(`Refusing to fetch ${parsed.hostname}: resolves to a private address.`, {
          code: "DARE_UPLOAD_FORBIDDEN",
          hint: "Only public URLs can be uploaded.",
        });
      }
    } catch (err) {
      if (err instanceof DareError) throw err;
      throw new DareError(`Could not resolve ${parsed.hostname}.`, { code: "DARE_NETWORK" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) {
        throw new DareError(`Could not download ${url} (HTTP ${res.status}).`, {
          code: "DARE_FETCH_ERROR",
          hint: "Check the URL is publicly reachable.",
        });
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > this.config.maxUploadBytes) {
        throw new DareError(`${url} is ${declared} bytes, over the ${this.config.maxUploadBytes} byte limit.`, {
          code: "DARE_UPLOAD_TOO_LARGE",
          hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
        });
      }
      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.byteLength > this.config.maxUploadBytes) {
        throw new DareError(`Downloaded ${buffer.byteLength} bytes, over the ${this.config.maxUploadBytes} byte limit.`, {
          code: "DARE_UPLOAD_TOO_LARGE",
          hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
        });
      }
      return {
        bytes: buffer,
        contentType: res.headers.get("content-type")?.split(";")[0]?.trim() || undefined,
        name: parsed.pathname.split("/").filter(Boolean).pop() || "upload",
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
      const absolute = this.assertReadableFile(source.filePath);
      const buffer = await readFile(absolute).catch((err) => {
        throw new DareError(`Could not read ${absolute}: ${(err as Error).message}`, {
          code: "DARE_FILE_ERROR",
          hint: "Check the path exists and is readable.",
        });
      });
      if (buffer.byteLength > this.config.maxUploadBytes) {
        throw new DareError(`${absolute} is ${buffer.byteLength} bytes, over the ${this.config.maxUploadBytes} byte limit.`, {
          code: "DARE_UPLOAD_TOO_LARGE",
          hint: "Shrink the file or raise DARE_MAX_UPLOAD_BYTES.",
        });
      }
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
        hint: "Unset DARE_MAX_CREDITS_PER_CALL to proceed without an estimate, or use a model with a known price.",
      });
    }
    if (estimated > this.config.maxCreditsPerCall) {
      throw new DareError(
        `Estimated cost ${estimated.toFixed(2)} credits exceeds the DARE_MAX_CREDITS_PER_CALL guard of ${this.config.maxCreditsPerCall}.`,
        { code: "DARE_COST_GUARD", hint: "Lower duration, quality or count, or raise DARE_MAX_CREDITS_PER_CALL." },
      );
    }
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
  }): Promise<CreateOutcome & { estimatedCredits: number; notes: string[] }> {
    const spec = VIDEO_MODELS[args.model];
    if (!spec) {
      throw new DareError(`Unknown video model "${args.model}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Choose one of: ${Object.keys(VIDEO_MODELS).join(", ")}. Call dare_list_models for each model's limits.`,
      });
    }

    const quality = args.quality ?? spec.defaults.quality;
    if (!spec.qualities.includes(quality)) {
      throw new DareError(`${spec.name} does not support quality "${quality}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Supported qualities: ${spec.qualities.join(", ")}.`,
      });
    }

    const aspectRatio = args.aspectRatio ?? spec.defaults.aspectRatio;
    if (!spec.aspectRatios.includes(aspectRatio)) {
      throw new DareError(`${spec.name} does not support aspect ratio "${aspectRatio}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Supported aspect ratios: ${spec.aspectRatios.join(", ")}.`,
      });
    }

    const references = args.referenceStorageKeys ?? [];
    if (references.length > spec.maxReferences.total) {
      throw new DareError(
        `${spec.name} accepts at most ${spec.maxReferences.total} references; ${references.length} given.`,
        { code: "DARE_BAD_INPUT", hint: "Drop some references and retry." },
      );
    }

    const notes: string[] = [];
    const refs = await this.summariseReferences(references);

    if (refs.unresolved.length > 0) {
      // Fail closed: an unknown reference could be a 30s clip that triples the bill.
      throw new DareError(
        `Could not read media info for ${refs.unresolved.length} reference(s): ${refs.unresolved.join(", ")}.`,
        {
          code: "DARE_REFERENCE_UNKNOWN",
          hint: "Confirm the storage keys came from dare_upload_media or dare_list_uploads, then retry. Cost cannot be estimated safely without them.",
        },
      );
    }

    for (const [kind, max] of Object.entries(spec.maxReferences.perKind ?? {})) {
      const used = refs.countsByKind[kind as MediaKind];
      if (max !== undefined && used > max) {
        throw new DareError(`${spec.name} accepts at most ${max} ${kind} reference(s); ${used} given.`, {
          code: "DARE_BAD_INPUT",
          hint: `Reduce the number of ${kind} references.`,
        });
      }
    }
    if (spec.combinedSecondsPerKind && refs.videoSeconds > spec.combinedSecondsPerKind) {
      throw new DareError(
        `${spec.name} accepts at most ${spec.combinedSecondsPerKind}s of combined video reference; ${refs.videoSeconds}s given.`,
        { code: "DARE_BAD_INPUT", hint: "Trim or drop a reference clip." },
      );
    }

    // Only a *video* reference drives duration and aspect ratio automatically.
    const autoFromVideo = spec.autoDurationWithVideoReference && refs.countsByKind.video > 0;

    let durationSeconds = args.durationSeconds ?? spec.defaults.durationSeconds;
    if (!autoFromVideo && durationSeconds !== undefined && !spec.durationsSeconds.includes(durationSeconds)) {
      throw new DareError(`${spec.name} does not support a ${durationSeconds}s duration.`, {
        code: "DARE_BAD_INPUT",
        hint: `Supported durations (seconds): ${spec.durationsSeconds.join(", ")}.`,
      });
    }
    if (autoFromVideo) {
      if (args.durationSeconds !== undefined || args.aspectRatio !== undefined) {
        notes.push(
          `A video reference is attached, so ${spec.name} derives duration and aspect ratio from it; the values you passed were ignored.`,
        );
      }
      durationSeconds = undefined;
    }

    const count = args.count ?? 1;
    const perRow = estimateVideoCredits({
      model: args.model,
      quality,
      durationSeconds,
      audioEnabled: args.audioEnabled ?? true,
      referenceVideoSeconds: refs.videoSeconds,
      referenceCount: references.length,
    });
    const estimatedCredits = perRow * count;
    this.enforceCostGuard(estimatedCredits, "video generation");

    const generationSpec: Record<string, unknown> = {
      tool: "create_video",
      prompt: args.prompt,
      model: args.model,
      aspectRatio: autoFromVideo ? "auto" : aspectRatio,
      quality,
    };
    if (spec.audioToggle) generationSpec.audioEnabled = args.audioEnabled ?? true;
    if (durationSeconds !== undefined) generationSpec.duration = `${durationSeconds}s`;
    if (references.length > 0 || (args.webLinkIds?.length ?? 0) > 0) {
      generationSpec.context = { mediaStorageKeys: references, webLinkIds: args.webLinkIds ?? [] };
    }

    const result = await this.rpc.call<CreateOutcome>("generations.create", {
      tool: "create_video",
      kind: "video",
      model: args.model,
      prompt: args.prompt,
      pendingPrompt: args.prompt.replace(/@\S+/gu, "").replace(/[^\S\n]{2,}/gu, " ").trim() || null,
      rowCount: count,
      spec: generationSpec,
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });

    return { ...result, estimatedCredits, notes };
  }

  async createImage(args: {
    prompt: string;
    model: string;
    quality?: string;
    aspectRatio?: string;
    referenceStorageKeys?: string[];
    count?: number;
    projectId?: string;
  }): Promise<CreateOutcome & { estimatedCredits: number; notes: string[] }> {
    const spec = IMAGE_MODELS[args.model];
    if (!spec) {
      throw new DareError(`Unknown image model "${args.model}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Choose one of: ${Object.keys(IMAGE_MODELS).join(", ")}.`,
      });
    }
    const quality = args.quality ?? spec.defaults.quality;
    if (!spec.qualities.includes(quality)) {
      throw new DareError(`${spec.name} does not support quality "${quality}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Supported qualities: ${spec.qualities.join(", ")}.`,
      });
    }
    const aspectRatio = args.aspectRatio ?? spec.defaults.aspectRatio;
    if (!spec.aspectRatios.includes(aspectRatio)) {
      throw new DareError(`${spec.name} does not support aspect ratio "${aspectRatio}".`, {
        code: "DARE_BAD_INPUT",
        hint: `Supported aspect ratios: ${spec.aspectRatios.join(", ")}.`,
      });
    }
    const references = args.referenceStorageKeys ?? [];
    if (references.length > spec.maxReferences.total) {
      throw new DareError(`${spec.name} accepts at most ${spec.maxReferences.total} references; ${references.length} given.`, {
        code: "DARE_BAD_INPUT",
        hint: "Drop some references and retry.",
      });
    }

    const count = args.count ?? 1;
    const estimatedCredits = estimateImageCredits(args.model, quality, aspectRatio, references.length) * count;
    this.enforceCostGuard(estimatedCredits, "image generation");

    const generationSpec: Record<string, unknown> = {
      tool: "create_image",
      prompt: args.prompt,
      model: args.model,
      aspectRatio,
      quality,
    };
    if (references.length > 0) {
      generationSpec.context = { mediaStorageKeys: references, webLinkIds: [] };
    }

    const result = await this.rpc.call<CreateOutcome>("generations.create", {
      tool: "create_image",
      kind: "image",
      model: args.model,
      prompt: args.prompt,
      pendingPrompt: args.prompt.replace(/@\S+/gu, "").replace(/[^\S\n]{2,}/gu, " ").trim() || null,
      rowCount: count,
      spec: generationSpec,
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });

    return { ...result, estimatedCredits, notes: [] };
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
    return this.rpc.call("projects.list", {});
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
    intervalMs = 5_000,
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
