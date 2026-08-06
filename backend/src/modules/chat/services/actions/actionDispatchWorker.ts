import type { ErrorReporter } from "../../../../shared/errors/errorReporter.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";

/** The drain surface the worker polls — satisfied by {@link ActionDispatcher}. */
export interface ActionDispatchPort {
  dispatchPending(limit?: number): Promise<{ dispatched: number; retried: number; failed: number }>;
}

/** A point-in-time read of outbox backlog — satisfied by `ActionRequestRepository`. */
export interface ActionOutboxDepthPort {
  getPendingDepthSnapshot(): Promise<{
    pendingCount: number;
    inProgressCount: number;
    oldestPendingCreatedAt: Date | null;
  }>;
}

/** Narrow telemetry sink; `TelemetryService` satisfies this structurally. */
export interface ActionDispatchTelemetryService {
  emit(input: {
    eventType: string;
    metrics: Record<string, number>;
  }): Promise<unknown>;
}

export interface ActionDispatchWorkerOptions {
  logger: Pick<AppLogger, "error" | "debug">;
  intervalMs?: number;
  batchSize?: number;
  /** Optional sink for unexpected drain failures (e.g. a downstream outage), so they reach error tracking. */
  errorReporter?: ErrorReporter;
  /**
   * Optional outbox-depth reader. When configured, every successful drain (not just
   * on activity transitions) reports current pending/in-progress counts and the oldest
   * pending row's age — the operator-alertable signal for a stuck outbox. Unlike the
   * document worker's edge-triggered queue-state log, this must not be edge-triggered:
   * a permanently stuck backlog (the failure mode this exists to catch) never produces
   * another "processing" transition to re-report on, so a stale gauge would hide it.
   */
  depthSnapshot?: ActionOutboxDepthPort;
  telemetryService?: ActionDispatchTelemetryService;
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
  async drain(): Promise<{ dispatched: number; retried: number; failed: number } | null> {
    if (this.draining) {
      return null;
    }
    this.draining = true;
    try {
      const result = await this.dispatcher.dispatchPending(this.options.batchSize ?? 20);
      if (result.dispatched > 0 || result.retried > 0 || result.failed > 0) {
        this.options.logger.debug({ ...result }, "Action dispatch drain completed");
      }
      await this.reportQueueDepth();
      return result;
    } catch (error) {
      this.options.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Action dispatch drain failed",
      );
      // Fire-and-forget so the poll loop is never blocked by reporting, but the
      // rejection must be caught — an unhandled rejection would now be process-fatal.
      void this.options.errorReporter
        ?.report({ errorType: "action.dispatch.drain_failed", error, severity: "error" })
        .catch((reportError) => {
          this.options.logger.error(
            { err: reportError instanceof Error ? reportError.message : String(reportError) },
            "Action dispatch error report failed",
          );
        });
      return null;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Best-effort: a depth-snapshot or telemetry failure never fails the drain that
   * already dispatched real work. No payload/PII — counts and an age in milliseconds
   * only.
   */
  private async reportQueueDepth(): Promise<void> {
    if (!this.options.depthSnapshot || !this.options.telemetryService) {
      return;
    }
    try {
      const snapshot = await this.options.depthSnapshot.getPendingDepthSnapshot();
      const oldestPendingAgeMs = snapshot.oldestPendingCreatedAt
        ? Math.max(0, Date.now() - snapshot.oldestPendingCreatedAt.getTime())
        : 0;
      await this.options.telemetryService.emit({
        eventType: "action.dispatch.queue_state",
        metrics: {
          pendingCount: snapshot.pendingCount,
          inProgressCount: snapshot.inProgressCount,
          oldestPendingAgeMs,
        },
      });
    } catch (error) {
      this.options.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Action dispatch queue-depth reporting failed",
      );
    }
  }
}
