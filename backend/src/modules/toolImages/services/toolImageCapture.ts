import { createHash, randomBytes } from "node:crypto";

import { encodeWebpRenditions } from "../../../shared/infra/images/encodeWebpRenditions.js";
import { decodeGuarded } from "../../../shared/infra/images/guardedDecode.js";
import { NormalizationSlots } from "../../../shared/infra/images/normalizationSlots.js";
import type { PublicBytesFetchResult, PublicBytesLimits } from "../../../shared/infra/http/publicBytesFetch.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import {
  TOOL_IMAGE_LIMITS,
  TOOL_IMAGE_TYPES,
  TRANSIENT_CAPTURE_OUTCOMES,
  type ClaimedToolImage,
  type ToolImageCaptureOutcome,
  type ToolImageObject,
  type ToolImageObjectStore,
  type ToolImageRendition,
  type ToolImageStore,
} from "../domain.js";

/** What started a capture: the job after the reply, or a browser asking for the picture first. */
export type ToolImageCaptureTrigger = "job" | "on_demand";

/** A capture's result: how it ended, or `held` when another capture holds the picture. */
export type ToolImageCaptureResult = ToolImageCaptureOutcome | "held";

/**
 * Tool images decode one at a time in their own pool, then within the process-wide pool, so a
 * burst of cards cannot keep a visitor's photo upload from decoding.
 */
const TOOL_IMAGE_DECODE_SLOTS = new NormalizationSlots(1, 5_000);

/** Thrown when a capture's deadline passes or its caller cancels it. */
class CaptureAbortedError extends Error {
  constructor() {
    super("tool_image_capture_aborted");
    this.name = "CaptureAbortedError";
  }
}

/**
 * Settles with the work, or rejects as soon as the signal aborts. Work that outlives the abort
 * runs on and is ignored: nothing it returns is written.
 */
const untilAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new CaptureAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CaptureAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

type SourceRead = { kind: "read"; bytes: Buffer } | { kind: "failed"; outcome: ToolImageCaptureOutcome };

const fetchFailure = (result: Extract<PublicBytesFetchResult, { kind: "failed" }>): ToolImageCaptureOutcome => {
  switch (result.reason) {
    case "blocked":
      return "blocked_address";
    case "timeout":
      return "timeout";
    case "too_large":
      return "too_large";
    case "content_type":
      return "unsupported_type";
    case "unreachable":
      return "unreachable";
    case "too_many_redirects":
      return "http_error";
    case "http_status":
      // A server error or a rate limit may pass; any other status, an expired link's included, will not.
      return result.status !== undefined && (result.status >= 500 || result.status === 429) ? "unreachable" : "http_error";
  }
};

interface ToolImageCaptureDependencies {
  store: ToolImageStore;
  objects: Pick<ToolImageObjectStore, "locate" | "put">;
  fetchBytes: (url: string, limits: PublicBytesLimits) => Promise<PublicBytesFetchResult>;
  /** The widths every copy is encoded at, as the image route serves them. */
  renditionWidths: readonly number[];
  /** Captures this process runs at once. */
  concurrentCaptures?: number;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger?: Pick<AppLogger, "warn">;
  now?: () => Date;
  /** The tag one capture's objects are named by; random, so two captures never share a name. */
  newCaptureTag?: () => string;
}

/**
 * Copies one tool image: takes one of the process's capture turns, claims the row, fetches the
 * address through the bounded public fetch, re-encodes it with the shared codec into one WebP per
 * served width under names of its own, and marks the row stored if its claim still holds it. One
 * deadline covers all of it, the wait for a turn included. A failure a later attempt may get past
 * hands the row back; any other fails it for good, with its reason. Logs and metrics carry ids
 * and outcomes only, never an address, a title or a byte.
 */
export class ToolImageCapture {
  private readonly turns: NormalizationSlots;

  constructor(private readonly deps: ToolImageCaptureDependencies) {
    this.turns = new NormalizationSlots(deps.concurrentCaptures ?? TOOL_IMAGE_LIMITS.concurrentCaptures, TOOL_IMAGE_LIMITS.jobCaptureDeadlineMs);
  }

