import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, type DareConfig } from "./config.js";
import { ClerkTokenProvider } from "./auth.js";
import { DareRpcClient } from "./rpc.js";
import { DareService } from "./dare.js";
import { DareError } from "./errors.js";
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  VIDEO_MODELS,
  VIDEO_MODEL_IDS,
  estimateImageCredits,
  estimateVideoCredits,
} from "./catalog.js";

export const SERVER_NAME = "dare-mcp-server";
export const SERVER_VERSION = "0.1.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(structured: Record<string, unknown>, summary?: string): ToolResult {
  return {
    content: [{ type: "text", text: summary ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(err: unknown): ToolResult {
  let message: string;
  if (err instanceof DareError) {
    message = err.toAgentMessage();
  } else {
    const detail = err instanceof Error && err.message ? err.message : String(err);
    message = `[DARE_UNEXPECTED] ${detail}`;
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(
  fn: () => Promise<{ structured: Record<string, unknown>; summary?: string }>,
): Promise<ToolResult> {
  try {
    const { structured, summary } = await fn();
    return ok(structured, summary);
  } catch (err) {
    return fail(err);
  }
}

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("`markdown` for a readable summary, `json` for the raw payload.");

function render(format: "markdown" | "json", markdown: string, data: unknown): string {
  return format === "json" ? JSON.stringify(data, null, 2) : markdown;
}

/** Renders "4-30s" only when the set really is contiguous, otherwise lists the values. */
function formatDurations(values: number[]): string {
  const contiguous = values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
  return contiguous && values.length > 2
    ? `${values[0]}-${values[values.length - 1]}s (any whole second)`
    : `${values.join(", ")}s`;
}

/** Pulls the finished asset URL out of whatever shape Dare returns. */
function outputUrlOf(generation: any): string | null {
  const asset =
    generation?.outputAsset ?? generation?.asset ?? generation?.generation?.outputAsset ?? generation?.output?.asset;
  return asset?.storageUrl ?? asset?.url ?? generation?.outputUrl ?? null;
}

/**
 * Waits for a generation without ever losing the ids on failure. Credits are already
 * spent by the time this runs, so a polling error must never mask the id the caller
 * needs in order to poll or cancel.
 */
async function settleWait(
  dare: DareService,
  id: string | undefined,
  waitSeconds: number,
  intervalMs: number,
): Promise<{ status?: string; timed_out?: boolean; output_url?: string | null; wait_error?: string; result?: unknown }> {
  if (waitSeconds <= 0 || !id) return {};
  try {
    const { generation, status, timedOut } = await dare.waitForGeneration(id, waitSeconds * 1000, intervalMs);
    return { status, timed_out: timedOut, output_url: outputUrlOf(generation), result: generation };
  } catch (err) {
    const detail = err instanceof DareError ? err.toAgentMessage() : String((err as Error)?.message ?? err);
    return { wait_error: detail };
  }
}

export function createServer(config: DareConfig = loadConfig()): McpServer {
  const auth = new ClerkTokenProvider(config);
  const rpc = new DareRpcClient(config, auth);
  const dare = new DareService(rpc, config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Generate video and images on Dare (trydare.com), billed to the signed-in user's Dare credit balance. " +
        "Seedance 2.5 is the default video model. Generation is asynchronous and SPENDS CREDITS: call " +
        "dare_estimate_cost first when cost matters, and confirm with the user before large batches. " +
        "To use reference images or clips, upload them with dare_upload_media and pass the returned storage_key. " +
        "Poll dare_get_generation for results, or set wait_seconds on the create tools.",
    },
  );

  /* ------------------------------------------------------------------ *
   * Discovery
   * ------------------------------------------------------------------ */

  server.registerTool(
    "dare_list_models",
    {
      title: "List Dare models",
      description:
        "List the video and image models available on Dare with their supported durations, aspect ratios, " +
        "quality tiers and reference limits. Call this before generating so parameters are valid for the chosen " +
        "model, and dare_estimate_cost for prices. Makes no network request and spends no credits.",
      inputSchema: {
        kind: z.enum(["video", "image", "all"]).default("all").describe("Which model family to list."),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ kind, response_format }) =>
      guard(async () => {
        const video = kind === "image" ? [] : Object.values(VIDEO_MODELS);
        const image = kind === "video" ? [] : Object.values(IMAGE_MODELS);
        const structured = { video_models: video, image_models: image };

        const lines: string[] = [];
        if (video.length) {
          lines.push("## Video models");
          for (const m of video) {
            lines.push(
              `- **${m.name}** (\`${m.id}\`) — ${m.description}`,
              `  - durations: ${m.durationsSeconds ? formatDurations(m.durationsSeconds) : "fixed by the model"}` +
                (m.durationsWithReference ? ` (${m.durationsWithReference.join("/")}s when a reference is attached)` : ""),
              `  - qualities: ${m.qualities?.join(", ") ?? "none"} | aspect ratios: ${m.aspectRatios?.join(", ") ?? "none"}`,
              `  - references: ${m.maxReferences.total === 0 ? "not supported" : `up to ${m.maxReferences.total} (${m.referenceKinds.join(", ")})`}`,
              `  - defaults: ${[m.defaults.durationSeconds && `${m.defaults.durationSeconds}s`, m.defaults.quality, m.defaults.aspectRatio].filter(Boolean).join(", ") || "none"}`,
            );
          }
        }
        if (image.length) {
          lines.push("", "## Image models");
          for (const m of image) {
            lines.push(
              `- **${m.name}** (\`${m.id}\`) — ${m.description}`,
              `  - qualities: ${m.qualities?.join(", ") ?? "none"} | aspect ratios: ${m.aspectRatios.join(", ")} | references: up to ${m.maxReferences.total}`,
            );
          }
        }
        return { structured, summary: render(response_format, lines.join("\n"), structured) };
      }),
  );

  server.registerTool(
    "dare_estimate_cost",
    {
      title: "Estimate Dare credit cost",
      description:
        "Estimate the credit cost of a generation before running it, using Dare's own pricing table. " +
        "Purely local arithmetic: no network request, no credits spent. Use this to check affordability, " +
        "compare quality tiers, or size a batch.",
      inputSchema: {
        kind: z.enum(["video", "image"]).default("video").describe("What is being generated."),
        model: z.string().describe("Model id, e.g. `seedance-2-5`."),
        quality: z.string().optional().describe("Quality tier, e.g. `720p` for video or `2k` for image."),
        aspect_ratio: z.string().optional().describe("Aspect ratio; affects cost on `gpt-image-2` only."),
        duration_seconds: z.number().int().min(1).max(300).optional().describe("Clip length in seconds (video)."),
        audio_enabled: z.boolean().default(true).describe("Whether audio is generated (affects Veo and Kling)."),
        reference_video_seconds: z
          .number()
          .min(0)
          .default(0)
          .describe("Total seconds of video references attached; billed in addition on Seedance 2.5."),
        reference_count: z.number().int().min(0).default(0).describe("Number of reference assets attached (images count toward image-model surcharges)."),
        video_reference_count: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("How many of the references are video clips. Only video references earn Seedance's 0.6x discount."),
        count: z.number().int().min(1).max(20).default(1).describe("How many variations to generate."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const spec = args.kind === "video" ? VIDEO_MODELS[args.model] : IMAGE_MODELS[args.model];
        if (!spec) {
          throw new DareError(`Unknown ${args.kind} model "${args.model}".`, {
            code: "DARE_BAD_INPUT",
            hint: `Valid ids: ${(args.kind === "video" ? VIDEO_MODEL_IDS : IMAGE_MODEL_IDS).join(", ")}.`,
          });
        }
        const quality = args.quality ?? spec.defaults.quality;
        const aspectRatio = args.aspect_ratio ?? spec.defaults.aspectRatio ?? "auto";
        // Mirror the generation path exactly: a video reference makes Seedance 2.5 derive
        // its own duration, so a passed duration is ignored there and must be here too.
        const videoSpec = args.kind === "video" ? (spec as (typeof VIDEO_MODELS)[string]) : null;
        const hasVideoRef = args.video_reference_count > 0 || args.reference_video_seconds > 0;
        const autoFromVideo = Boolean(videoSpec?.autoDurationWithVideoReference && hasVideoRef);
        const effectiveDuration = autoFromVideo
          ? undefined
          : videoSpec?.durationsSeconds
            ? (args.duration_seconds ?? videoSpec.defaults.durationSeconds)
            : undefined;

        const perRow =
          args.kind === "video"
            ? estimateVideoCredits({
                model: args.model,
                quality,
                durationSeconds: effectiveDuration,
                audioEnabled: args.audio_enabled,
                referenceVideoSeconds: args.reference_video_seconds,
                videoReferenceCount: hasVideoRef ? Math.max(1, args.video_reference_count) : 0,
              })
            : estimateImageCredits(args.model, quality, aspectRatio, args.reference_count);

        const total = perRow * args.count;
        const structured = {
          model: args.model,
          quality,
          aspect_ratio: aspectRatio,
          count: args.count,
          effective_duration_seconds: effectiveDuration ?? null,
          duration_derived_from_reference: autoFromVideo,
          credits_per_row: perRow,
          estimated_total_credits: total,
          note: "Mirrors Dare's own pricing (provider cost x1.5, rounded up to the nearest 1/5/10 credits). Dare's server is authoritative and returns `insufficient_credits` if short.",
        };
        const md = [
          `Estimated **${total} credits** — ${args.count} x ${perRow} for \`${args.model}\`${quality ? ` at ${quality}` : ""}${effectiveDuration ? `, ${effectiveDuration}s` : ""}.`,
          autoFromVideo
            ? "A video reference is attached, so duration is derived from it and any duration_seconds is ignored."
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        return { structured, summary: md };
      }),
  );

  server.registerTool(
    "dare_get_credit_balance",
    {
      title: "Get Dare credit balance",
      description:
        "Fetch the signed-in Dare account's current credit balance. Read-only. Use before a large batch " +
        "to confirm there is enough headroom.",
      inputSchema: { response_format: responseFormat },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) =>
      guard(async () => {
        const balance: any = await dare.getCreditBalance();
        const amount = balance?.credits ?? balance?.balance ?? balance;
        return {
          structured: { balance },
          summary: render(response_format, `Credit balance: **${JSON.stringify(amount)}**`, balance),
        };
      }),
  );

  /* ------------------------------------------------------------------ *
   * Generation
   * ------------------------------------------------------------------ */

  server.registerTool(
    "dare_generate_video",
    {
      title: "Generate a video on Dare",
      description:
        "Generate a video from a text prompt on Dare, defaulting to Seedance 2.5. SPENDS CREDITS from the " +
        "signed-in Dare account (a 10s 720p Seedance 2.5 clip is ~110 credits; call dare_estimate_cost first). " +
        "Returns generation ids immediately. Rendering is slow — Seedance 2.5 jobs commonly take 5–15 minutes — " +
        "so leave wait_seconds at 0 and poll with dare_get_generation, or set it only if your client tolerates " +
        "long tool calls. Attach reference images, clips or audio by uploading them first with dare_upload_media " +
        "and passing the storage keys.",
      inputSchema: {
        prompt: z.string().min(1).describe("What the video should show. Be specific about subject, action, camera and style."),
        model: z
          .enum(VIDEO_MODEL_IDS as [string, ...string[]])
          .default("seedance-2-5")
          .describe("Video model id. Seedance 2.5 supports up to 30 seconds."),
        duration_seconds: z
          .number()
          .int()
          .min(3)
          .max(30)
          .optional()
          .describe("Clip length in seconds. Seedance 2.5: 4–30; Seedance 2.0: 4–15; Kling: 3–15; Veo: 4/6/8 (8 with a reference); Hailuo: fixed. Ignored when a Seedance 2.5 video reference sets it."),
        quality: z.string().optional().describe("Quality tier, e.g. `480p` or `720p` for Seedance 2.5."),
        aspect_ratio: z.string().optional().describe("Aspect ratio such as `16:9`, `9:16` or `auto`."),
        audio_enabled: z.boolean().default(true).describe("Generate synchronised audio where the model supports it."),
        reference_storage_keys: z
          .array(z.string())
          .default([])
          .describe("Storage keys from dare_upload_media to use as reference images, clips or audio."),
        count: z.number().int().min(1).max(10).default(1).describe("Number of variations. Each one costs credits."),
        project_id: z.string().optional().describe("Optional Dare project to file the generation under."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(900)
          .default(0)
          .describe("Block up to this many seconds waiting for the result. 0 returns immediately."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Validate the request, resolve references and price it, but do not submit. Spends nothing. Returns the exact spec that would be sent."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await dare.createVideo({
          prompt: args.prompt,
          model: args.model,
          quality: args.quality,
          aspectRatio: args.aspect_ratio,
          durationSeconds: args.duration_seconds,
          audioEnabled: args.audio_enabled,
          referenceStorageKeys: args.reference_storage_keys,
          count: args.count,
          projectId: args.project_id,
          dryRun: args.dry_run,
        });
        if (args.dry_run) {
          const structured = { dry_run: true, estimated_credits: result.estimatedCredits, spec: result.spec, notes: result.notes };
          return {
            structured,
            summary: [`Dry run — nothing submitted. Would cost **${result.estimatedCredits} credits**.`, ...result.notes, "```json", JSON.stringify(result.spec, null, 2), "```"].join("\n"),
          };
        }

        if (result.outcome === "insufficient_credits") {
          throw new DareError(
            `Not enough Dare credits: ${result.requiredCredits} needed, ${result.creditBalance} available.`,
            {
              code: "DARE_INSUFFICIENT_CREDITS",
              hint: "Lower duration, quality or count, or top the account up at trydare.com.",
            },
          );
        }

        const ids = result.ids ?? [];
        if (ids.length === 0) {
          throw new DareError(`Dare accepted the request but returned no generation ids (outcome: ${result.outcome ?? "unknown"}).`, {
            code: "DARE_UNEXPECTED_OUTCOME",
            hint: "Check dare_list_generations to see whether a job was created, then retry once if not.",
          });
        }
        const waited = await settleWait(dare, ids[0], args.wait_seconds, 10_000);

        const structured = {
          generation_ids: ids,
          estimated_credits: Number(result.estimatedCredits.toFixed(4)),
          model: args.model,
          notes: result.notes,
          ...waited,
        };
        const md = [
          `Started ${ids.length} ${args.model} generation${ids.length === 1 ? "" : "s"} (~${result.estimatedCredits.toFixed(2)} credits).`,
          ids.length ? `Ids: ${ids.map((i) => `\`${i}\``).join(", ")}` : "",
          ...result.notes,
          waited.status ? `Status: **${waited.status}**${waited.output_url ? `\nOutput: ${waited.output_url}` : ""}` : "",
          waited.wait_error ? `Wait failed (the job is still running): ${waited.wait_error}` : "",
          waited.status && !waited.timed_out ? "" : "Poll `dare_get_generation` for the finished video.",
        ]
          .filter(Boolean)
          .join("\n");
        return { structured, summary: md };
      }),
  );

  server.registerTool(
    "dare_generate_image",
    {
      title: "Generate an image on Dare",
      description:
        "Generate a still image on Dare with Nano Banana 2, GPT Image 2 or Seedream 5 Pro. SPENDS CREDITS. " +
        "Useful for producing a reference frame to feed into dare_generate_video.",
      inputSchema: {
        prompt: z.string().min(1).describe("What the image should show."),
        model: z
          .enum(IMAGE_MODEL_IDS as [string, ...string[]])
          .default("nano-banana-2")
          .describe("Image model id."),
        quality: z.string().optional().describe("Quality tier, e.g. `1k`, `2k`, `4k`."),
        aspect_ratio: z.string().optional().describe("Aspect ratio such as `16:9` or `1:1`."),
        reference_storage_keys: z.array(z.string()).default([]).describe("Storage keys to use as references."),
        count: z.number().int().min(1).max(10).default(1).describe("Number of variations."),
        project_id: z.string().optional().describe("Optional Dare project id."),
        wait_seconds: z.number().int().min(0).max(600).default(0).describe("Block up to this long for the result."),
        dry_run: z.boolean().default(false).describe("Validate and price without submitting. Spends nothing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await dare.createImage({
          prompt: args.prompt,
          model: args.model,
          quality: args.quality,
          aspectRatio: args.aspect_ratio,
          referenceStorageKeys: args.reference_storage_keys,
          count: args.count,
          projectId: args.project_id,
          dryRun: args.dry_run,
        });
        if (args.dry_run) {
          const structured = { dry_run: true, estimated_credits: result.estimatedCredits, spec: result.spec, notes: result.notes };
          return {
            structured,
            summary: [`Dry run — nothing submitted. Would cost **${result.estimatedCredits} credits**.`, ...result.notes, "```json", JSON.stringify(result.spec, null, 2), "```"].join("\n"),
          };
        }
        if (result.outcome === "insufficient_credits") {
          throw new DareError(
            `Not enough Dare credits: ${result.requiredCredits} needed, ${result.creditBalance} available.`,
            { code: "DARE_INSUFFICIENT_CREDITS", hint: "Lower quality or count, or top up at trydare.com." },
          );
        }
        const ids = result.ids ?? [];
        if (ids.length === 0) {
          throw new DareError(`Dare accepted the request but returned no generation ids (outcome: ${result.outcome ?? "unknown"}).`, {
            code: "DARE_UNEXPECTED_OUTCOME",
            hint: "Check dare_list_generations to see whether a job was created, then retry once if not.",
          });
        }
        const waited = await settleWait(dare, ids[0], args.wait_seconds, 3_000);
        const structured = {
          generation_ids: ids,
          estimated_credits: Number(result.estimatedCredits.toFixed(4)),
          model: args.model,
          ...waited,
        };
        return {
          structured,
          summary:
            `Started ${ids.length} ${args.model} image generation${ids.length === 1 ? "" : "s"} ` +
            `(~${result.estimatedCredits.toFixed(2)} credits). Ids: ${ids.join(", ")}` +
            (waited.status ? `\nStatus: ${waited.status}${waited.output_url ? `\nOutput: ${waited.output_url}` : ""}` : ""),
        };
      }),
  );

  server.registerTool(
    "dare_get_generation",
    {
      title: "Get a Dare generation",
      description:
        "Fetch one generation by id: its status (queued, processing, succeeded, failed), credits charged, and — " +
        "once finished — the output asset URL. Read-only. Poll this after dare_generate_video; video jobs commonly " +
        "take 5–15 minutes. Use wait_seconds to block for up to that long per call, sized to what your client's " +
        "tool timeout allows (e.g. 45 for desktop apps, 300+ for Claude Code), and call again until status is terminal.",
      inputSchema: {
        generation_id: z.string().min(1).describe("Generation id returned by a dare_generate_* tool."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(900)
          .default(0)
          .describe("Poll until the generation leaves a pending state, up to this many seconds."),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ generation_id, wait_seconds, response_format }) =>
      guard(async () => {
        let generation: any;
        let status: string;
        let timedOut = false;

        if (wait_seconds > 0) {
          const result = await dare.waitForGeneration(generation_id, wait_seconds * 1000);
          generation = result.generation;
          status = result.status;
          timedOut = result.timedOut;
        } else {
          generation = await dare.getGeneration(generation_id);
          status = DareService.statusOf(generation) || "unknown";
        }

        const url = outputUrlOf(generation);
        const progress =
          generation?.stage || generation?.stageProgress != null
            ? `${generation.stage ?? "working"}${generation.stageProgress != null ? ` ${Math.round(generation.stageProgress)}%` : ""}`
            : null;
        const createdAt = generation?.createdAt ? new Date(generation.createdAt).getTime() : NaN;
        const elapsed = Number.isFinite(createdAt) ? Math.round((Date.now() - createdAt) / 1000) : null;
        const md = [
          `Generation \`${generation_id}\` — status: **${status || "unknown"}**${progress ? ` (${progress})` : ""}${elapsed != null ? ` · ${elapsed}s since submission` : ""}`,
          generation?.model ? `Model: ${generation.model}${generation.creditsCharged != null ? ` · credits charged: ${generation.creditsCharged}` : ""}` : "",
          generation?.failureMessage ? `Failure: ${generation.failureMessage}` : "",
          timedOut ? `Still running after ${wait_seconds}s; poll again.` : "",
          url ? `Output: ${url}` : "No output asset yet.",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          structured: {
            generation_id,
            status: status || "unknown",
            timed_out: timedOut,
            output_url: url,
            credits_charged: generation?.creditsCharged ?? null,
            failure_message: generation?.failureMessage ?? null,
            seconds_since_submission: elapsed,
            generation,
          },
          summary: render(response_format, md, generation),
        };
      }),
  );

  server.registerTool(
    "dare_list_generations",
    {
      title: "List Dare library items",
      description:
        "List recent items in the Dare library — generations and uploads, newest first — with cursor pagination. " +
        "Read-only. Use it to find an earlier video's id or an upload's storage key.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(25).describe("Items per page."),
        cursor: z.string().optional().describe("`next_cursor` from a previous call."),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, cursor, response_format }) =>
      guard(async () => {
        const page: any = await dare.listLibrary(cursor ?? null, limit);
        const items: any[] = page?.items ?? [];
        const md = items.length
          ? items
              .map((item) => {
                const g = item.generation ?? item.upload;
                const name = g?.name ?? g?.prompt?.slice(0, 60) ?? "(untitled)";
                return `- \`${item.id}\` [${item.type}] ${name}${g?.status ? ` — ${g.status}` : ""}`;
              })
              .join("\n")
          : "No items.";
        return {
          structured: {
            items,
            count: items.length,
            next_cursor: page?.nextCursor ?? null,
            has_more: Boolean(page?.nextCursor),
          },
          summary: render(response_format, md, page),
        };
      }),
  );

  server.registerTool(
    "dare_cancel_generation",
    {
      title: "Cancel a Dare generation",
      description:
        "Cancel an in-flight generation. Use when a job was started by mistake, to stop it consuming credits.",
      inputSchema: { generation_id: z.string().min(1).describe("Generation id to cancel.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ generation_id }) =>
      guard(async () => {
        const result = await dare.cancelGeneration(generation_id);
        return { structured: { generation_id, result }, summary: `Cancelled \`${generation_id}\`.` };
      }),
  );

  server.registerTool(
    "dare_delete_generation",
    {
      title: "Delete a Dare generation",
      description:
        "Permanently delete a generation and its output from the Dare library. Destructive and irreversible — " +
        "confirm with the user first. Does not refund credits.",
      inputSchema: { generation_id: z.string().min(1).describe("Generation id to delete.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ generation_id }) =>
      guard(async () => {
        const result = await dare.deleteGeneration(generation_id);
        return { structured: { generation_id, result }, summary: `Deleted \`${generation_id}\`.` };
      }),
  );

  /* ------------------------------------------------------------------ *
   * Uploads and projects
   * ------------------------------------------------------------------ */

  server.registerTool(
    "dare_upload_media",
    {
      title: "Upload reference media to Dare",
      description:
        "Upload an image, video or audio file to Dare and return its storage key, for use as a reference in " +
        "dare_generate_video or dare_generate_image. Accepts a local file path, a public URL, or base64 bytes. " +
        "Spends no credits.",
      inputSchema: {
        file_path: z.string().optional().describe("Absolute path to a local file this server can read."),
        url: z.string().url().optional().describe("Public URL to download and upload."),
        base64: z.string().optional().describe("Base64-encoded file bytes."),
        name: z.string().optional().describe("Display name in the Dare library."),
        content_type: z.string().optional().describe("MIME type, e.g. `image/png`. Inferred when omitted."),
        project_id: z.string().optional().describe("Optional Dare project id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const provided = [args.file_path, args.url, args.base64].filter(Boolean);
        if (provided.length !== 1) {
          throw new DareError("Give exactly one of file_path, url or base64.", {
            code: "DARE_BAD_INPUT",
            hint: "Pass a single source for the upload.",
          });
        }
        const result = await dare.uploadMedia({
          source: { filePath: args.file_path, url: args.url, base64: args.base64 },
          name: args.name,
          contentType: args.content_type,
          projectId: args.project_id,
        });
        return {
          structured: { ...result, storage_key: result.storageKey },
          summary: `Uploaded **${result.name}** (${result.mediaType}). storage_key: \`${result.storageKey}\``,
        };
      }),
  );

  server.registerTool(
    "dare_list_uploads",
    {
      title: "List Dare uploads",
      description: "List previously uploaded reference media with their storage keys. Read-only, cursor-paginated.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).describe("Items per page."),
        cursor: z.string().optional().describe("`next_cursor` from a previous call."),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, cursor, response_format }) =>
      guard(async () => {
        const page: any = await dare.listUploads(cursor ?? null, limit);
        const items: any[] = page?.items ?? [];
        const md = items.length
          ? items.map((u) => `- \`${u.asset?.storageKey ?? u.id}\` — ${u.name} (${u.asset?.mediaType ?? "?"})`).join("\n")
          : "No uploads.";
        return {
          structured: {
            items,
            count: items.length,
            next_cursor: page?.nextCursor ?? null,
            has_more: Boolean(page?.nextCursor),
          },
          summary: render(response_format, md, page),
        };
      }),
  );

  server.registerTool(
    "dare_delete_upload",
    {
      title: "Delete a Dare upload",
      description:
        "Permanently delete an uploaded reference asset from the Dare library. Destructive and irreversible — " +
        "confirm with the user first. Generations that already used it are unaffected.",
      inputSchema: { upload_id: z.string().min(1).describe("Upload id from dare_upload_media or dare_list_uploads.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ upload_id }) =>
      guard(async () => {
        const result = await dare.deleteUpload(upload_id);
        return { structured: { upload_id, result }, summary: `Deleted upload \`${upload_id}\`.` };
      }),
  );

  server.registerTool(
    "dare_list_projects",
    {
      title: "List Dare projects",
      description: "List the account's Dare projects, for filing generations under a project id. Read-only.",
      inputSchema: { response_format: responseFormat },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) =>
      guard(async () => {
        const projects: any = await dare.listProjects();
        const list: any[] = Array.isArray(projects) ? projects : (projects?.items ?? []);
        const md = list.length ? list.map((p) => `- \`${p.id}\` ${p.name ?? ""}`).join("\n") : "No projects.";
        return { structured: { projects: list, count: list.length }, summary: render(response_format, md, projects) };
      }),
  );

  return server;
}
