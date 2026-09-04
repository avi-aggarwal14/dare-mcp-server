/**
 * Dare's model catalogue and credit-pricing table.
 *
 * Mirrors the constraints and per-second credit rates the Dare web client enforces,
 * so the MCP server can validate inputs and estimate cost before spending credits.
 */

export type MediaKind = "image" | "video" | "audio";

export interface VideoModelSpec {
  id: string;
  name: string;
  description: string;
  tool: "create_video";
  aspectRatios: string[];
  durationsSeconds: number[];
  qualities: string[];
  audioToggle: boolean;
  referenceKinds: MediaKind[];
  maxReferences: { total: number; perKind?: Partial<Record<MediaKind, number>> };
  /** Combined seconds of reference media allowed per kind. */
  combinedSecondsPerKind?: number;
  /** When true, a video reference drives duration and aspect ratio automatically. */
  autoDurationWithVideoReference: boolean;
  defaults: { aspectRatio: string; durationSeconds?: number; quality: string };
}

export interface ImageModelSpec {
  id: string;
  name: string;
  description: string;
  tool: "create_image";
  aspectRatios: string[];
  qualities: string[];
  maxReferences: { total: number };
  defaults: { aspectRatio: string; quality: string };
}

const RANGE = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const VIDEO_MODELS: Record<string, VideoModelSpec> = {
  "seedance-2-5": {
    id: "seedance-2-5",
    name: "Seedance 2.5",
    description: "ByteDance Seedance 2.5. Videos up to 30 seconds. Dare's default video model.",
    tool: "create_video",
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationsSeconds: RANGE(4, 30),
    qualities: ["480p", "720p"],
    audioToggle: true,
    referenceKinds: ["image", "video", "audio"],
    maxReferences: { total: 50, perKind: { image: 30, video: 10, audio: 10 } },
    combinedSecondsPerKind: 30,
    autoDurationWithVideoReference: true,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "720p" },
  },
  "seedance-2": {
    id: "seedance-2",
    name: "Seedance 2.0",
    description: "ByteDance Seedance 2.0. Up to 4K with synchronised audio, 15 seconds max.",
    tool: "create_video",
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationsSeconds: RANGE(4, 15),
    qualities: ["480p", "720p", "1080p", "4k"],
    audioToggle: true,
    referenceKinds: ["image", "video", "audio"],
    maxReferences: { total: 12, perKind: { image: 9, video: 3, audio: 3 } },
    combinedSecondsPerKind: 15,
    autoDurationWithVideoReference: true,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "1080p" },
  },
  "seedance-2-fast": {
    id: "seedance-2-fast",
    name: "Seedance 2.0 Fast",
    description: "Faster, cheaper Seedance 2.0. 480p and 720p only.",
    tool: "create_video",
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationsSeconds: RANGE(4, 15),
    qualities: ["480p", "720p"],
    audioToggle: true,
    referenceKinds: ["image", "video", "audio"],
    maxReferences: { total: 12, perKind: { image: 9, video: 3, audio: 3 } },
    combinedSecondsPerKind: 15,
    autoDurationWithVideoReference: true,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "720p" },
  },
  "veo-3-1": {
    id: "veo-3-1",
    name: "Veo 3.1",
    description: "Google Veo 3.1.",
    tool: "create_video",
    aspectRatios: ["auto", "16:9", "9:16"],
    durationsSeconds: [4, 6, 8],
    qualities: ["1080p", "4k"],
    audioToggle: true,
    referenceKinds: ["image"],
    maxReferences: { total: 3, perKind: { image: 3 } },
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "auto", durationSeconds: 8, quality: "1080p" },
  },
  "kling-3": {
    id: "kling-3",
    name: "Kling 3.0 Pro",
    description: "Kuaishou Kling 3.0 Pro.",
    tool: "create_video",
    aspectRatios: ["auto", "16:9", "1:1", "9:16"],
    durationsSeconds: [5, 10],
    qualities: ["1080p"],
    audioToggle: true,
    referenceKinds: ["image"],
    maxReferences: { total: 4, perKind: { image: 4 } },
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "auto", durationSeconds: 5, quality: "1080p" },
  },
  "hailuo-2-3": {
    id: "hailuo-2-3",
    name: "Hailuo 2.3 Pro",
    description: "MiniMax Hailuo 2.3 Pro. Fixed-length clip, flat credit cost.",
    tool: "create_video",
    aspectRatios: ["auto", "16:9", "9:16"],
    durationsSeconds: [6],
    qualities: ["1080p"],
    audioToggle: false,
    referenceKinds: ["image"],
    maxReferences: { total: 2, perKind: { image: 2 } },
    autoDurationWithVideoReference: false,
    defaults: { aspectRatio: "auto", durationSeconds: 6, quality: "1080p" },
  },
};