  /**
   * Captures the picture within `deadlineMs`. An on-demand capture that finds every turn taken
   * returns `busy` at once and leaves the picture to the job; a job waits for a turn within its
   * deadline. `signal` cancels the capture, as a job run's own deadline does.
   */
  capture(
    imageId: string,
    trigger: ToolImageCaptureTrigger,
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<ToolImageCaptureResult> {
    return traceOperation({
      name: "tool_images.capture",
      attributes: { "tool_image.id": imageId, "tool_image.trigger": trigger },
      run: () => this.captureWithin(imageId, trigger, options),
      resultAttributes: (outcome) => ({ "tool_image.outcome": outcome }),
    });
  }

  private async captureWithin(
    imageId: string,
    trigger: ToolImageCaptureTrigger,
    options: { deadlineMs?: number; signal?: AbortSignal },
  ): Promise<ToolImageCaptureResult> {
    const deadlineMs = options.deadlineMs
      ?? (trigger === "on_demand" ? TOOL_IMAGE_LIMITS.onDemandCaptureDeadlineMs : TOOL_IMAGE_LIMITS.jobCaptureDeadlineMs);
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const started = performance.now();
    const result = await this.turns.run(
      () => this.claimAndCapture(imageId, trigger, signal),
      { waitMs: trigger === "on_demand" ? 0 : deadlineMs },
    );
    const outcome: ToolImageCaptureResult = result === "busy" ? "busy" : result;
    if (outcome !== "held") {
      this.deps.metrics?.incrementCounter("tool_image_capture_total", {
        help: "Tool image captures by what started them and how they ended",
        labels: { trigger, outcome },
      });
      this.deps.metrics?.observeHistogram("tool_image_capture_duration_seconds", {
        help: "Time to copy one tool image, from asking for a turn to stored or failed",
        labels: { trigger },
        value: (performance.now() - started) / 1_000,
      });
    }
    return outcome;
  }

  private async claimAndCapture(imageId: string, trigger: ToolImageCaptureTrigger, signal: AbortSignal): Promise<ToolImageCaptureResult> {
    if (signal.aborted) return "timeout";
    const claim = await this.deps.store.claim(imageId, this.now());
    switch (claim.kind) {
      case "stored":
        return "stored";
      case "held":
        return "held";
      case "failed":
      case "missing":
        return "source_missing";
      case "claimed":
        break;
    }
    const written: ToolImageObject[] = [];
    try {
      return await this.captureClaimed(claim.image, signal, written);
    } catch (error) {
      // The deadline passed, or storage or the database failed mid-way: the picture is not at
      // fault, so a later attempt may pass. Whatever this capture wrote goes.
      const reason: ToolImageCaptureOutcome = error instanceof CaptureAbortedError ? "timeout" : "unreachable";
      if (reason === "unreachable") {
        this.deps.logger?.warn({ imageId, workspaceId: claim.image.workspaceId, trigger, errorClass: errorClassOf(error) }, "tool_image_capture_errored");
      }
      await this.deps.store.release({ image: claim.image, reason, leftovers: written }).catch(() => undefined);
      return reason;
    }
  }

  private async captureClaimed(image: ClaimedToolImage, signal: AbortSignal, written: ToolImageObject[]): Promise<ToolImageCaptureResult> {
    const source = await this.readSource(image, signal);
    if (source.kind === "failed") {
      return this.finish(image, source.outcome);
    }
    const decoded = await untilAborted(decodeGuarded(
      source.bytes,
      { accepted: TOOL_IMAGE_TYPES, maxInputPixels: TOOL_IMAGE_LIMITS.maxInputPixels, slots: TOOL_IMAGE_DECODE_SLOTS },
      async (open) => ({
        metadata: await open().metadata(),
        renditions: await encodeWebpRenditions(open, { widthsPx: this.deps.renditionWidths }),
      }),
    ), signal);
    if (decoded.kind === "rejected") {
      const outcome: ToolImageCaptureOutcome = decoded.reason === "busy" ? "busy"
        : decoded.reason === "too_many_pixels" ? "too_large"
        : decoded.reason === "unsupported_type" ? "unsupported_type"
        : "decode_error";
      return this.finish(image, outcome);
    }
    const width = decoded.value.metadata.width ?? 0;
    const height = decoded.value.metadata.height ?? 0;
    if (width < TOOL_IMAGE_LIMITS.minSidePx || height < TOOL_IMAGE_LIMITS.minSidePx) {
      return this.finish(image, "too_small");
    }
    const tag = (this.deps.newCaptureTag ?? (() => randomBytes(6).toString("hex")))();
    const renditions: ToolImageRendition[] = [];
    for (const [index, rendition] of decoded.value.renditions.entries()) {
      const requested = this.deps.renditionWidths[index];
      const suffix = `w${requested}-${tag}` as const;
      const located = this.deps.objects.locate({ workspaceId: image.workspaceId, imageId: image.id, suffix });
      // Counted before the upload settles, so an abort mid-upload still hands the object off.
      written.push(located);
      const { sizeBytes } = await untilAborted(
        this.deps.objects.put({ workspaceId: image.workspaceId, imageId: image.id, suffix, bytes: rendition.webp, mimeType: "image/webp" }),
        signal,
      );
      renditions.push({ ...located, width: requested, height: rendition.height, sizeBytes });
    }
    if (signal.aborted) throw new CaptureAbortedError();
    const stored = await this.deps.store.markStored({
      image,
      width,
      height,
      sha256: createHash("sha256").update(source.bytes).digest("hex"),
      renditions,
    });
    // A capture that outlived its claim lost the picture to the one that took it over.
    return stored ? "stored" : "held";
  }

  private async readSource(image: ClaimedToolImage, signal: AbortSignal): Promise<SourceRead> {
    const fetched = await this.deps.fetchBytes(image.url, {
      // The fetch ends with the capture's deadline; the larger figure only bounds it from above.
      timeoutMs: TOOL_IMAGE_LIMITS.jobCaptureDeadlineMs,
      maxBytes: TOOL_IMAGE_LIMITS.maxSourceBytes,
      accept: "image/*",
      signal,
    });
    if (signal.aborted) throw new CaptureAbortedError();
    if (fetched.kind === "fetched") return { kind: "read", bytes: fetched.bytes };
    // A capture sends no entity tag, so a 304 is a server that answered what it was not asked.
    return { kind: "failed", outcome: fetched.kind === "not_modified" ? "http_error" : fetchFailure(fetched) };
  }

  private async finish(image: ClaimedToolImage, outcome: ToolImageCaptureOutcome): Promise<ToolImageCaptureOutcome> {
    if (TRANSIENT_CAPTURE_OUTCOMES.has(outcome)) {
      await this.deps.store.release({ image, reason: outcome, leftovers: [] });
    } else {
      await this.deps.store.markFailed({ image, reason: outcome });
    }
    return outcome;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
