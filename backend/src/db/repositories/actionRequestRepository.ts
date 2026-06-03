import type { Database } from "../../shared/infra/database.js";

export type ActionRequestStatus = "pending" | "in_progress" | "dispatched" | "failed";

/**
 * The outcome of recording a dispatch failure. `superseded` means this worker's claim
 * was already reclaimed by another (its lease expired), so its result was ignored.
 */
export type ActionFailureOutcome = "retry" | "failed" | "superseded";

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
}

export interface EnqueueActionRequestInput {
  type: string;
  payload: Record<string, unknown>;
  workspaceId?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  idempotencyKey?: string | null;
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
});

/**
 * The action outbox: routines enqueue fire-and-forget requests here (transactionally
 * with the turn) and a worker drains them. Enqueue is **idempotent** on
 * `idempotencyKey` so a retried turn does not double-emit. The repository owns the
 * row lifecycle (pending → dispatched/failed); routing to handlers is the dispatcher.
 */
export class ActionRequestRepository {
  constructor(private readonly database: Database) {}

  /** Idempotent enqueue; returns the row id (existing one when the key already exists). */
  async enqueue(input: EnqueueActionRequestInput): Promise<{ id: string; duplicate: boolean }> {
    const inserted = await this.database.queryOptional<{ id: string }>(
      `INSERT INTO routine_action_requests (type, payload, workspace_id, account_id, conversation_id, idempotency_key)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.type,
        JSON.stringify(input.payload ?? {}),
        input.workspaceId ?? null,
        input.accountId ?? null,
        input.conversationId ?? null,
        input.idempotencyKey ?? null,
      ],
    );
    if (inserted) {
      return { id: inserted.id, duplicate: false };
    }
    // Conflict on the idempotency key — return the existing row.
    const existing = await this.database.queryOne<{ id: string }>(
      `SELECT id FROM routine_action_requests WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
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
    const rows = await this.database.query<ActionRequestRow>(
      `UPDATE routine_action_requests
          SET status = 'in_progress', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id
            FROM routine_action_requests
           WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
              OR (status = 'in_progress' AND updated_at < now() - make_interval(secs => $2))
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, payload, workspace_id, account_id, conversation_id, idempotency_key, status, attempts`,
      [limit, leaseSeconds],
    );
    return rows.map(mapRecord);
  }

  /**
   * Mark a claimed request dispatched — but only *this* claim. The guard on `attempt`
   * (the `attempts` value `claimPending` returned) means a stale worker whose lease
   * expired and whose row was reclaimed by another worker (now a higher `attempts`)
   * cannot mark that newer claim dispatched. No-op when the claim was superseded.
   */
  async markDispatched(id: string, attempt: number): Promise<void> {
    await this.database.execute(
      `UPDATE routine_action_requests
          SET status = 'dispatched', updated_at = now()
        WHERE id = $1 AND attempts = $2 AND status = 'in_progress'`,
      [id, attempt],
    );
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
    const row = await this.database.queryOptional<{ status: string }>(
      `UPDATE routine_action_requests
          SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END,
              next_attempt_at = CASE WHEN attempts >= $4 THEN NULL ELSE now() + make_interval(secs => $5) END,
              last_error = $2,
              updated_at = now()
        WHERE id = $1 AND attempts = $3 AND status = 'in_progress'
        RETURNING status`,
      [id, error, attempt, maxAttempts, retryBackoffSeconds],
    );
    if (!row) {
      return "superseded";
    }
    return row.status === "failed" ? "failed" : "retry";
  }
}
