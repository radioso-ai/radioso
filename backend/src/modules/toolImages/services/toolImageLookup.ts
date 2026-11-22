import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ToolImageMiss, ToolImageMissReason } from "../contracts/index.js";
import { TOOL_IMAGE_LIMITS, type ToolImageRendition, type ToolImageStore } from "../domain.js";
import type { ToolImageCaptureResult, ToolImageCaptureTrigger } from "./toolImageCapture.js";

/** How often a request waiting on another capture of the same picture looks again. */
const HELD_POLL_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const missReasonOf = (result: ToolImageCaptureResult): ToolImageMissReason => {
  switch (result) {
    case "busy":
    case "decoder_busy":
      return "busy";
    case "timeout":
    case "held":
      return "timeout";
    case "unreachable":
      return "unreachable";
    case "missing":
    case "stored":
      return "not_found";
    default:
      return "failed";
  }
};

/** Misses a later request may get past; the others are the picture's own. */
const RETRYABLE_MISSES: ReadonlySet<ToolImageMissReason> = new Set(["busy", "timeout", "unreachable"]);

/** What a lookup found: the stored copy at the asked width, or why there is none. */
type ToolImageFindResult = { readonly kind: "found"; readonly object: ToolImageRendition } | ToolImageMiss;

/**
 * Finds the stored copy the image route serves for a tool image, and copies a picture that is
 * still waiting on demand, while the browser asks for it: the reply is shown as soon as it is
 * written, usually before the job has run. A picture is captured once at a time in this process,
 * and a request that finds another capture holding it waits for that one, within one budget. A
 * miss says why and whether a later request may succeed; a caller that answers a request asks for
 * it to be counted and logged with the image id, never the picture's address.
 */
export class ToolImageLookup {
  private readonly inFlight = new Map<string, Promise<ToolImageCaptureResult>>();

  constructor(
    private readonly deps: {
      store: Pick<ToolImageStore, "findRendition">;
      capture: { capture(imageId: string, trigger: ToolImageCaptureTrigger, options: { deadlineMs: number }): Promise<ToolImageCaptureResult> };
      budgetMs?: number;
      metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
      logger?: Pick<AppLogger, "info" | "warn" | "debug">;
    },
  ) {}

  async find(input: { imageId: string; width: number }, options: { readonly recordMiss?: boolean } = {}): Promise<ToolImageFindResult> {
    const stored = await this.deps.store.findRendition(input);
    if (stored) return { kind: "found", object: stored };
    const result = await this.captureOnce(input.imageId);
    // Only a capture that stored the picture, or another one that held it, can have left a copy.
    const captured = result === "stored" || result === "held" ? await this.deps.store.findRendition(input) : null;
    if (captured) return { kind: "found", object: captured };
    const reason = missReasonOf(result);
    if (options.recordMiss) this.recordMiss(input.imageId, reason, result);
    return { kind: "miss", reason, retryable: RETRYABLE_MISSES.has(reason) };
  }

  private captureOnce(imageId: string): Promise<ToolImageCaptureResult> {
    const running = this.inFlight.get(imageId);
    if (running) return running;
    const run = this.captureWithin(imageId, Date.now() + (this.deps.budgetMs ?? TOOL_IMAGE_LIMITS.onDemandCaptureDeadlineMs))
      .finally(() => this.inFlight.delete(imageId));
    this.inFlight.set(imageId, run);
    return run;
  }

  private async captureWithin(imageId: string, deadline: number): Promise<ToolImageCaptureResult> {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";
      const result = await this.deps.capture.capture(imageId, "on_demand", { deadlineMs: remaining });
      if (result !== "held" || Date.now() + HELD_POLL_MS >= deadline) return result;
      await delay(HELD_POLL_MS);
    }
  }

  private recordMiss(imageId: string, reason: ToolImageMissReason, outcome: ToolImageCaptureResult): void {
    this.deps.metrics?.incrementCounter("tool_image_miss_total", {
      help: "Reply image requests that found no tool image copy to serve, by why",
      labels: { reason },
    });
    const fields = { imageId, reason, outcome };
    if (RETRYABLE_MISSES.has(reason)) this.deps.logger?.warn(fields, "tool_image_miss");
    else if (reason === "failed") this.deps.logger?.info(fields, "tool_image_miss");
    else this.deps.logger?.debug(fields, "tool_image_miss");
  }
}
