import type { Database } from "../../shared/infra/database.js";

export type PendingDecisionStatus = "pending" | "approved" | "rejected" | "cancelled";
export type PendingDecisionOutcome = "approved" | "rejected";

export interface PendingDecisionOption {
  id: string;
  label: string;
  description?: string;
  payload?: unknown;
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
  outcome: PendingDecisionOutcome;
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

const pendingDecisionColumns = `
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
  constructor(private readonly database: Database) {}

  async create(input: PendingDecisionCreateInput): Promise<PendingDecisionRecord> {
    const row = await this.database.queryOne<PendingDecisionRow>(
      `INSERT INTO pending_decisions (
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
        RETURNING ${pendingDecisionColumns}`,
      [
        input.handle,
        input.conversationId,
        input.sessionId,
        input.workspaceId,
        input.agentId,
        input.routineId,
        input.stepId,
        input.reason ?? null,
        JSON.stringify(input.options),
        JSON.stringify(input.deciderScope),
        input.contentHash,
        input.deadline ?? null,
      ],
    );

    return mapRecord(row);
  }

  async loadByHandle(handle: string): Promise<PendingDecisionRecord | null> {
    const row = await this.database.queryOptional<PendingDecisionRow>(
      `SELECT ${pendingDecisionColumns}
         FROM pending_decisions
        WHERE handle = $1`,
      [handle],
    );

    return row ? mapRecord(row) : null;
  }

  // `executor` lets the caller run the CAS inside an open transaction (the turn-commit
  // fence) so the decision flip, the routine resume, and the assistant-turn persistence
  // all commit or roll back together. A crash before COMMIT leaves the row `pending`, so
  // a retried resolve re-runs cleanly (crash-safe; spec 091 review finding P1(b)).
  async resolve(
    input: PendingDecisionResolveInput,
    executor: Pick<Database, "queryOptional"> = this.database,
  ): Promise<PendingDecisionRecord | null> {
    const row = await executor.queryOptional<PendingDecisionRow>(
      `UPDATE pending_decisions
          SET status = $2,
              decision = $3::jsonb,
              decided_by = $4,
              decided_at = now(),
              updated_at = now()
        WHERE handle = $1
          AND status = 'pending'
          AND content_hash = $5
        RETURNING ${pendingDecisionColumns}`,
      [
        input.handle,
        input.outcome,
        JSON.stringify(input.decision),
        input.decidedBy,
        input.contentHash,
      ],
    );

    return row ? mapRecord(row) : null;
  }

  async listPending(input: PendingDecisionListInput): Promise<PendingDecisionRecord[]> {
    const rows = await this.database.query<PendingDecisionRow>(
      `SELECT ${pendingDecisionColumns}
         FROM pending_decisions
        WHERE workspace_id = $1
          AND status = 'pending'
        ORDER BY created_at DESC`,
      [input.workspaceId],
    );

    return rows.map(mapRecord);
  }
}
