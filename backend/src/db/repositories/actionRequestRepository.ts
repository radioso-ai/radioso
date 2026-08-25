import { currentTimestamp, nowMinusSeconds, nowPlusSeconds, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export type ActionRequestStatus = "pending" | "in_progress" | "dispatched" | "failed";

/**
 * The outcome of recording a dispatch failure. `superseded` means this worker's claim
 * was already reclaimed by another (its lease expired), so its result was ignored.
 */
export type ActionFailureOutcome = "retry" | "failed" | "superseded";

export interface ActionOutboxDepthSnapshot {
  pendingCount: number;
  inProgressCount: number;
  oldestPendingCreatedAt: Date | null;
}

export interface ActionRequestRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  workspaceId: string | null;
  accountId: string | null;
  conversationId: string | null;
  idempotencyKey: string | null;
  status: ActionRequestStatus;
  attempts: number;
  /** The named skill that fired this action, when it was invoked through one (see enqueue). */
  skillName: string | null;
}

export interface EnqueueActionRequestInput {
  type: string;
  payload: Record<string, unknown>;
  workspaceId?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  idempotencyKey?: string | null;
  /**
   * The name of the skill that fired this action, when a routine invoked one by
   * name (e.g. a `notify` skill). Routing provenance, not domain data — kept out
   * of `payload` so a delivery resolver can key off it without parsing payload
   * shape. Actions a routine step emits directly (no named skill) leave this null.
   */
  skillName?: string | null;
}

interface ActionRequestRow {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  workspace_id: string | null;
  account_id: string | null;
  conversation_id: string | null;
  idempotency_key: string | null;
  status: string;
  attempts: number;
  skill_name: string | null;
}

const mapRecord = (row: ActionRequestRow): ActionRequestRecord => ({
  id: row.id,
  type: row.type,
  payload: row.payload ?? {},
  workspaceId: row.workspace_id,
  accountId: row.account_id,
  conversationId: row.conversation_id,
  idempotencyKey: row.idempotency_key,
  status: row.status as ActionRequestStatus,
  attempts: row.attempts,
  skillName: row.skill_name,
});

/**
 * The action outbox: routines enqueue fire-and-forget requests here (transactionally
 * with the turn) and a worker drains them. Enqueue is **idempotent** on
 * `idempotencyKey` so a retried turn does not double-emit. The repository owns the
 * row lifecycle (pending → dispatched/failed); routing to handlers is the dispatcher.
 */
export class ActionRequestRepository {
  constructor(private readonly db: Db) {}

  /** Idempotent enqueue; returns the row id (existing one when the key already exists). */
  async enqueue(input: EnqueueActionRequestInput): Promise<{ id: string; duplicate: boolean }> {
    const inserted = await this.db
      .insertInto("routine_action_requests")
      .values({
        type: input.type,
        payload: toJsonb(input.payload ?? {}),
        workspace_id: input.workspaceId ?? null,
        account_id: input.accountId ?? null,
        conversation_id: input.conversationId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        skill_name: input.skillName ?? null,
      })
      .onConflict((oc) => oc.column("idempotency_key").where("idempotency_key", "is not", null).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) {
      return { id: inserted.id, duplicate: false };
    }
    // Conflict on the idempotency key — return the existing row.
    const existing = await this.db
      .selectFrom("routine_action_requests")
      .select("id")
      .where("idempotency_key", "=", input.idempotencyKey!)
      .executeTakeFirstOrThrow();
    return { id: existing.id, duplicate: true };
  }

