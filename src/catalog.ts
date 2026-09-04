/**
 * Dare's model catalogue and credit-pricing table.
 *
 * Mirrors the constraints and per-second credit rates the Dare web client enforces,
 * so the MCP server can validate inputs and estimate cost before spending credits.
 */

export type MediaKind = "image" | "video" | "audio";

/**
 * Per-model constraints, mirrored from Dare's `workspace-catalog` bundle.
 *
 * Optional fields are optional for a reason: Dare's composer only puts a key in the
 * request spec when the model's config declares it. Hailuo sends `{tool, prompt, model}`
 * and nothing else; Kling has durations but no quality tier; GPT Image 2 has aspect
 * ratios but no quality. `buildSpec` in dare.ts follows the same rule.
 */
export interface VideoModelSpec {
  id: string;
  name: string;
  description: string;
  tool: "create_video";
  aspectRatios?: string[];
  durationsSeconds?: number[];
  qualities?: string[];
  /** Whether the spec carries an `audioEnabled` flag. */
  audioToggle: boolean;
  referenceKinds: MediaKind[];
  maxReferences: { total: number; perKind?: Partial<Record<MediaKind, number>> };
  /** Each reference clip must be within this length. */
  referenceClipSeconds?: { min: number; max: number };
  /** Combined seconds of reference media allowed per kind (video, audio). */
  combinedSecondsPerKind?: number;
  /** An audio reference must be accompanied by an image or video reference. */
  audioRequiresVisual?: boolean;
  /** With any reference attached, only these durations are allowed. */
  durationsWithReference?: number[];
  /** A video reference drives duration and aspect ratio; both are omitted from the spec. */
  autoDurationWithVideoReference: boolean;
  defaults: { aspectRatio?: string; durationSeconds?: number; quality?: string };
}

export interface ImageModelSpec {
  id: string;
  name: string;
  description: string;
  tool: "create_image";
  aspectRatios: string[];
  qualities?: string[];
  maxReferences: { total: number };
  defaults: { aspectRatio: string; quality?: string };
}

const RANGE = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const SEEDANCE_RATIOS = ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export const VIDEO_MODELS: Record<string, VideoModelSpec> = {
  "seedance-2-5": {
    id: "seedance-2-5",
    name: "Seedance 2.5",
    description: "ByteDance Seedance 2.5. Up to 30 seconds. Dare's default video model.",
    tool: "create_video",
    aspectRatios: SEEDANCE_RATIOS,
    durationsSeconds: RANGE(4, 30),
    qualities: ["480p", "720p"],
    audioToggle: true,
    referenceKinds: ["image", "video", "audio"],
    maxReferences: { total: 50, perKind: { image: 30, video: 10, audio: 10 } },
    referenceClipSeconds: { min: 2, max: 30 },
    combinedSecondsPerKind: 30,
    autoDurationWithVideoReference: true,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "720p" },
  },
  "seedance-2": {
    id: "seedance-2",
    name: "Seedance 2.0",
    description: "ByteDance Seedance 2.0. Up to 4K with synchronised audio, 15 seconds max.",
    tool: "create_video",
    aspectRatios: SEEDANCE_RATIOS,
    durationsSeconds: RANGE(4, 15),
    qualities: ["480p", "720p", "1080p", "4k"],
    audioToggle: true,
    referenceKinds: ["image", "video", "audio"],
    maxReferences: { total: 12, perKind: { image: 9, video: 3, audio: 3 } },
    referenceClipSeconds: { min: 2, max: 15 },
    combinedSecondsPerKind: 15,
    audioRequiresVisual: true,
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "1080p" },
  },
  "seedance-2-fast": {
    id: "seedance-2-fast",
    name: "Seedance 2.0 Fast",
    description: "Faster, cheaper Seedance 2.0. 480p and 720p only, 15 seconds max.",
    tool: "create_video",
    aspectRatios: SEEDANCE_RATIOS,
    durationsSeconds: RANGE(4, 15),
    qualities: ["480p", "720p"],
    audioToggle: true,
    referenceKinds: ["image", "video", "audio"],
    maxReferences: { total: 12, perKind: { image: 9, video: 3, audio: 3 } },
    referenceClipSeconds: { min: 2, max: 15 },
    combinedSecondsPerKind: 15,
    audioRequiresVisual: true,
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "720p" },
  },
  "veo-3-1": {
    id: "veo-3-1",
    name: "Veo 3.1",
    description: "Google Veo 3.1. 4, 6 or 8 seconds; fixed at 8 seconds when a reference image is attached.",
    tool: "create_video",
    aspectRatios: ["16:9", "9:16"],
    durationsSeconds: [4, 6, 8],
    qualities: ["720p", "1080p", "4k"],
    audioToggle: true,
    referenceKinds: ["image"],
    maxReferences: { total: 3 },
    durationsWithReference: [8],
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "16:9", durationSeconds: 8, quality: "1080p" },
  },
  "kling-3": {
    id: "kling-3",
    name: "Kling 3.0 Pro",
    description: "Kuaishou Kling 3.0 Pro. 3–15 seconds, no quality tiers, no reference media.",
    tool: "create_video",
    aspectRatios: ["16:9", "9:16", "1:1"],
    durationsSeconds: RANGE(3, 15),
    audioToggle: true,
    referenceKinds: [],
    maxReferences: { total: 0 },
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "16:9", durationSeconds: 5 },
  },
  "hailuo-2-3": {
    id: "hailuo-2-3",
    name: "Hailuo 2.3 Pro",
    description: "MiniMax Hailuo 2.3 Pro. Prompt only: no duration, ratio, quality or reference options. Flat price.",
    tool: "create_video",
    audioToggle: false,
    referenceKinds: [],
    maxReferences: { total: 0 },
    autoDurationWithVideoReference: false,
    defaults: {},
  },
};