export const IMAGE_MODELS: Record<string, ImageModelSpec> = {
  "nano-banana-2": {
    id: "nano-banana-2",
    name: "Nano Banana 2",
    description: "Google image model. Quality tiers 1k / 2k / 4k.",
    tool: "create_image",
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"],
    qualities: ["1k", "2k", "4k"],
    maxReferences: { total: 14 },
    defaults: { aspectRatio: "auto", quality: "2k" },
  },
  "gpt-image-2": {
    id: "gpt-image-2",
    name: "GPT Image 2",
    description: "OpenAI image model. Cost varies by aspect ratio plus per-reference surcharge.",
    tool: "create_image",
    aspectRatios: ["1:1", "3:2", "2:3"],
    qualities: ["auto"],
    maxReferences: { total: 16 },
    defaults: { aspectRatio: "1:1", quality: "auto" },
  },
  "seedream-5-pro": {
    id: "seedream-5-pro",
    name: "Seedream 5 Pro",
    description: "ByteDance Seedream 5 Pro. Quality tiers 1k / 2k.",
    tool: "create_image",
    aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    qualities: ["1k", "2k"],
    maxReferences: { total: 10 },
    defaults: { aspectRatio: "auto", quality: "2k" },
  },
};

/* ------------------------------------------------------------------ *
 * Credit pricing (credits per second unless noted), mirroring Dare's
 * client-side estimator. Treat results as estimates: Dare's server is
 * the authority and returns `insufficient_credits` when short.
 * ------------------------------------------------------------------ */

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

const firstRate = (table: Record<string, number>): number => Object.values(table)[0] ?? 0;

export interface VideoCostInput {
  model: string;
  quality: string;
  durationSeconds?: number;
  audioEnabled?: boolean;
  /** Total seconds of video references attached, if any. */
  referenceVideoSeconds?: number;
  referenceCount?: number;
}

/** Estimated credit cost for one video row. Multiply by `count` for a batch. */
export function estimateVideoCredits(input: VideoCostInput): number {
  const {
    model,
    quality,
    durationSeconds,
    audioEnabled = true,
    referenceVideoSeconds = 0,
    referenceCount = 0,
  } = input;
  const discount = referenceCount > 0 ? REFERENCE_DISCOUNT : 1;

  switch (model) {
    case "seedance-2":
    case "seedance-2-fast": {
      const table = model === "seedance-2" ? SEEDANCE_2_RATES : SEEDANCE_2_FAST_RATES;
      const rate = table[quality] ?? firstRate(table);
      return rate * (durationSeconds ?? 8) * discount;
    }
    case "seedance-2-5": {
      const rate = SEEDANCE_2_5_RATES[quality] ?? firstRate(SEEDANCE_2_5_RATES);
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

/** Estimated credit cost for one image row. */
export function estimateImageCredits(model: string, quality: string, aspectRatio: string, referenceCount = 0): number {
  switch (model) {
    case "nano-banana-2":
      return NANO_BANANA_RATES[quality] ?? firstRate(NANO_BANANA_RATES);
    case "gpt-image-2":
      return (IMAGE_GPT_ASPECT_RATES[aspectRatio] ?? IMAGE_GPT_ASPECT_RATES["1:1"]!) +
        IMAGE_GPT_PER_REFERENCE * referenceCount;
    case "seedream-5-pro":
      return (SEEDREAM_RATES[quality] ?? firstRate(SEEDREAM_RATES)) +
        SEEDREAM_PER_EXTRA_REFERENCE * Math.max(0, referenceCount - 1);
    default:
      return Number.NaN;
  }
}

export const VIDEO_MODEL_IDS = Object.keys(VIDEO_MODELS);
export const IMAGE_MODEL_IDS = Object.keys(IMAGE_MODELS);
