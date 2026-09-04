import type { CopilotExpensiveOperationAuditPort } from "../contracts/expensiveOperation.js";

/**
 * How long a copilot conversation is kept after its last activity.
 *
 * Ray's transcripts are more sensitive than customer chat, not less: they are *about* the
 * workspace's configuration rather than an instance of it, and they quote conversation excerpts,
 * document titles, and settings along the way. Long enough that an operator can still find last
 * quarter's investigation; short enough that the store is not an indefinite archive.
 */
export const COPILOT_CONVERSATION_RETENTION_DAYS_DEFAULT = 90;

/** Rows removed per statement, so a large backlog drains without one table-wide delete. */
export const COPILOT_RETENTION_BATCH_SIZE_DEFAULT = 200;

const SWEEP_INTERVAL_MS_DEFAULT = 6 * 60 * 60 * 1_000;
/** Caps one tick's work so a huge first sweep cannot monopolise the worker. */
const MAX_BATCHES_PER_SWEEP = 25;

/**
 * Narrow port for the sweep alone: unlike every other copilot read, retention is not scoped to a
 * workspace or an operator, so it deliberately does not travel on `CopilotRepositoryPort`.
 */
export interface CopilotRetentionPort {
  /** Deletes at most `limit` conversations last active before `cutoff`; returns how many went. */
  deleteConversationsUpdatedBefore(input: { cutoff: Date; limit: number }): Promise<number>;
  /** Deletes expired MCP evidence, resolved proposals, then unreferenced invocation receipts. */
  deleteExpiredOperatorMcpRecords?(input: { now: Date; limit: number }): Promise<number>;
}

export interface CopilotRetentionLoggerPort {
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
export type CopilotRetentionSweepResult =
  | { readonly status: "swept"; readonly deleted: number }
  | { readonly status: "skipped"; readonly reason: "disabled" | "in_flight" }
  | { readonly status: "failed"; readonly error: string };

export interface CopilotRetentionWorkerOptions {
  readonly retention: CopilotRetentionPort;
  readonly audit: CopilotExpensiveOperationAuditPort;
  readonly logger: CopilotRetentionLoggerPort;
  readonly retentionDays: number;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

/**
 * Enforces the copilot conversation retention window on a timer in the worker process.
 *
 * Messages, proposals, and replay evidence all cascade from the conversation row, so deleting the
 * conversation is the whole policy — there is no second table to keep in step.
 */
export class CopilotRetentionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly options: CopilotRetentionWorkerOptions) {}

  get enabled(): boolean {
    return this.options.retentionDays > 0;
  }

  start(): void {
    if (this.timer) return;
    if (!this.enabled) {
      // Said once, at startup: an operator who turned retention off should be able to see that in
      // the log rather than infer it from conversations that never disappear.
      this.options.logger.warn({}, "Copilot conversation retention is disabled");
      return;
    }
    this.options.logger.info(
      { retentionDays: this.options.retentionDays },
      "Copilot conversation retention enabled",
    );
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.options.intervalMs ?? SWEEP_INTERVAL_MS_DEFAULT);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Runs one sweep. Never throws: the timer must keep its cadence, because a transient deadlock
   * must not silently end retention for the life of the process. The failure is reported rather
   * than swallowed so a caller that can retry — the scheduled task route — is able to.
   */
  async sweep(): Promise<CopilotRetentionSweepResult> {
    if (!this.enabled) return { status: "skipped", reason: "disabled" };
    if (this.sweeping) return { status: "skipped", reason: "in_flight" };
    this.sweeping = true;
    try {
      const batchSize = this.options.batchSize ?? COPILOT_RETENTION_BATCH_SIZE_DEFAULT;
      const cutoff = new Date(
        (this.options.now ?? (() => new Date()))().getTime() - this.options.retentionDays * 24 * 60 * 60 * 1_000,
      );
      let deleted = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        const removed = await this.options.retention.deleteConversationsUpdatedBefore({ cutoff, limit: batchSize });
        deleted += removed;
        if (removed < batchSize) break;
      }
      if (this.options.retention.deleteExpiredOperatorMcpRecords) {
        for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
          const removed = await this.options.retention.deleteExpiredOperatorMcpRecords({
            now: (this.options.now ?? (() => new Date()))(),
            limit: batchSize,
          });
          deleted += removed;
          if (removed < batchSize) break;
        }
      }
      if (deleted > 0) await this.report(deleted, cutoff);
      return { status: "swept", deleted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error({ err: message }, "Copilot conversation retention sweep failed");
      return { status: "failed", error: message };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Only a sweep that removed something is recorded. A quiet tick every few hours would bury the
   * events that answer "where did this conversation go" under events that answer nothing.
   */
  private async report(deleted: number, cutoff: Date): Promise<void> {
    this.options.logger.info({ deleted, retentionDays: this.options.retentionDays }, "Copilot conversation retention swept");
    await this.options.audit.record({
      eventType: "copilot.retention.enforced",
      eventStatus: "success",
      metadata: {
        deleted,
        retentionDays: this.options.retentionDays,
        cutoff: cutoff.toISOString(),
        // Every other copilot.* event names the operator and the surface they acted through. This
        // one has neither: the sweep is the schedule acting on its own, and inventing an operator
        // would be worse than saying so. Stated rather than left absent, so a reader of the audit
        // trail can tell a system action from an event that lost its attribution.
        principalType: "system",
      },
      // The deletion has already committed and the line above already explains it, so a failed
      // write must not fail the sweep. It is logged rather than swallowed: this is the record that
      // answers "where did this conversation go", and losing it silently is how that stops working.
    }).catch((error: unknown) => {
      this.options.logger.error(
        { err: error instanceof Error ? error.message : String(error), deleted },
        "Copilot conversation retention audit failed after the delete committed",
      );
    });
  }
}
