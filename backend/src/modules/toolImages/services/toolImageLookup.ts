import { TOOL_IMAGE_LIMITS, type ToolImageRendition, type ToolImageStore } from "../domain.js";
import type { ToolImageCaptureResult, ToolImageCaptureTrigger } from "./toolImageCapture.js";

/** How often a request waiting on another capture of the same picture looks again. */
const HELD_POLL_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Finds the stored copy the image route serves for a tool image, and copies a picture that is
 * still waiting on demand, while the browser asks for it: the reply is shown as soon as it is
 * written, usually before the job has run. A picture is captured once at a time in this process,
 * and a request that finds another capture holding it waits for that one, within one budget. When
 * the process is already running as many captures as it allows, or a picture failed, the request
 * is a plain miss at once: the card shows without its picture, and the job copies it.
 */
export class ToolImageLookup {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      store: Pick<ToolImageStore, "findRendition">;
      capture: { capture(imageId: string, trigger: ToolImageCaptureTrigger, options: { deadlineMs: number }): Promise<ToolImageCaptureResult> };
      budgetMs?: number;
    },
  ) {}

  async findServable(input: { imageId: string; width: number }): Promise<ToolImageRendition | null> {
    const stored = await this.deps.store.findRendition(input);
    if (stored) return stored;
    await this.captureOnce(input.imageId);
    return this.deps.store.findRendition(input);
  }

  private captureOnce(imageId: string): Promise<void> {
    const running = this.inFlight.get(imageId);
    if (running) return running;
    const run = this.captureWithin(imageId, Date.now() + (this.deps.budgetMs ?? TOOL_IMAGE_LIMITS.onDemandCaptureDeadlineMs))
      .finally(() => this.inFlight.delete(imageId));
    this.inFlight.set(imageId, run);
    return run;
  }

  private async captureWithin(imageId: string, deadline: number): Promise<void> {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const result = await this.deps.capture.capture(imageId, "on_demand", { deadlineMs: remaining });
      if (result !== "held" || Date.now() + HELD_POLL_MS >= deadline) return;
      await delay(HELD_POLL_MS);
    }
  }
}
