import type { Db } from "../infra/kysely/types.js";
import type {
  BackgroundJobEnqueueReceipt,
  BackgroundJobQueue,
  BackgroundJobRequest,
  BackgroundJobWakePort,
  BackgroundJobWriter,
} from "./types.js";

interface QueueLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

interface QueueMetrics {
  incrementCounter(name: string, options: { help: string; labels?: Record<string, string> }): void;
}

/** Where no push transport is configured, the worker's poll loop finds due jobs on its own. */
export class NoopBackgroundJobWake implements BackgroundJobWakePort {
  async requestDrain(): Promise<void> {}
}

/**
 * Writes jobs through the store and wakes a worker through the configured transport. The write is
 * the durable part; the wake only shortens the wait, so a lost wake is logged and counted, never
 * thrown at a producer whose job is already stored.
 */
export class DefaultBackgroundJobQueue implements BackgroundJobQueue {
  constructor(private readonly deps: {
    writer: BackgroundJobWriter;
    wake: BackgroundJobWakePort;
    logger: QueueLogger;
    metrics?: QueueMetrics | null;
  }) {}

  async enqueue(request: BackgroundJobRequest): Promise<BackgroundJobEnqueueReceipt> {
    const receipt = await this.deps.writer.insert(request);
    if (receipt.inserted) {
      await this.requestDrain(request.runAfter);
    }
    return receipt;
  }

  enqueueInTransaction(transaction: Db, request: BackgroundJobRequest): Promise<BackgroundJobEnqueueReceipt> {
    return this.deps.writer.insert(request, transaction);
  }

  wake(): Promise<void> {
    return this.requestDrain(undefined);
  }

  private async requestDrain(notBefore: Date | undefined): Promise<void> {
    try {
      await this.deps.wake.requestDrain(notBefore ? { notBefore } : undefined);
      this.countWake("ok");
    } catch (error) {
      this.countWake("failed");
      this.deps.logger.warn(
        { errorType: error instanceof Error ? error.name : typeof error },
        "Background job wake failed; the worker poll loop or recovery sweep will run the job",
      );
    }
  }

  private countWake(result: "ok" | "failed"): void {
    this.deps.metrics?.incrementCounter("background_job_wakes_total", {
      help: "Background job wake requests by result.",
      labels: { result },
    });
  }
}
