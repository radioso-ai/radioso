import { randomUUID } from "node:crypto";

import { parseAgentRevisionSnapshot, type AgentSnapshot, type InternalAgentConfig } from "../../agents/public.js";
import type { FrozenTestValue } from "../../context-variables/public.js";
import type { RetrievalSettingsSnapshot } from "../../settings/contracts/retrieval.js";
import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import type {
  EvalAssertion,
  EvalCase,
  EvalCaseStatus,
  EvalSnapshot,
  EvalSnapshotFidelity,
  EvalSnapshotMessage,
  EvalSnapshotOriginalRetrievalChunk,
  EvalSnapshotReplayTarget,
  EvalSnapshotTestExecutionReplay,
} from "../domain/types.js";

type SnapshotRow = {
  id: string;
  workspace_id: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  replay_target: unknown;
  fidelity: EvalSnapshotFidelity;
  messages: unknown;
  original_instruction_block: unknown;
  original_model_id: string | null;
  original_retrieval_settings: unknown;
  original_retrieval_result: unknown;
  original_agent: unknown;
  original_agent_config: unknown;
  test_execution_replay: unknown;
  source_agent_id: string | null;
  original_routine_state: unknown;
  original_conversation_summary: unknown;
  captured_at: Date | string;
  captured_by: string | null;
};

export type CaseRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string;
  name: string;
  assertions: unknown;
  execution_mode: TurnExecutionMode;
  status: EvalCaseStatus;
  last_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export interface CreateSnapshotInput {
  workspaceId: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  replayTarget: EvalSnapshotReplayTarget | null;
  fidelity: EvalSnapshotFidelity;
  messages: EvalSnapshotMessage[];
  originalInstructionBlock: string | null;
  originalModelId: string | null;
  originalRetrievalSettings: RetrievalSettingsSnapshot | null;
  originalRetrievalResult: EvalSnapshotOriginalRetrievalChunk[] | null;
  originalAgent: AgentSnapshot | null;
  originalAgentConfig: InternalAgentConfig | null;
  testExecutionReplay?: EvalSnapshotTestExecutionReplay;
  sourceAgentId: string | null;
  originalRoutineState: EvalSnapshot["originalRoutineState"];
  /** Rolling conversation summary (#866) as of capture time; absent for short conversations. */
  conversationSummary?: string;
  capturedBy: string | null;
}

export interface CreateCaseInput {
  workspaceId: string;
  snapshotId: string;
  name: string;
  assertions: EvalAssertion[];
  executionMode?: TurnExecutionMode;
}

export const isoDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const asObject = <T>(value: unknown, fallback: T): T => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as T;
  }
  return fallback;
};

const snapshotColumns = [
  "id",
  "workspace_id",
  "source_conversation_id",
  "source_message_id",
  "replay_target",
  "fidelity",
  "messages",
  "original_instruction_block",
  "original_model_id",
  "original_retrieval_settings",
  "original_retrieval_result",
  "original_agent",
  "original_agent_config",
  "test_execution_replay",
  "source_agent_id",
  "original_routine_state",
  "original_conversation_summary",
  "captured_at",
  "captured_by",
] as const;

const asTestExecutionReplay = (value: unknown): EvalSnapshotTestExecutionReplay | undefined => {
  const record = asObject<Record<string, unknown> | null>(value, null);
  const revision = asObject<Record<string, unknown> | null>(record?.revision, null);
  if (!revision || typeof revision.id !== "string" || typeof revision.sourceDraftGeneration !== "number") {
    return undefined;
  }
  try {
    const date = (input: unknown): Date | null =>
      typeof input === "string" || typeof input === "number" ? new Date(input) : null;
    const createdAt = date(revision.createdAt);
    const publishedAt = revision.publishedAt === null ? null : date(revision.publishedAt);
    if (!createdAt) return undefined;
    if (
      Number.isNaN(createdAt.getTime())
      || (revision.publishedAt !== null && !publishedAt)
      || (publishedAt && Number.isNaN(publishedAt.getTime()))
    ) return undefined;
    return {
      revision: {
        id: revision.id,
        snapshot: parseAgentRevisionSnapshot(revision.snapshot),
        sourceDraftGeneration: revision.sourceDraftGeneration,
        sourceBasePublishedRevisionId: typeof revision.sourceBasePublishedRevisionId === "string"
          ? revision.sourceBasePublishedRevisionId
          : null,
        createdAt,
        publishedAt,
        publishedVersion: typeof revision.publishedVersion === "number" ? revision.publishedVersion : null,
      },
      testValues: Array.isArray(record.testValues) ? record.testValues as FrozenTestValue[] : [],
    };
  } catch {
    return undefined;
  }
};

