import { randomUUID } from "node:crypto";

import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
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
import type { InternalAgentConfig } from "../../agents/public.js";
import type { RetrievalSettingsSnapshot } from "../../settings/contracts/retrieval.js";

type SnapshotRow = {
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
  original_agent_config: unknown;
  source_agent_id: string | null;
  captured_at: Date | string;
  captured_by: string | null;
};

type CaseRow = {
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

type RunRow = {
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
  originalAgentConfig: asObject<InternalAgentConfig | null>(row.original_agent_config, null),
  sourceAgentId: row.source_agent_id,
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
  originalAgentConfig: InternalAgentConfig | null;
  sourceAgentId: string | null;
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

const snapshotColumns = [
  "id",
  "workspace_id",
  "source_conversation_id",
  "source_message_id",
  "fidelity",
  "messages",
  "original_instruction_block",
  "original_model_id",
  "original_retrieval_settings",
  "original_retrieval_result",
  "original_agent",
  "original_agent_config",
  "source_agent_id",
  "captured_at",
  "captured_by",
] as const;

const caseColumns = [
  "id",
  "workspace_id",
  "snapshot_id",
  "name",
  "assertions",
  "status",
  "last_run_id",
  "created_at",
  "updated_at",
] as const;

const runColumns = [
  "id",
  "workspace_id",
  "snapshot_id",
  "case_id",
  "mode",
  "overrides",
  "resolved_config",
  "observed_output",
  "assertion_verdicts",
  "status",
  "outcome_reason",
  "started_at",
  "completed_at",
] as const;

export class EvalRepository implements EvalRepositoryPort {
  constructor(private readonly db: Db) {}

  async createSnapshot(input: CreateSnapshotInput): Promise<EvalSnapshot> {
    const row = await this.db
      .insertInto("eval_snapshots")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        source_conversation_id: input.sourceConversationId,
        source_message_id: input.sourceMessageId,
        fidelity: input.fidelity,
        messages: toJsonb(input.messages),
        original_instruction_block:
          input.originalInstructionBlock !== null ? toJsonb(input.originalInstructionBlock) : null,
        original_model_id: input.originalModelId,
        original_retrieval_settings: input.originalRetrievalSettings
          ? toJsonb(input.originalRetrievalSettings)
          : null,
        original_retrieval_result: input.originalRetrievalResult
          ? toJsonb(input.originalRetrievalResult)
          : null,
        original_agent: input.originalAgent ? toJsonb(input.originalAgent) : null,
        original_agent_config: input.originalAgentConfig ? toJsonb(input.originalAgentConfig) : null,
        source_agent_id: input.sourceAgentId,
        captured_by: input.capturedBy,
      })
      .returning(snapshotColumns)
      .executeTakeFirstOrThrow();
    return mapSnapshot(row as SnapshotRow);
  }

  async findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null> {
    const row = await this.db
      .selectFrom("eval_snapshots")
      .select(snapshotColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .limit(1)
      .executeTakeFirst();
    return row ? mapSnapshot(row as SnapshotRow) : null;
  }

  async createCase(input: CreateCaseInput): Promise<EvalCase> {
    const row = await this.db
      .insertInto("eval_cases")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        snapshot_id: input.snapshotId,
        name: input.name,
        assertions: toJsonb(input.assertions),
        status: "pending",
      })
      .returning(caseColumns)
      .executeTakeFirstOrThrow();
    return mapCase(row as CaseRow);
  }

  async findCase(workspaceId: string, id: string): Promise<EvalCase | null> {
    const row = await this.db
      .selectFrom("eval_cases")
      .select(caseColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .limit(1)
      .executeTakeFirst();
    return row ? mapCase(row as CaseRow) : null;
  }

  async listCases(workspaceId: string): Promise<EvalCase[]> {
    const rows = await this.db
      .selectFrom("eval_cases")
      .select(caseColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map((row) => mapCase(row as CaseRow));
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
    const row = await this.db
      .updateTable("eval_cases")
      .set({
        assertions: toJsonb(assertions),
        status: "pending",
        last_run_id: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", caseId)
      .returning(caseColumns)
      .executeTakeFirstOrThrow();
    return mapCase(row as CaseRow);
  }

  async updateCaseName(workspaceId: string, caseId: string, name: string): Promise<EvalCase> {
    const row = await this.db
      .updateTable("eval_cases")
      .set({
        name,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", caseId)
      .returning(caseColumns)
      .executeTakeFirstOrThrow();
    return mapCase(row as CaseRow);
  }

  async createRun(input: CreateRunInput): Promise<EvalRun> {
    const row = await this.db
      .insertInto("eval_runs")
      .values({
        id: input.id ?? randomUUID(),
        workspace_id: input.workspaceId,
        snapshot_id: input.snapshotId,
        case_id: input.caseId,
        mode: input.mode,
        overrides: toJsonb(input.overrides),
        resolved_config: toJsonb(input.resolvedConfig),
        observed_output: toJsonb(input.observedOutput),
        assertion_verdicts: toJsonb(input.assertionVerdicts),
        status: input.status,
        outcome_reason: input.outcomeReason,
        completed_at: input.completedAt,
      })
      .returning(runColumns)
      .executeTakeFirstOrThrow();
    return mapRun(row as RunRow);
  }

  async listRunsForCase(workspaceId: string, caseId: string): Promise<EvalRun[]> {
    const rows = await this.db
      .selectFrom("eval_runs")
      .select(runColumns)
      .where("workspace_id", "=", workspaceId)
      .where("case_id", "=", caseId)
      .orderBy("started_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map((row) => mapRun(row as RunRow));
  }

  async updateCaseLastRun(
    workspaceId: string,
    caseId: string,
    lastRunId: string,
    status: EvalCaseStatus,
  ): Promise<EvalCase> {
    const row = await this.db
      .updateTable("eval_cases")
      .set({
        last_run_id: lastRunId,
        status,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", caseId)
      .returning(caseColumns)
      .executeTakeFirstOrThrow();
    return mapCase(row as CaseRow);
  }
}