  /**
   * Atomically claim up to `limit` due requests for dispatch: each is moved
   * `pending` → `in_progress` (incrementing `attempts`) in a single `UPDATE … WHERE id
   * IN (SELECT … FOR UPDATE SKIP LOCKED)`, so two workers (or two overlapping drains)
   * never claim the same row — the cause of double-dispatch. Reclaims `in_progress`
   * rows whose lease (`leaseSeconds` since the last update) has expired, so a crashed
   * worker's row is retried rather than stranded. Pending rows are due only once
   * `next_attempt_at` (the retry backoff) has passed.
   */
  async claimPending(limit: number, leaseSeconds: number): Promise<ActionRequestRecord[]> {
    const rows = await this.db
      .updateTable("routine_action_requests")
      .set((eb) => ({ status: "in_progress", attempts: eb("attempts", "+", 1), updated_at: currentTimestamp() }))
      .where("id", "in", (eb) =>
        eb
          .selectFrom("routine_action_requests")
          .select("id")
          .where((due) =>
            due.or([
              due.and([
                due("status", "=", "pending"),
                due.or([due("next_attempt_at", "is", null), due("next_attempt_at", "<=", currentTimestamp())]),
              ]),
              due.and([due("status", "=", "in_progress"), due("updated_at", "<", nowMinusSeconds(leaseSeconds))]),
            ]),
          )
          .orderBy("created_at", "asc")
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .returning(actionRequestColumns)
      .execute();
    return rows.map((row) => mapRecord(row as ActionRequestRow));
  }

  /**
   * Mark a claimed request dispatched — but only *this* claim. The guard on `attempt`
   * (the `attempts` value `claimPending` returned) means a stale worker whose lease
   * expired and whose row was reclaimed by another worker (now a higher `attempts`)
   * cannot mark that newer claim dispatched. No-op when the claim was superseded.
   */
  async markDispatched(id: string, attempt: number): Promise<boolean> {
    const result = await this.db
      .updateTable("routine_action_requests")
      .set({ status: "dispatched", updated_at: currentTimestamp() })
      .where("id", "=", id)
      .where("attempts", "=", attempt)
      .where("status", "=", "in_progress")
      .execute();
    return result.some((entry) => Number(entry.numUpdatedRows) > 0);
  }

  /**
   * Record a dispatch failure for *this* claim (guarded on `attempt`, so a stale worker
   * can't reset a reclaimed row). Within the retry budget (`attempts < maxAttempts`) the
   * row returns to `pending` with a `next_attempt_at` backoff so a transient outage is
   * retried; once spent it becomes terminal `failed`. Returns which happened, or
   * `superseded` when the claim was already reclaimed by another worker.
   */
  async recordFailure(
    id: string,
    error: string,
    attempt: number,
    maxAttempts: number,
    retryBackoffSeconds: number,
  ): Promise<ActionFailureOutcome> {
    const row = await this.db
      .updateTable("routine_action_requests")
      .set((eb) => ({
        status: eb.case().when(eb("attempts", ">=", maxAttempts)).then(eb.val("failed")).else(eb.val("pending")).end(),
        next_attempt_at: eb
          .case()
          .when(eb("attempts", ">=", maxAttempts))
          .then(eb.val(null))
          .else(nowPlusSeconds(retryBackoffSeconds))
          .end(),
        last_error: error,
        updated_at: currentTimestamp(),
      }))
      .where("id", "=", id)
      .where("attempts", "=", attempt)
      .where("status", "=", "in_progress")
      .returning("status")
      .executeTakeFirst();
    if (!row) {
      return "superseded";
    }
    return row.status === "failed" ? "failed" : "retry";
  }

  /**
   * A point-in-time read of outbox backlog for observability (not used by the drain
   * path itself). Mirrors `DocumentProcessingJobRepository.getQueueSnapshot()`: counts
   * by state plus the oldest pending row's `created_at`, so an operator can alert on
   * both current depth and how long the oldest item has been waiting. Uses the same
   * `routine_action_requests_claimable_idx` partial index (`created_at WHERE status IN
   * ('pending','in_progress')`) the claim query already relies on.
   */
  async getPendingDepthSnapshot(): Promise<ActionOutboxDepthSnapshot> {
    const row = await this.db
      .selectFrom("routine_action_requests")
      .select((eb) => [
        eb.fn.countAll<number>().filterWhere("status", "=", "pending").as("pending_count"),
        eb.fn.countAll<number>().filterWhere("status", "=", "in_progress").as("in_progress_count"),
        eb.fn.min<Date>("created_at").filterWhere("status", "=", "pending").as("oldest_pending_created_at"),
      ])
      .where("status", "in", ["pending", "in_progress"])
      .executeTakeFirst();

    return {
      pendingCount: Number(row?.pending_count ?? 0),
      inProgressCount: Number(row?.in_progress_count ?? 0),
      oldestPendingCreatedAt: row?.oldest_pending_created_at ? new Date(row.oldest_pending_created_at) : null,
    };
  }
}

const actionRequestColumns = [
  "id",
  "type",
  "payload",
  "workspace_id",
  "account_id",
  "conversation_id",
  "idempotency_key",
  "status",
  "attempts",
  "skill_name",
] as const;