export const caseColumns = [
  "id",
  "workspace_id",
  "snapshot_id",
  "name",
  "assertions",
  "execution_mode",
  "status",
  "last_run_id",
  "created_at",
  "updated_at",
] as const;

const mapSnapshot = (row: SnapshotRow): EvalSnapshot => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sourceConversationId: row.source_conversation_id,
  sourceMessageId: row.source_message_id,
  replayTarget: asObject<EvalSnapshotReplayTarget | null>(row.replay_target, null),
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
  ...(asTestExecutionReplay(row.test_execution_replay)
    ? { testExecutionReplay: asTestExecutionReplay(row.test_execution_replay) }
    : {}),
  sourceAgentId: row.source_agent_id,
  originalRoutineState: asObject<EvalSnapshot["originalRoutineState"]>(
    row.original_routine_state,
    null,
  ),
  ...(typeof row.original_conversation_summary === "string"
    && row.original_conversation_summary.length > 0
    ? { conversationSummary: row.original_conversation_summary }
    : {}),
  capturedAt: isoDate(row.captured_at),
  capturedBy: row.captured_by,
});

export const mapCase = (row: CaseRow): EvalCase => ({
  id: row.id,
  workspaceId: row.workspace_id,
  snapshotId: row.snapshot_id,
  name: row.name,
  assertions: Array.isArray(row.assertions) ? (row.assertions as EvalAssertion[]) : [],
  executionMode: row.execution_mode,
  status: row.status,
  lastRunId: row.last_run_id,
  createdAt: isoDate(row.created_at),
  updatedAt: isoDate(row.updated_at),
});

export const insertSnapshot = async (
  db: Db,
  input: CreateSnapshotInput,
): Promise<EvalSnapshot> => {
  const row = await db
    .insertInto("eval_snapshots")
    .values({
      id: randomUUID(),
      workspace_id: input.workspaceId,
      source_conversation_id: input.sourceConversationId,
      source_message_id: input.sourceMessageId,
      replay_target: input.replayTarget ? toJsonb(input.replayTarget) : null,
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
      test_execution_replay: input.testExecutionReplay ? toJsonb(input.testExecutionReplay) : null,
      source_agent_id: input.sourceAgentId,
      original_routine_state: input.originalRoutineState
        ? toJsonb(input.originalRoutineState)
        : null,
      original_conversation_summary: input.conversationSummary
        ? toJsonb(input.conversationSummary)
        : null,
      captured_by: input.capturedBy,
    })
    .returning(snapshotColumns)
    .executeTakeFirstOrThrow();
  return mapSnapshot(row as SnapshotRow);
};

export const insertCase = async (db: Db, input: CreateCaseInput): Promise<EvalCase> => {
  const row = await db
    .insertInto("eval_cases")
    .values({
      id: randomUUID(),
      workspace_id: input.workspaceId,
      snapshot_id: input.snapshotId,
      name: input.name,
      assertions: toJsonb(input.assertions),
      execution_mode: input.executionMode ?? "safe_test",
      status: "pending",
    })
    .returning(caseColumns)
    .executeTakeFirstOrThrow();
  return mapCase(row as CaseRow);
};

export const findSnapshot = async (
  db: Db,
  workspaceId: string,
  snapshotId: string,
): Promise<EvalSnapshot | null> => {
  const row = await db
    .selectFrom("eval_snapshots")
    .select(snapshotColumns)
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", snapshotId)
    .limit(1)
    .executeTakeFirst();
  return row ? mapSnapshot(row as SnapshotRow) : null;
};

export const findCase = async (
  db: Db,
  workspaceId: string,
  caseId: string,
): Promise<EvalCase | null> => {
  const row = await db
    .selectFrom("eval_cases")
    .select(caseColumns)
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", caseId)
    .limit(1)
    .executeTakeFirst();
  return row ? mapCase(row as CaseRow) : null;
};
