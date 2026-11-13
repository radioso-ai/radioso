import type { ImageSourceType } from "../../shared/infra/images/imageSniff.js";

/** The bounds a tool image is held to; the server is the authority for all of them. */
export const TOOL_IMAGE_LIMITS = {
  /** A fetched picture's body is read no further than this. */
  maxSourceBytes: 8 * 1024 * 1024,
  /** Decoding stops past this many pixels, so a crafted file cannot exhaust memory. */
  maxInputPixels: 40_000_000,
  /** A picture smaller than this on either side is a tracking pixel or an icon, not a card's picture. */
  minSidePx: 32,
  /** A capture claim older than this belongs to a worker that is gone, and may be taken over. */
  claimTimeoutMs: 30_000,
  /** One deadline over a job's capture of one picture: the wait for a turn, the fetch, the encode and the uploads. */
  jobCaptureDeadlineMs: 20_000,
  /** The same deadline for a capture a browser waits on. */
  onDemandCaptureDeadlineMs: 6_000,
  /** Captures one process runs at once; an on-demand request that finds none free leaves the picture to the job. */
  concurrentCaptures: 4,
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

/**
 * A row a capture has claimed. `claimedAt` is the claim's generation: every write that finishes
 * the capture matches it, so a capture whose claim another one took over changes nothing.
 */
export interface ClaimedToolImage {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly claimedAt: Date;
}

/** Where a picture's row stands when a capture asks to claim it. */
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
  /**
   * Marks the row stored if this claim still holds it, and clears its address. Resolves false when
   * the claim was taken over; the renditions this claim wrote are then handed to the deletion job.
   */
  markStored(input: { image: ClaimedToolImage; width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }): Promise<boolean>;
  /** Fails the row for good if this claim still holds it, and clears its address. */
  markFailed(input: { image: ClaimedToolImage; reason: ToolImageCaptureOutcome }): Promise<void>;
  /**
   * Hands the row back for a later attempt if this claim still holds it, keeping its address. The
   * objects this claim may have written go to the deletion job either way.
   */
  release(input: { image: ClaimedToolImage; reason: ToolImageCaptureOutcome; leftovers: readonly ToolImageObject[] }): Promise<void>;
  /** The rendition at `width` of a stored row, or null. */
  findRendition(input: { imageId: string; width: number }): Promise<ToolImageRendition | null>;
  /** Fails the rows among `imageIds` still waiting for a capture, once no attempt is left. */
  failPending(input: { imageIds: readonly string[]; reason: "retries_exhausted" }): Promise<void>;
}

/**
 * The objects one capture writes: one WebP per served width, named by the capture's own tag, so a
 * capture never overwrites or deletes another's copies of the same picture.
 */
export type ToolImageObjectSuffix = `w${number}-${string}`;

/** Document storage, narrowed to one tool image's objects under the workspace's `tool-images` folder. */
export interface ToolImageObjectStore {
  /** Where `<imageId>-<suffix>` lands, known before it is written. */
  locate(input: { workspaceId: string; imageId: string; suffix: ToolImageObjectSuffix }): ToolImageObject;
  put(input: { workspaceId: string; imageId: string; suffix: ToolImageObjectSuffix; bytes: Buffer; mimeType: string }): Promise<{ sizeBytes: number }>;
  remove(object: ToolImageObject): Promise<void>;
}
