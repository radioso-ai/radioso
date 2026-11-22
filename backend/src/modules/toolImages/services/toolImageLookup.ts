import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { TOOL_IMAGE_LIMITS, type ToolImageRendition, type ToolImageStore } from "../domain.js";
import type { ToolImageCaptureResult, ToolImageCaptureTrigger } from "./toolImageCapture.js";

/** How often a request waiting on another capture of the same picture looks again. */
const HELD_POLL_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why the route had no copy to serve. Bounded, since it is a metric label: no capture turn came
 * free in time, the capture or another one holding the picture outlived the request's budget, the
 * network or storage failed, the picture failed for good, or no waiting picture has the id.
 */
type ToolImageMissReason = "busy" | "timeout" | "unreachable" | "failed" | "not_found";

const missReasonOf = (result: ToolImageCaptureResult): ToolImageMissReason => {
  switch (result) {
    case "busy":
    case "timeout":
    case "unreachable":
      return result;
    case "held":
      return "timeout";
    case "missing":
    case "stored":
      return "not_found";
    default:
      return "failed";
  }
};

/** Misses a later request may get past; the others are the picture's own. */
const TRANSIENT_MISSES: ReadonlySet<ToolImageMissReason> = new Set(["busy", "timeout", "unreachable"]);

/**
 * Finds the stored copy the image route serves for a tool image, and copies a picture that is
 * still waiting on demand, while the browser asks for it: the reply is shown as soon as it is
 * written, usually before the job has run. A picture is captured once at a time in this process,
 * and a request that finds another capture holding it waits for that one, within one budget; a
 * request that finds every capture turn taken waits for one within the same budget. Every miss is
 * counted and logged with its reason and the image id, never the picture's address.
 */
export class ToolImageLookup {
  private readonly inFlight = new Map<string, Promise<ToolImageCaptureResult>>();

  constructor(
    private readonly deps: {
      store: Pick<ToolImageStore, "findRendition">;
      capture: { capture(imageId: string, trigger: ToolImageCaptureTrigger, options: { deadlineMs: number }): Promise<ToolImageCaptureResult> };
      budgetMs?: number;
      metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
      logger?: Pick<AppLogger, "info" | "warn">;
    },
  ) {}

  async findServable(input: { imageId: string; width: number }): Promise<ToolImageRendition | null> {
    const stored = await this.deps.store.findRendition(input);
    if (stored) return stored;
    const result = await this.captureOnce(input.imageId);
    const captured = await this.deps.store.findRendition(input);
    if (!captured) this.recordMiss(input.imageId, result);
    return captured;
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

  private recordMiss(imageId: string, outcome: ToolImageCaptureResult): void {
    const reason = missReasonOf(outcome);
    this.deps.metrics?.incrementCounter("tool_image_miss_total", {
      help: "Reply image requests that found no tool image copy to serve, by why",
      labels: { reason },
    });
    const fields = { imageId, reason, outcome };
    if (TRANSIENT_MISSES.has(reason)) this.deps.logger?.warn(fields, "tool_image_miss");
    else this.deps.logger?.info(fields, "tool_image_miss");
  }
}