export const IMAGE_MODELS: Record<string, ImageModelSpec> = {
  "nano-banana-2": {
    id: "nano-banana-2",
    name: "Nano Banana 2",
    description: "Google image model. Quality tiers 1k / 2k / 4k.",
    tool: "create_image",
    aspectRatios: ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"],
    qualities: ["1k", "2k", "4k"],
    maxReferences: { total: 14 },
    defaults: { aspectRatio: "auto", quality: "2k" },
  },
  "gpt-image-2": {
    id: "gpt-image-2",
    name: "GPT Image 2",
    description: "OpenAI image model. No quality tiers; cost varies by aspect ratio plus a per-reference surcharge.",
    tool: "create_image",
    aspectRatios: ["auto", "1:1", "3:2", "2:3"],
    maxReferences: { total: 16 },
    defaults: { aspectRatio: "auto" },
  },
  "seedream-5-pro": {
    id: "seedream-5-pro",
    name: "Seedream 5 Pro",
    description: "ByteDance Seedream 5 Pro. Quality tiers 1k / 2k.",
    tool: "create_image",
    aspectRatios: ["auto", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],
    qualities: ["1k", "2k"],
    maxReferences: { total: 10 },
    defaults: { aspectRatio: "auto", quality: "2k" },
  },
};

/* ------------------------------------------------------------------ *
 * Pricing, mirroring Dare's client-side estimator exactly.
 *
 * The rate tables below are Dare's underlying provider cost in US DOLLARS
 * (per second of output unless noted). Dare converts that to credits with
 * `dollarsToCredits`: a 1.5x markup, divided by the credit price, rounded
 * UP to the nearest 1, 5 or 10 credits depending on size.
 *
 * Verified against a live charge: a 4s 480p Seedance 2.5 clip is
 * $0.882 -> 19.85 -> rounded to 20 credits, which is what Dare billed.
 * ------------------------------------------------------------------ */

/** Dollars per credit: Dare sells 750 credits for $49.99. */
export const DOLLARS_PER_CREDIT = 49.99 / 750;
/** Dare's markup over provider cost. */
export const MARKUP = 1.5;

/** Rounding granularity Dare applies to a credit amount. */
function granularity(credits: number): number {
  return credits <= 10 ? 1 : credits <= 50 ? 5 : 10;
}

/** Converts a provider cost in dollars to the credits Dare will actually charge. */
export function dollarsToCredits(dollars: number): number {
  if (!Number.isFinite(dollars)) return Number.NaN;
  const raw = (dollars * MARKUP) / DOLLARS_PER_CREDIT;
  const step = granularity(raw);
  return Math.ceil(raw / step) * step;
}

const SEEDANCE_2_RATES: Record<string, number> = { "480p": 0.136, "720p": 0.3034, "1080p": 0.682, "4k": 1.555 };
const SEEDANCE_2_FAST_RATES: Record<string, number> = { "480p": 0.109, "720p": 0.2419 };
const SEEDANCE_2_5_RATES: Record<string, number> = { "480p": 0.2205, "720p": 0.473 };
const KLING_RATE_WITH_AUDIO = 0.168;
const KLING_RATE_SILENT = 0.112;
const REFERENCE_DISCOUNT = 0.6;

