import type { AppLogger } from "../../../../shared/observability/logger.js";

/** The drain surface the worker polls — satisfied by {@link ActionDispatcher}. */
export interface ActionDispatchPort {
  dispatchPending(limit?: number): Promise<{ dispatched: number; retried: number; failed: number }>;
}

export interface ActionDispatchWorkerOptions {
  logger: Pick<AppLogger, "error" | "debug">;
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Runs the action outbox drain on a poll loop in the worker process. The conversation
 * never waits on this — actions are enqueued during the turn and dispatched here, out
 * of band. Overlapping drains are skipped so a slow batch never stacks on the next tick.
 */
export class ActionDispatchWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(
    private readonly dispatcher: ActionDispatchPort,
    private readonly options: ActionDispatchWorkerOptions,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const interval = this.options.intervalMs ?? 5_000;
    // The interval intentionally keeps the worker event loop alive (not unref'd).
    this.timer = setInterval(() => {
      void this.drain();
    }, interval);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drain the outbox once. Returns the batch result, or `null` if a drain is already in
   * flight or the drain threw (the error is logged; the loop continues on the next tick).
   * Public so the poll loop, a worker task handler, or a test can trigger one drain.
   */
  async drain(): Promise<{ dispatched: number; failed: number } | null> {
    if (this.draining) {
      return null;
    }
    this.draining = true;
    try {
      const result = await this.dispatcher.dispatchPending(this.options.batchSize ?? 20);
      if (result.dispatched > 0 || result.retried > 0 || result.failed > 0) {
        this.options.logger.debug({ ...result }, "Action dispatch drain completed");
      }
      return result;
    } catch (error) {
      this.options.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Action dispatch drain failed",
      );
      return null;
    } finally {
      this.draining = false;
    }
  }
}
