import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { ApplicationDatabasePort } from "../../../app/composition/applicationModule.js";
import type {
  AssertionVerdict,
  EvalAssertion,
  EvalCase,
  EvalCaseStatus,
  EvalRun,
  EvalRunMode,
  EvalRunObservedOutput,
  EvalRunOverrides,
  EvalRunResolvedConfig,
  EvalRunStatus,
  EvalSnapshot,
  EvalSnapshotFidelity,
  EvalSnapshotMessage,
  EvalSnapshotOriginalRetrievalChunk,
} from "../domain/types.js";
import type { AgentSnapshot } from "../../agents/public.js";
import type { RetrievalSettingsSnapshot } from "../../settings/contracts/retrieval.js";

type SnapshotRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  source_conversation_id: string;
  source_message_id: string | null;
  fidelity: EvalSnapshotFidelity;
  messages: unknown;
  original_instruction_block: unknown;
  original_model_id: string | null;
  original_retrieval_settings: unknown;
  original_retrieval_result: unknown;
  original_agent: unknown;
  captured_at: Date | string;
  captured_by: string | null;
};

type CaseRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  snapshot_id: string;
  name: string;
  assertions: unknown;
  status: EvalCaseStatus;
  last_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RunRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  snapshot_id: string;
  case_id: string | null;
  mode: EvalRunMode;
  overrides: unknown;
  resolved_config: unknown;
  observed_output: unknown;
  assertion_verdicts: unknown;
  status: EvalRunStatus;
  outcome_reason: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
};

const isoDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const asObject = <T>(value: unknown, fallback: T): T => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as T;
  }
  return fallback;
};

const mapSnapshot = (row: SnapshotRow): EvalSnapshot => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sourceConversationId: row.source_conversation_id,
  sourceMessageId: row.source_message_id,
  fidelity: row.fidelity,
  messages: Array.isArray(row.messages) ? (row.messages as EvalSnapshotMessage[]) : [],
  originalInstructionBlock:
    typeof row.original_instruction_block === "string"
      ? row.original_instruction_block
      : row.original_instruction_block && typeof row.original_instruction_block === "object"
        ? JSON.stringify(row.original_instruction_block)
        : null,
  originalModelId: row.original_model_id,
  originalRetrievalSettings: asObject<RetrievalSettingsSnapshot | null>(
    row.original_retrieval_settings,
    null,
  ),
  originalRetrievalResult: Array.isArray(row.original_retrieval_result)
    ? (row.original_retrieval_result as EvalSnapshotOriginalRetrievalChunk[])
    : null,
  originalAgent: asObject<AgentSnapshot | null>(row.original_agent, null),
  capturedAt: isoDate(row.captured_at),
  capturedBy: row.captured_by,
});

const mapCase = (row: CaseRow): EvalCase => ({
  id: row.id,
  workspaceId: row.workspace_id,
  snapshotId: row.snapshot_id,
  name: row.name,
  assertions: Array.isArray(row.assertions) ? (row.assertions as EvalAssertion[]) : [],
  status: row.status,
  lastRunId: row.last_run_id,
  createdAt: isoDate(row.created_at),
  updatedAt: isoDate(row.updated_at),
});

const mapRun = (row: RunRow): EvalRun => ({
  id: row.id,
  workspaceId: row.workspace_id,
  snapshotId: row.snapshot_id,
  caseId: row.case_id,
  mode: row.mode,
  overrides: asObject<EvalRunOverrides>(row.overrides, {}),
  resolvedConfig: asObject<EvalRunResolvedConfig>(row.resolved_config, {}),
  observedOutput: asObject<EvalRunObservedOutput>(row.observed_output, { retrievedChunks: [] }),
  assertionVerdicts: Array.isArray(row.assertion_verdicts)
    ? (row.assertion_verdicts as AssertionVerdict[])
    : [],
  status: row.status,
  outcomeReason: row.outcome_reason,
  startedAt: isoDate(row.started_at),
  completedAt: row.completed_at ? isoDate(row.completed_at) : null,
});

