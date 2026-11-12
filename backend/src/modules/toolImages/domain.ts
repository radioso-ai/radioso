import type { ImageSourceType } from "../../shared/infra/images/imageSniff.js";

/** The bounds a tool image is held to; the server is the authority for all of them. */
export const TOOL_IMAGE_LIMITS = {
  /** A fetched picture's body is read no further than this. */
  maxSourceBytes: 8 * 1024 * 1024,
  /** A picture a skill returns as bytes. */
  maxInlineBytes: 5 * 1024 * 1024,
  /** Pictures kept from one tool call's bytes. */
  maxInlinePerCall: 4,
  /** Decoding stops past this many pixels, so a crafted file cannot exhaust memory. */
  maxInputPixels: 40_000_000,
  /** A picture smaller than this on either side is a tracking pixel or an icon, not a card's picture. */
  minSidePx: 32,
  /** A capture claim older than this belongs to a worker that is gone, and may be taken over. */
  claimTimeoutMs: 30_000,
  /** The job's fetch budget. */
  jobFetchTimeoutMs: 10_000,
  /** The whole on-demand capture, fetch and encode, while the browser waits for the picture. */
  onDemandBudgetMs: 6_000,
  /** A picture no message carries is deleted this long after its row was written. */
  unboundLifetimeMs: 24 * 60 * 60 * 1_000,
  /** Pictures one capture job carries; a reply has at most ten cards. */
  imagesPerJob: 10,
} as const;

/** The raster types a tool image may be, read from its magic bytes; SVG never is. */
export const TOOL_IMAGE_TYPES: readonly ImageSourceType[] = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

/** Where one stored object of a tool image lives in document storage. */
export interface ToolImageObject {
  readonly bucket: string;
  readonly objectPath: string;
  readonly generation: string | null;
}

/** One stored WebP copy, as `renditions` keeps it: the width it was asked for, and what was written. */
export interface ToolImageRendition extends ToolImageObject {
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
}

/** A row a capture has claimed, with what it needs to read the source. */
export interface ClaimedToolImage {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: { readonly kind: "url"; readonly url: string } | { readonly kind: "inline"; readonly object: ToolImageObject };
}

/** Where a picture's rows stand when a capture asks to claim it. */
export type ToolImageClaim =
  | { readonly kind: "claimed"; readonly image: ClaimedToolImage }
  | { readonly kind: "stored" }
  | { readonly kind: "failed" }
  /** Another capture holds a fresh claim. */
  | { readonly kind: "held" }
  | { readonly kind: "missing" };

/**
 * How a capture ended. Bounded: each is a metric label and the stored failure reason. Transient
 * ones release the row for a retry; the rest fail it for good.
 */
export type ToolImageCaptureOutcome =
  | "stored"
  | "too_small"
  | "unsupported_type"
  | "too_large"
  | "blocked_address"
  | "timeout"
  | "http_error"
  | "unreachable"
  | "decode_error"
  | "busy"
  | "source_missing";

/** Failures a later attempt may get past: a timeout, the network or a server error, a busy decoder. */
export const TRANSIENT_CAPTURE_OUTCOMES: ReadonlySet<ToolImageCaptureOutcome> = new Set(["timeout", "unreachable", "busy"]);

/** The module's rows. The Postgres implementation is `infra/toolImageRepository.ts`. */
export interface ToolImageStore {
  claim(imageId: string, now: Date): Promise<ToolImageClaim>;
  /** Marks a claimed row stored, clears its source, and hands an inline source object to the deletion job. */
  markStored(input: { imageId: string; width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }): Promise<void>;
  /** Marks a claimed row failed for good, clears its source, and hands its objects to the deletion job. */
  markFailed(input: { imageId: string; reason: ToolImageCaptureOutcome; renditions?: readonly ToolImageRendition[] }): Promise<void>;
  /** Hands a claimed row back for a later attempt, keeping its source. */
  release(input: { imageId: string; reason: ToolImageCaptureOutcome }): Promise<void>;
  /** The rendition at `width` of a stored row, or null. */
  findRendition(input: { imageId: string; width: number }): Promise<ToolImageRendition | null>;
  /** Fails the rows among `imageIds` still waiting for a capture, once no attempt is left. */
  failPending(input: { imageIds: readonly string[]; reason: "retries_exhausted" }): Promise<void>;
}

/** Document storage, narrowed to one tool image's objects under the workspace's `tool-images` folder. */
export interface ToolImageObjectStore {
  /** Where `<imageId>-<suffix>` lands, known before it is written. */
  locate(input: { workspaceId: string; imageId: string; suffix: ToolImageObjectSuffix }): ToolImageObject;
  put(input: { workspaceId: string; imageId: string; suffix: ToolImageObjectSuffix; bytes: Buffer; mimeType: string }): Promise<{ sizeBytes: number }>;
  get(object: ToolImageObject): Promise<Buffer>;
  remove(object: ToolImageObject): Promise<void>;
}

/** The objects one picture may have: the bytes a skill returned, and one WebP per served width. */
export type ToolImageObjectSuffix = "source" | `w${number}`;
