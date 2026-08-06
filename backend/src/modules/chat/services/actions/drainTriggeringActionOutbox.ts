import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { ActionDrainDispatcherPort } from "./actionDrainDispatcher.js";

/** The narrow enqueue port every current outbox producer already depends on
 * (`ChatActionOutboxPort`, `SlackPostOutboxPort`, `NotifyExecutor`'s outbox, ...) —
 * satisfied by `ActionRequestRepository`. */
export interface EnqueueingActionOutboxPort {
  enqueue(input: {
    type: string;
    payload: Record<string, unknown>;
    workspaceId?: string | null;
    accountId?: string | null;
    conversationId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ id: string; duplicate: boolean }>;
}

/**
 * Wraps any enqueue-shaped outbox port and requests a drain push once the enqueue
 * resolves. Every current caller of `ActionRequestRepository.enqueue()` constructs
 * it against the top-level (non-transactional) `Db`, so a single enqueue call is
 * one auto-committing statement — by the time `inner.enqueue()` resolves, the row
 * is already durable, and only then does this class request the push. Composition
 * wraps the underlying repository with this decorator at construction time so no
 * producer (routine action steps, notify skill dispatch, Slack escalation, ...)
 * needs its own push wiring.
 *
 * The push is best-effort: a failure never fails the caller's enqueue — the
 * interval-loop poller (local dev) and the recovery sweep (prod) still drain the
 * row on their own schedule.
 */
export class DrainTriggeringActionOutbox implements EnqueueingActionOutboxPort {
  constructor(
    private readonly inner: EnqueueingActionOutboxPort,
    private readonly drainDispatcher: ActionDrainDispatcherPort,
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  async enqueue(
    input: Parameters<EnqueueingActionOutboxPort["enqueue"]>[0],
  ): Promise<{ id: string; duplicate: boolean }> {
    const result = await this.inner.enqueue(input);
    try {
      await this.drainDispatcher.requestDrain();
    } catch (error) {
      // Never fails the write the caller is waiting on. No payload/PII here —
      // only the action type, which is product metadata, not visitor content.
      this.logger?.warn(
        {
          actionType: input.type,
          err: error instanceof Error ? error.message : String(error),
        },
        "Action outbox drain push failed; the interval poller or recovery sweep will pick this up",
      );
    }
    return result;
  }
}