export interface CreateSnapshotInput {
  workspaceId: string;
  sourceConversationId: string;
  sourceMessageId: string | null;
  fidelity: EvalSnapshotFidelity;
  messages: EvalSnapshotMessage[];
  originalInstructionBlock: string | null;
  originalModelId: string | null;
  originalRetrievalSettings: RetrievalSettingsSnapshot | null;
  originalRetrievalResult: EvalSnapshotOriginalRetrievalChunk[] | null;
  originalAgent: AgentSnapshot | null;
  capturedBy: string | null;
}

export interface CreateCaseInput {
  workspaceId: string;
  snapshotId: string;
  name: string;
  assertions: EvalAssertion[];
}

export interface CreateRunInput {
  /** Optional pre-allocated UUID — pass when the caller needs to reference
   * the run id from external events (e.g. usage metering) recorded before
   * the row is inserted. When omitted the repository generates a fresh UUID. */
  id?: string;
  workspaceId: string;
  snapshotId: string;
  caseId: string | null;
  mode: EvalRunMode;
  overrides: EvalRunOverrides;
  resolvedConfig: EvalRunResolvedConfig;
  observedOutput: EvalRunObservedOutput;
  assertionVerdicts: AssertionVerdict[];
  status: EvalRunStatus;
  outcomeReason: string | null;
  completedAt: Date;
}

export interface EvalRepositoryPort {
  createSnapshot(input: CreateSnapshotInput): Promise<EvalSnapshot>;
  findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null>;
  createCase(input: CreateCaseInput): Promise<EvalCase>;
  findCase(workspaceId: string, id: string): Promise<EvalCase | null>;
  listCases(workspaceId: string): Promise<EvalCase[]>;
  updateCaseAssertions(
    workspaceId: string,
    caseId: string,
    assertions: EvalAssertion[],
  ): Promise<EvalCase>;
  updateCaseName(workspaceId: string, caseId: string, name: string): Promise<EvalCase>;
  createRun(input: CreateRunInput): Promise<EvalRun>;
  listRunsForCase(workspaceId: string, caseId: string): Promise<EvalRun[]>;
  updateCaseLastRun(
    workspaceId: string,
    caseId: string,
    lastRunId: string,
    status: EvalCaseStatus,
  ): Promise<EvalCase>;
}

export class EvalRepository implements EvalRepositoryPort {
  constructor(private readonly database: ApplicationDatabasePort) {}

  async createSnapshot(input: CreateSnapshotInput): Promise<EvalSnapshot> {
    const [row] = await this.database.query<SnapshotRow>(
      `INSERT INTO eval_snapshots (
         id, workspace_id, source_conversation_id, source_message_id, fidelity,
         messages, original_instruction_block, original_model_id,
         original_retrieval_settings, original_retrieval_result,
         original_agent, captured_by
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
       RETURNING id, workspace_id, source_conversation_id, source_message_id, fidelity,
                 messages, original_instruction_block, original_model_id,
                 original_retrieval_settings, original_retrieval_result,
                 original_agent, captured_at, captured_by`,
      [
        randomUUID(),
        input.workspaceId,
        input.sourceConversationId,
        input.sourceMessageId,
        input.fidelity,
        JSON.stringify(input.messages),
        input.originalInstructionBlock !== null
          ? JSON.stringify(input.originalInstructionBlock)
          : null,
        input.originalModelId,
        input.originalRetrievalSettings ? JSON.stringify(input.originalRetrievalSettings) : null,
        input.originalRetrievalResult ? JSON.stringify(input.originalRetrievalResult) : null,
        input.originalAgent ? JSON.stringify(input.originalAgent) : null,
        input.capturedBy,
      ],
    );
    return mapSnapshot(row!);
  }

  async findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null> {
    const rows = await this.database.query<SnapshotRow>(
      `SELECT id, workspace_id, source_conversation_id, source_message_id, fidelity,
              messages, original_instruction_block, original_model_id,
              original_retrieval_settings, original_retrieval_result,
              original_agent, captured_at, captured_by
       FROM eval_snapshots
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [workspaceId, id],
    );
    return rows[0] ? mapSnapshot(rows[0]) : null;
  }

  async createCase(input: CreateCaseInput): Promise<EvalCase> {
    const [row] = await this.database.query<CaseRow>(
      `INSERT INTO eval_cases (
         id, workspace_id, snapshot_id, name, assertions, status
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
       RETURNING id, workspace_id, snapshot_id, name, assertions, status,
                 last_run_id, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        input.snapshotId,
        input.name,
        JSON.stringify(input.assertions),
      ],
    );
    return mapCase(row!);
  }

