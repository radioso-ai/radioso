import { createHash } from "node:crypto";

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
const TOOL_IMAGE_SLOTS = new NormalizationSlots(1, 5_000);

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
  objects: ToolImageObjectStore;
  fetchBytes: (url: string, limits: PublicBytesLimits) => Promise<PublicBytesFetchResult>;
  /** The widths every copy is encoded at, as the image route serves them. */
  renditionWidths: readonly number[];
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger?: Pick<AppLogger, "warn">;
  now?: () => Date;
}

/**
 * Copies one tool image: claims its row, reads the source (the address, through the bounded
 * public fetch, or the bytes the skill returned), re-encodes it with the shared codec into one
 * WebP per served width, stores the copies and marks the row stored. A failure a later attempt
 * may get past hands the row back; any other fails it for good, with its reason. Logs and
 * metrics carry ids and outcomes only, never an address, a title or a byte.
 */
export class ToolImageCapture {
  constructor(private readonly deps: ToolImageCaptureDependencies) {}

  capture(imageId: string, trigger: ToolImageCaptureTrigger, options: { timeoutMs?: number } = {}): Promise<ToolImageCaptureResult> {
    return traceOperation({
      name: "tool_images.capture",
      attributes: { "tool_image.id": imageId, "tool_image.trigger": trigger },
      run: () => this.claimAndCapture(imageId, trigger, options.timeoutMs ?? TOOL_IMAGE_LIMITS.jobFetchTimeoutMs),
      resultAttributes: (outcome) => ({ "tool_image.outcome": outcome }),
    });
  }

  private async claimAndCapture(imageId: string, trigger: ToolImageCaptureTrigger, timeoutMs: number): Promise<ToolImageCaptureResult> {
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
    const started = performance.now();
    let outcome: ToolImageCaptureOutcome;
    try {
      outcome = await this.captureClaimed(claim.image, timeoutMs);
    } catch (error) {
      // Storage or the database failed mid-way: the picture is not at fault, so a later attempt may pass.
      this.deps.logger?.warn({ imageId, workspaceId: claim.image.workspaceId, trigger, errorClass: errorClassOf(error) }, "tool_image_capture_errored");
      await this.deps.store.release({ imageId, reason: "unreachable" }).catch(() => undefined);
      outcome = "unreachable";
    }
    this.deps.metrics?.incrementCounter("tool_image_capture_total", {
      help: "Tool image captures by what started them and how they ended",
      labels: { trigger, outcome },
    });
    this.deps.metrics?.observeHistogram("tool_image_capture_duration_seconds", {
      help: "Time to copy one tool image, from claim to stored or failed",
      labels: { trigger },
      value: (performance.now() - started) / 1_000,
    });
    return outcome;
  }

  private async captureClaimed(image: ClaimedToolImage, timeoutMs: number): Promise<ToolImageCaptureOutcome> {
    const source = await this.readSource(image, timeoutMs);
    if (source.kind === "failed") {
      return this.finish(image, source.outcome);
    }
    const decoded = await decodeGuarded(
      source.bytes,
      { accepted: TOOL_IMAGE_TYPES, maxInputPixels: TOOL_IMAGE_LIMITS.maxInputPixels, slots: TOOL_IMAGE_SLOTS },
      async (open) => ({
        metadata: await open().metadata(),
        renditions: await encodeWebpRenditions(open, { widthsPx: this.deps.renditionWidths }),
      }),
    );
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
    const renditions: ToolImageRendition[] = [];
    for (const [index, rendition] of decoded.value.renditions.entries()) {
      const requested = this.deps.renditionWidths[index]!;
      const suffix = `w${requested}` as const;
      const { sizeBytes } = await this.deps.objects.put({ workspaceId: image.workspaceId, imageId: image.id, suffix, bytes: rendition.webp, mimeType: "image/webp" });
      renditions.push({ ...this.deps.objects.locate({ workspaceId: image.workspaceId, imageId: image.id, suffix }), width: requested, height: rendition.height, sizeBytes });
    }
    await this.deps.store.markStored({
      imageId: image.id,
      width,
      height,
      sha256: createHash("sha256").update(source.bytes).digest("hex"),
      renditions,
    });
    return "stored";
  }

  private async readSource(image: ClaimedToolImage, timeoutMs: number): Promise<SourceRead> {
    if (image.source.kind === "inline") {
      try {
        return { kind: "read", bytes: await this.deps.objects.get(image.source.object) };
      } catch {
        return { kind: "failed", outcome: "source_missing" };
      }
    }
    const fetched = await this.deps.fetchBytes(image.source.url, {
      timeoutMs,
      maxBytes: TOOL_IMAGE_LIMITS.maxSourceBytes,
      accept: "image/*",
    });
    return fetched.kind === "fetched" ? { kind: "read", bytes: fetched.bytes } : { kind: "failed", outcome: fetchFailure(fetched) };
  }

  private async finish(image: ClaimedToolImage, outcome: ToolImageCaptureOutcome): Promise<ToolImageCaptureOutcome> {
    if (TRANSIENT_CAPTURE_OUTCOMES.has(outcome)) {
      await this.deps.store.release({ imageId: image.id, reason: outcome });
    } else {
      await this.deps.store.markFailed({ imageId: image.id, reason: outcome });
    }
    return outcome;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