const IMAGE_GPT_ASPECT_RATES: Record<string, number> = { "1:1": 0.211, "3:2": 0.165, "2:3": 0.165 };
const IMAGE_GPT_PER_REFERENCE = 0.035;
const NANO_BANANA_RATES: Record<string, number> = { "1k": 0.15, "2k": 0.15, "4k": 0.3 };
const SEEDREAM_RATES: Record<string, number> = { "1k": 0.0675, "2k": 0.135 };
const SEEDREAM_PER_EXTRA_REFERENCE = 0.0045;

/** Dare falls back to the most expensive tier when a quality key is unknown. */
const maxRate = (table: Record<string, number>): number => Math.max(...Object.values(table));

export interface VideoCostInput {
  model: string;
  quality?: string;
  durationSeconds?: number;
  audioEnabled?: boolean;
  /** Total seconds of video references attached, if any. */
  referenceVideoSeconds?: number;
  /** Number of VIDEO references attached. Image and audio references do not affect price. */
  videoReferenceCount?: number;
}

/** Provider cost in dollars for one video row, before Dare's markup. */
export function videoCostDollars(input: VideoCostInput): number {
  const {
    model,
    quality,
    durationSeconds,
    audioEnabled = true,
    referenceVideoSeconds = 0,
    videoReferenceCount = 0,
  } = input;
  // Dare discounts Seedance generations that extend or edit an attached clip.
  const discount = videoReferenceCount > 0 ? REFERENCE_DISCOUNT : 1;

  switch (model) {
    case "seedance-2":
    case "seedance-2-fast": {
      const table = model === "seedance-2" ? SEEDANCE_2_RATES : SEEDANCE_2_FAST_RATES;
      const rate = (quality !== undefined ? table[quality] : undefined) ?? maxRate(table);
      return rate * (durationSeconds ?? 8) * discount;
    }
    case "seedance-2-5": {
      const rate = (quality !== undefined ? SEEDANCE_2_5_RATES[quality] : undefined) ?? maxRate(SEEDANCE_2_5_RATES);
      const refSeconds = Math.min(referenceVideoSeconds, 30);
      const base = durationSeconds ?? refSeconds;
      return rate * (base + refSeconds) * discount;
    }
    case "veo-3-1": {
      const rate =
        quality === "4k" ? (audioEnabled ? 0.6 : 0.4) : audioEnabled ? 0.4 : 0.2;
      return rate * (durationSeconds ?? 8);
    }
    case "kling-3":
      return (audioEnabled ? KLING_RATE_WITH_AUDIO : KLING_RATE_SILENT) * (durationSeconds ?? 5);
    case "hailuo-2-3":
      return 0.49;
    default:
      return Number.NaN;
  }
}

/** Credits Dare will charge for one video row. Multiply by `count` for a batch. */
export function estimateVideoCredits(input: VideoCostInput): number {
  return dollarsToCredits(videoCostDollars(input));
}

/** Provider cost in dollars for one image row, before Dare's markup. */
export function imageCostDollars(model: string, quality: string | undefined, aspectRatio: string, referenceCount = 0): number {
  switch (model) {
    case "nano-banana-2":
      return (quality !== undefined ? NANO_BANANA_RATES[quality] : undefined) ?? maxRate(NANO_BANANA_RATES);
    case "gpt-image-2":
      return (IMAGE_GPT_ASPECT_RATES[aspectRatio] ?? IMAGE_GPT_ASPECT_RATES["1:1"]!) +
        IMAGE_GPT_PER_REFERENCE * referenceCount;
    case "seedream-5-pro":
      return ((quality !== undefined ? SEEDREAM_RATES[quality] : undefined) ?? maxRate(SEEDREAM_RATES)) +
        SEEDREAM_PER_EXTRA_REFERENCE * Math.max(0, referenceCount - 1);
    default:
      return Number.NaN;
  }
}

export const VIDEO_MODEL_IDS = Object.keys(VIDEO_MODELS);
export const IMAGE_MODEL_IDS = Object.keys(IMAGE_MODELS);

/** Credits Dare will charge for one image row. */
export function estimateImageCredits(model: string, quality: string | undefined, aspectRatio: string, referenceCount = 0): number {
  return dollarsToCredits(imageCostDollars(model, quality, aspectRatio, referenceCount));
}
