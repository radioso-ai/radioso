import type { Database } from "../../shared/infra/database.js";

export type ActionRequestStatus = "pending" | "dispatched" | "failed";

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

  /** Claim the oldest pending requests for dispatch. */
  async claimPending(limit: number): Promise<ActionRequestRecord[]> {
    const rows = await this.database.query<ActionRequestRow>(
      `SELECT id, type, payload, workspace_id, account_id, conversation_id, idempotency_key, status, attempts
         FROM routine_action_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map(mapRecord);
  }

  async markDispatched(id: string): Promise<void> {
    await this.database.execute(
      `UPDATE routine_action_requests SET status = 'dispatched', updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.database.execute(
      `UPDATE routine_action_requests
          SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id, error],
    );
  }
}