  async findCase(workspaceId: string, id: string): Promise<EvalCase | null> {
    const rows = await this.database.query<CaseRow>(
      `SELECT id, workspace_id, snapshot_id, name, assertions, status,
              last_run_id, created_at, updated_at
       FROM eval_cases
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [workspaceId, id],
    );
    return rows[0] ? mapCase(rows[0]) : null;
  }

  async listCases(workspaceId: string): Promise<EvalCase[]> {
    const rows = await this.database.query<CaseRow>(
      `SELECT id, workspace_id, snapshot_id, name, assertions, status,
              last_run_id, created_at, updated_at
       FROM eval_cases
       WHERE workspace_id = $1
       ORDER BY updated_at DESC, id DESC`,
      [workspaceId],
    );
    return rows.map(mapCase);
  }

  async updateCaseAssertions(
    workspaceId: string,
    caseId: string,
    assertions: EvalAssertion[],
  ): Promise<EvalCase> {
    // Editing assertions changes the meaning of all prior verdicts, so any
    // run history is no longer comparable. Reset case status to 'pending'
    // until a fresh run completes. The runs themselves are NOT deleted —
    // they remain as historical records of what the case used to assert.
    const [row] = await this.database.query<CaseRow>(
      `UPDATE eval_cases
         SET assertions = $3::jsonb,
             status = 'pending',
             last_run_id = NULL,
             updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING id, workspace_id, snapshot_id, name, assertions, status,
                 last_run_id, created_at, updated_at`,
      [workspaceId, caseId, JSON.stringify(assertions)],
    );
    return mapCase(row!);
  }

  async updateCaseName(workspaceId: string, caseId: string, name: string): Promise<EvalCase> {
    const [row] = await this.database.query<CaseRow>(
      `UPDATE eval_cases
         SET name = $3,
             updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING id, workspace_id, snapshot_id, name, assertions, status,
                 last_run_id, created_at, updated_at`,
      [workspaceId, caseId, name],
    );
    return mapCase(row!);
  }

  async createRun(input: CreateRunInput): Promise<EvalRun> {
    const [row] = await this.database.query<RunRow>(
      `INSERT INTO eval_runs (
         id, workspace_id, snapshot_id, case_id, mode,
         overrides, resolved_config, observed_output, assertion_verdicts,
         status, outcome_reason, completed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
       RETURNING id, workspace_id, snapshot_id, case_id, mode,
                 overrides, resolved_config, observed_output, assertion_verdicts,
                 status, outcome_reason, started_at, completed_at`,
      [
        input.id ?? randomUUID(),
        input.workspaceId,
        input.snapshotId,
        input.caseId,
        input.mode,
        JSON.stringify(input.overrides),
        JSON.stringify(input.resolvedConfig),
        JSON.stringify(input.observedOutput),
        JSON.stringify(input.assertionVerdicts),
        input.status,
        input.outcomeReason,
        input.completedAt,
      ],
    );
    return mapRun(row!);
  }

  async listRunsForCase(workspaceId: string, caseId: string): Promise<EvalRun[]> {
    const rows = await this.database.query<RunRow>(
      `SELECT id, workspace_id, snapshot_id, case_id, mode,
              overrides, resolved_config, observed_output, assertion_verdicts,
              status, outcome_reason, started_at, completed_at
       FROM eval_runs
       WHERE workspace_id = $1 AND case_id = $2
       ORDER BY started_at DESC, id DESC`,
      [workspaceId, caseId],
    );
    return rows.map(mapRun);
  }

  async updateCaseLastRun(
    workspaceId: string,
    caseId: string,
    lastRunId: string,
    status: EvalCaseStatus,
  ): Promise<EvalCase> {
    const [row] = await this.database.query<CaseRow>(
      `UPDATE eval_cases
         SET last_run_id = $3,
             status = $4,
             updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING id, workspace_id, snapshot_id, name, assertions, status,
                 last_run_id, created_at, updated_at`,
      [workspaceId, caseId, lastRunId, status],
    );
    return mapCase(row!);
  }
}
