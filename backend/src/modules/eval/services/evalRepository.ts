import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { normalizeNullableText } from "../../../shared/domain/nullableText.js";
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  AssertionVerdict,
  EvalAssertion,
  EvalCase,
  EvalCaseListItem,
  EvalCaseStatus,
  EvalRun,
  EvalRunMode,
  EvalRunObservedOutput,
  EvalRunOverrides,
  EvalRunResolvedConfig,
  EvalRunStatus,
  EvalRunSummary,
  EvalSnapshot,
} from "../domain/types.js";
import {
  asObject,
  caseColumns,
  findCase,
  findSnapshot,
  insertCase,
  insertSnapshot,
  isoDate,
  mapCase,
  type CaseRow,
  type CreateCaseInput,
  type CreateSnapshotInput,
} from "./evalPersistence.js";

export type { CreateCaseInput, CreateSnapshotInput } from "./evalPersistence.js";

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
  listCasesWithLatestRun(workspaceId: string): Promise<EvalCaseListItem[]>;
  deleteCase(workspaceId: string, caseId: string): Promise<boolean>;
  updateCaseAssertions(
    workspaceId: string,
    caseId: string,
    assertions: EvalAssertion[],
  ): Promise<EvalCase>;
  updateCaseName(workspaceId: string, caseId: string, name: string): Promise<EvalCase>;
  updateCaseExecutionMode(
    workspaceId: string,
    caseId: string,
    executionMode: TurnExecutionMode,
  ): Promise<EvalCase>;
  createRun(input: CreateRunInput): Promise<EvalRun>;
  listRunsForCase(workspaceId: string, caseId: string): Promise<EvalRun[]>;
  updateCaseLastRun(
    workspaceId: string,
    caseId: string,
    lastRunId: string,
    status: EvalCaseStatus,
  ): Promise<EvalCase | null>;
}

const isConstraintViolation = (error: unknown, constraintName: string): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { constraint?: unknown; message?: unknown };
  if (candidate.constraint === constraintName) return true;
  return typeof candidate.message === "string" && candidate.message.includes(constraintName);
};

// eval_cases columns qualified for queries that join eval_snapshots / agents,
// where bare `id` / `workspace_id` / `created_at` / `updated_at` are ambiguous.
// Kysely aliases `eval_cases.id` back to the `id` key, so mapCase still applies.
const qualifiedCaseColumns = caseColumns.map(
  (col) => `eval_cases.${col}` as `eval_cases.${(typeof caseColumns)[number]}`,
);

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
    return insertSnapshot(this.db, input);
  }

  async findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null> {
    return findSnapshot(this.db, workspaceId, id);
  }

  async createCase(input: CreateCaseInput): Promise<EvalCase> {
    return insertCase(this.db, input);
  }

  async findCase(workspaceId: string, id: string): Promise<EvalCase | null> {
    return findCase(this.db, workspaceId, id);
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

  async listCasesWithLatestRun(workspaceId: string): Promise<EvalCaseListItem[]> {
    // Join the snapshot for the captured agent identity/name, and left-join the
    // live agents row so a still-present agent shows its current name while a
    // deleted one falls back to the frozen capture-time name. JSON extraction
    // (`->> 'name'`) avoids pulling the large original_agent_config blob.
    const caseRows = await this.db
      .selectFrom("eval_cases")
      .innerJoin("eval_snapshots", "eval_snapshots.id", "eval_cases.snapshot_id")
      .leftJoin("agents", "agents.id", "eval_snapshots.source_agent_id")
      .select(qualifiedCaseColumns)
      .select([
        "eval_snapshots.source_agent_id as source_agent_id",
        "agents.name as live_agent_name",
        "agents.internal_name as live_agent_internal_name",
        sql<string | null>`eval_snapshots.original_agent_config ->> 'name'`.as(
          "frozen_config_agent_name",
        ),
        sql<string | null>`eval_snapshots.original_agent ->> 'name'`.as("frozen_agent_name"),
      ])
      .where("eval_cases.workspace_id", "=", workspaceId)
      .orderBy("eval_cases.updated_at", "desc")
      .orderBy("eval_cases.id", "desc")
      .execute();

    // One row per case: the most recent run, via DISTINCT ON. The case_id is the
    // leading order key (DISTINCT ON requires it) and started_at DESC picks the
    // latest. This stays a single query — no per-case round-trips.
    const runRows = await this.db
      .selectFrom("eval_runs")
      .select([
        "id",
        "case_id",
        "mode",
        "status",
        "resolved_config",
        "outcome_reason",
        "started_at",
        "completed_at",
      ])
      .distinctOn("case_id")
      .where("workspace_id", "=", workspaceId)
      .where("case_id", "is not", null)
      .orderBy("case_id")
      .orderBy("started_at", "desc")
      .orderBy("id", "desc")
      .execute();

    const latestByCase = new Map<string, EvalRunSummary>();
    for (const row of runRows) {
      if (!row.case_id) continue;
      latestByCase.set(row.case_id, {
        id: row.id,
        status: row.status as EvalRunStatus,
        mode: row.mode as EvalRunMode,
        startedAt: isoDate(row.started_at as Date | string),
        completedAt: row.completed_at ? isoDate(row.completed_at as Date | string) : null,
        modelId: asObject<EvalRunResolvedConfig>(row.resolved_config, {}).modelId ?? null,
        outcomeReason: (row.outcome_reason as string | null) ?? null,
      });
    }

    return caseRows.map((row) => {
      const sourceAgentId = (row.source_agent_id as string | null) ?? null;
      const liveName = (row.live_agent_name as string | null) ?? null;
      const liveInternalName = (row.live_agent_internal_name as string | null) ?? null;
      // Live name when the agent still exists; otherwise the name frozen on the
      // snapshot (full config first, then the legacy thin AgentSnapshot).
      const frozenName =
        (row.frozen_config_agent_name as string | null) ??
        (row.frozen_agent_name as string | null) ??
        null;
      return {
        ...mapCase(row as CaseRow),
        latestRun: latestByCase.get((row as CaseRow).id) ?? null,
        agent: {
          agentId: sourceAgentId,
          name: liveName ?? frozenName,
          internalName: liveName === null ? null : normalizeNullableText(liveInternalName),
          deleted: sourceAgentId !== null && liveName === null,
        },
      };
    });
  }

  async deleteCase(workspaceId: string, caseId: string): Promise<boolean> {
    const rows = await this.db
      .deleteFrom("eval_cases")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", caseId)
      .returning("id")
      .execute();
    return rows.length > 0;
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

  async updateCaseExecutionMode(
    workspaceId: string,
    caseId: string,
    executionMode: TurnExecutionMode,
  ): Promise<EvalCase> {
    const row = await this.db
      .updateTable("eval_cases")
      .set({
        execution_mode: executionMode,
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

  private async insertRun(input: CreateRunInput, caseId: string | null): Promise<EvalRun> {
    const row = await this.db
      .insertInto("eval_runs")
      .values({
        id: input.id ?? randomUUID(),
        workspace_id: input.workspaceId,
        snapshot_id: input.snapshotId,
        case_id: caseId,
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

  async createRun(input: CreateRunInput): Promise<EvalRun> {
    try {
      return await this.insertRun(input, input.caseId);
    } catch (error) {
      if (input.caseId && isConstraintViolation(error, "eval_runs_case_id_fkey")) {
        return this.insertRun(input, null);
      }
      throw error;
    }
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
  ): Promise<EvalCase | null> {
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
      .executeTakeFirst();
    return row ? mapCase(row as CaseRow) : null;
  }
}
