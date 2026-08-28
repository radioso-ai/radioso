import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  CopilotEvalCaseReplayOverrides,
  CopilotEvalCaseStatus,
  CopilotEvalRunStatus,
  CopilotReplayEvidenceRecord,
  CopilotReplayEvidenceRepositoryPort,
} from "../../modules/operatorCopilot/public.js";

interface CopilotReplayEvidenceRow {
  id: string;
  workspace_id: string;
  operator_user_id: string;
  conversation_id: string;
  agent_id: string;
  case_id: string;
  case_name: string;
  run_id: string;
  baseline_captured_at: Date;
  recorded_status: string;
  verdict: string;
  overrides: unknown;
  directives_excluded: unknown;
  created_at: Date;
}

const columns = [
  "id", "workspace_id", "operator_user_id", "conversation_id", "agent_id", "case_id", "case_name",
  "run_id", "baseline_captured_at", "recorded_status", "verdict", "overrides", "directives_excluded",
  "created_at",
] as const;

const mapRecord = (row: CopilotReplayEvidenceRow): CopilotReplayEvidenceRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  operatorUserId: row.operator_user_id,
  conversationId: row.conversation_id,
  agentId: row.agent_id,
  caseId: row.case_id,
  caseName: row.case_name,
  runId: row.run_id,
  baselineCapturedAt: row.baseline_captured_at,
  recordedStatus: row.recorded_status as CopilotEvalCaseStatus,
  verdict: row.verdict as CopilotEvalRunStatus,
  overrides: (row.overrides ?? {}) as CopilotEvalCaseReplayOverrides,
  directivesExcluded: (row.directives_excluded ?? []) as ReadonlyArray<string>,
  createdAt: row.created_at,
});

export class CopilotReplayEvidenceRepository implements CopilotReplayEvidenceRepositoryPort {
  constructor(private readonly db: Db) {}

  async record(
    input: Omit<CopilotReplayEvidenceRecord, "id" | "createdAt">,
  ): Promise<CopilotReplayEvidenceRecord> {
    const row = await this.db
      .insertInto("copilot_replay_evidence")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        operator_user_id: input.operatorUserId,
        conversation_id: input.conversationId,
        agent_id: input.agentId,
        case_id: input.caseId,
        case_name: input.caseName,
        run_id: input.runId,
        baseline_captured_at: input.baselineCapturedAt,
        recorded_status: input.recordedStatus,
        verdict: input.verdict,
        overrides: JSON.stringify(input.overrides),
        directives_excluded: JSON.stringify(input.directivesExcluded),
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as CopilotReplayEvidenceRow);
  }

  async findMany(input: {
    workspaceId: string;
    operatorUserId: string;
    ids: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<CopilotReplayEvidenceRecord>> {
    if (input.ids.length === 0) return [];
    const rows = await this.db
      .selectFrom("copilot_replay_evidence")
      .select(columns)
      .where("id", "in", [...input.ids])
      .where("workspace_id", "=", input.workspaceId)
      .where("operator_user_id", "=", input.operatorUserId)
      .execute();
    return rows.map((row) => mapRecord(row as CopilotReplayEvidenceRow));
  }
}
