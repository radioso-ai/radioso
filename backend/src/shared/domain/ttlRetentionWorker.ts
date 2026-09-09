/**
 * Generic time-boxed retention sweep, generalized from `CopilotRetentionWorker`. Any table of
 * durable evidence that must not become an indefinite archive (a JSONB transcript, a frozen
 * snapshot) can wire one narrow delete port into this worker rather than re-implementing the
 * timer/batch/audit/skip-while-in-flight machinery per table.
 */

/** Rows removed per statement, so a large backlog drains without one table-wide delete. */
const TTL_RETENTION_BATCH_SIZE_DEFAULT = 200;
const SWEEP_INTERVAL_MS_DEFAULT = 6 * 60 * 60 * 1_000;
/** Caps one tick's work so a huge first sweep cannot monopolise the worker. */
const MAX_BATCHES_PER_SWEEP = 25;

export interface TtlRetentionSweepPort {
  /** Deletes at most `limit` rows last updated before `cutoff`; returns how many went. */
  deleteBefore(input: { cutoff: Date; limit: number }): Promise<number>;
}

interface TtlRetentionAuditPort {
  record(event: { eventType: string; eventStatus: "success" | "failure"; metadata: Record<string, unknown> }): Promise<unknown>;
}

interface TtlRetentionLoggerPort {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * What one sweep did. A failed sweep is its own outcome rather than a zero, because the two
 * callers need different answers: the poll loop keeps its cadence either way, but the scheduled
 * task route has to return a retryable status — a transient deadlock reported as success is a
 * retention window that quietly stops being enforced.
 */
export type TtlRetentionSweepResult =
  | { readonly status: "swept"; readonly deleted: number }
  | { readonly status: "skipped"; readonly reason: "disabled" | "in_flight" }
  | { readonly status: "failed"; readonly error: string };

interface TtlRetentionWorkerOptions {
  /** Table/subject name used only in log lines and the audit event type, e.g. "agent_test_execution". */
  readonly subject: string;
  readonly sweep: TtlRetentionSweepPort;
  readonly audit: TtlRetentionAuditPort;
  readonly logger: TtlRetentionLoggerPort;
  readonly retentionDays: number;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

export class TtlRetentionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly options: TtlRetentionWorkerOptions) {}

  get enabled(): boolean {
    return this.options.retentionDays > 0;
  }

  start(): void {
    if (this.timer) return;
    if (!this.enabled) {
      this.options.logger.warn({ subject: this.options.subject }, "TTL retention is disabled");
      return;
    }
    this.options.logger.info({ subject: this.options.subject, retentionDays: this.options.retentionDays }, "TTL retention worker enabled");
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? SWEEP_INTERVAL_MS_DEFAULT);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Runs one sweep. Never throws: the timer must keep its cadence, because a transient deadlock
   * must not silently end retention for the life of the process. The failure is reported rather
   * than swallowed so a caller that can retry — the scheduled task route — is able to.
   */
  async sweep(): Promise<TtlRetentionSweepResult> {
    if (!this.enabled) return { status: "skipped", reason: "disabled" };
    if (this.sweeping) return { status: "skipped", reason: "in_flight" };
    this.sweeping = true;
    try {
      const batchSize = this.options.batchSize ?? TTL_RETENTION_BATCH_SIZE_DEFAULT;
      const now = (this.options.now ?? (() => new Date()))();
      const cutoff = new Date(now.getTime() - this.options.retentionDays * 24 * 60 * 60 * 1_000);
      let deleted = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        const removed = await this.options.sweep.deleteBefore({ cutoff, limit: batchSize });
        deleted += removed;
        if (removed < batchSize) break;
      }
      if (deleted > 0) await this.report(deleted, cutoff);
      return { status: "swept", deleted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error({ subject: this.options.subject, err: message }, "TTL retention sweep failed");
      return { status: "failed", error: message };
    } finally {
      this.sweeping = false;
    }
  }

  /** Only a sweep that removed something is recorded, so the audit trail is not a heartbeat. */
  private async report(deleted: number, cutoff: Date): Promise<void> {
    this.options.logger.info({ subject: this.options.subject, deleted, retentionDays: this.options.retentionDays }, "TTL retention swept");
    await this.options.audit.record({
      eventType: `${this.options.subject}.retention.enforced`,
      eventStatus: "success",
      metadata: {
        deleted,
        retentionDays: this.options.retentionDays,
        cutoff: cutoff.toISOString(),
        // The sweep is the schedule acting on its own; stated rather than left absent so a
        // reader of the audit trail can tell a system action from one that lost its attribution.
        principalType: "system",
      },
    }).catch((error: unknown) => {
      this.options.logger.error(
        { subject: this.options.subject, err: error instanceof Error ? error.message : String(error), deleted },
        "TTL retention audit failed after the delete committed",
      );
    });
  }
}
