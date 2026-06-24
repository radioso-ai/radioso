import { sql } from "kysely";

import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

// A gate is `pending` until an operator picks a choice, then `resolved` (the routine
// branches on the chosen option id, so the status is bookkeeping, not the decision), or
// `cancelled` if the conversation ends the gate without a choice. The legacy `approved`/
// `rejected` values predate multi-way gates and are retained only so historical rows read.
export type PendingDecisionStatus = "pending" | "resolved" | "approved" | "rejected" | "cancelled";

export interface PendingDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PendingDecisionRecord {
  id: string;
  handle: string;
  conversationId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  routineId: string;
  stepId: string;
  reason: string | null;
  options: PendingDecisionOption[];
  deciderScope: Record<string, unknown>;
  contentHash: string;
  status: PendingDecisionStatus;
  decision: unknown | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  deadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingDecisionCreateInput {
  handle: string;
  conversationId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  routineId: string;
  stepId: string;
  reason?: string | null;
  options: PendingDecisionOption[];
  deciderScope: Record<string, unknown>;
  contentHash: string;
  deadline?: Date | null;
}

export interface PendingDecisionResolveInput {
  handle: string;
  status: PendingDecisionStatus;
  decision: unknown;
  decidedBy: string | null;
  contentHash: string;
}

export interface PendingDecisionListInput {
  workspaceId: string;
}

interface PendingDecisionRow {
  id: string;
  handle: string;
  conversation_id: string;
  session_id: string;
  workspace_id: string;
  agent_id: string;
  routine_id: string;
  step_id: string;
  reason: string | null;
  options: unknown;
  decider_scope: unknown;
  content_hash: string;
  status: string;
  decision: unknown | null;
  decided_by: string | null;
  decided_at: Date | null;
  deadline: Date | null;
  created_at: Date;
  updated_at: Date;
}

// The full pending_decisions projection. Kept as a single `sql` fragment spliced into each
// SELECT/RETURNING so the column list (and therefore `mapRecord`) stays identical to the
// raw-SQL original; the builder's `.selectAll()` would not guarantee column ordering parity
// the way an explicit list does.
const pendingDecisionColumns = sql`
  id,
  handle,
  conversation_id,
  session_id,
  workspace_id,
  agent_id,
  routine_id,
  step_id,
  reason,
  options,
  decider_scope,
  content_hash,
  status,
  decision,
  decided_by,
  decided_at,
  deadline,
  created_at,
  updated_at
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOptions = (value: unknown): PendingDecisionOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((option): option is PendingDecisionOption => {
    if (!isRecord(option)) {
      return false;
    }
    return typeof option.id === "string" && typeof option.label === "string";
  });
};

const parseDeciderScope = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    return {};
  }
  return value;
};

const mapRecord = (row: PendingDecisionRow): PendingDecisionRecord => ({
  id: row.id,
  handle: row.handle,
  conversationId: row.conversation_id,
  sessionId: row.session_id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  routineId: row.routine_id,
  stepId: row.step_id,
  reason: row.reason,
  options: parseOptions(row.options),
  deciderScope: parseDeciderScope(row.decider_scope),
  contentHash: row.content_hash,
  status: row.status as PendingDecisionStatus,
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  deadline: row.deadline,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class PendingDecisionRepository {
  constructor(private readonly db: Db) {}

  async create(input: PendingDecisionCreateInput): Promise<PendingDecisionRecord> {
    const result = await sql<PendingDecisionRow>`
      INSERT INTO pending_decisions (
        handle,
        conversation_id,
        session_id,
        workspace_id,
        agent_id,
        routine_id,
        step_id,
        reason,
        options,
        decider_scope,
        content_hash,
        deadline
      )
      VALUES (
        ${input.handle},
        ${input.conversationId},
        ${input.sessionId},
        ${input.workspaceId},
        ${input.agentId},
        ${input.routineId},
        ${input.stepId},
        ${input.reason ?? null},
        ${toJsonb(input.options)},
        ${toJsonb(input.deciderScope)},
        ${input.contentHash},
        ${input.deadline ?? null}
      )
      RETURNING ${pendingDecisionColumns}
    `.execute(this.db);

    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected created pending decision");
    }
    return mapRecord(row);
  }

  async loadByHandle(handle: string): Promise<PendingDecisionRecord | null> {
    const result = await sql<PendingDecisionRow>`
      SELECT ${pendingDecisionColumns}
        FROM pending_decisions
       WHERE handle = ${handle}
    `.execute(this.db);

    const row = result.rows[0];
    return row ? mapRecord(row) : null;
  }

  // `db` lets the caller run the CAS inside an open transaction (the turn-commit
  // fence) so the decision flip, the routine resume, and the assistant-turn persistence
  // all commit or roll back together. A crash before COMMIT leaves the row `pending`, so
  // a retried resolve re-runs cleanly (crash-safe; spec 091 review finding P1(b)).
  async resolve(
    input: PendingDecisionResolveInput,
    db: Db = this.db,
  ): Promise<PendingDecisionRecord | null> {
    const result = await sql<PendingDecisionRow>`
      UPDATE pending_decisions
         SET status = ${input.status},
             decision = ${toJsonb(input.decision)},
             decided_by = ${input.decidedBy},
             decided_at = ${currentTimestamp()},
             updated_at = ${currentTimestamp()}
       WHERE handle = ${input.handle}
         AND status = 'pending'
         AND content_hash = ${input.contentHash}
      RETURNING ${pendingDecisionColumns}
    `.execute(db);

    const row = result.rows[0];
    return row ? mapRecord(row) : null;
  }

  async resolveInTransaction<T>(
    input: PendingDecisionResolveInput,
    onResolved: (
      record: PendingDecisionRecord,
      db: Db,
    ) => Promise<T>,
  ): Promise<T | null> {
    return this.db.transaction().execute(async (trx) => {
      const resolved = await this.resolve(input, trx);
      if (!resolved) {
        return null;
      }
      return onResolved(resolved, trx);
    });
  }

  async listPending(input: PendingDecisionListInput): Promise<PendingDecisionRecord[]> {
    const result = await sql<PendingDecisionRow>`
      SELECT ${pendingDecisionColumns}
        FROM pending_decisions
       WHERE workspace_id = ${input.workspaceId}
         AND status = 'pending'
       ORDER BY created_at DESC
    `.execute(this.db);

    return result.rows.map(mapRecord);
  }
}
