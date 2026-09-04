import { randomUUID } from "node:crypto";
import { sql } from "kysely";

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
  conversation_id: string | null;
  operator_mcp_invocation_id: string | null;
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
  "id", "workspace_id", "operator_user_id", "conversation_id", "operator_mcp_invocation_id", "agent_id", "case_id", "case_name",
  "run_id", "baseline_captured_at", "recorded_status", "verdict", "overrides", "directives_excluded",
  "created_at",
] as const;

const mapRecord = (row: CopilotReplayEvidenceRow): CopilotReplayEvidenceRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  operatorUserId: row.operator_user_id,
  origin: row.conversation_id
    ? { type: "conversation", conversationId: row.conversation_id }
    : { type: "operator_mcp_invocation", invocationId: row.operator_mcp_invocation_id! },
  conversationId: row.conversation_id,
  operatorMcpInvocationId: row.operator_mcp_invocation_id,
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
    input: Omit<CopilotReplayEvidenceRecord, "id" | "createdAt" | "conversationId" | "operatorMcpInvocationId">,
  ): Promise<CopilotReplayEvidenceRecord> {
    if (input.origin.type === "operator_mcp_invocation") {
      const id = randomUUID();
      const result = await sql<CopilotReplayEvidenceRow>`
        WITH current_authorization AS (
          SELECT invocation.id
          FROM operator_mcp_invocations invocation
          JOIN operator_mcp_grants oauth_grant ON oauth_grant.id = invocation.grant_id
          JOIN operator_mcp_access_credentials credential ON credential.id = invocation.credential_id
          JOIN operator_mcp_clients client ON client.id = oauth_grant.client_id
          JOIN account_memberships membership ON membership.id = oauth_grant.membership_id
          JOIN users account_user ON account_user.id = oauth_grant.user_id
          JOIN operator_mcp_deployment_credential_state deployment ON deployment.resource = oauth_grant.resource
          WHERE invocation.id = ${input.origin.invocationId}
            AND invocation.workspace_id = ${input.workspaceId}
            AND invocation.user_id = ${input.operatorUserId}
            AND invocation.status = 'running'
            AND invocation.shape = 'propose'
            AND oauth_grant.status = 'active'
            AND oauth_grant.version = invocation.grant_version
            AND 'operator:propose' = ANY(oauth_grant.tool_scopes)
            AND membership.status = 'active'
            AND account_user.disabled_at IS NULL
            AND client.status = 'active'
            AND client.version = oauth_grant.client_version
            AND credential.grant_id = oauth_grant.id
            AND credential.issued_grant_version = oauth_grant.version
            AND credential.issued_client_version = oauth_grant.client_version
            AND credential.issued_client_metadata_snapshot_id = oauth_grant.client_metadata_snapshot_id
            AND credential.issued_credential_epoch = oauth_grant.credential_epoch
            AND credential.expires_at > NOW()
            AND deployment.credential_epoch = oauth_grant.credential_epoch
          FOR UPDATE OF invocation, oauth_grant, credential, client, membership, account_user, deployment
        )
        INSERT INTO copilot_replay_evidence (
          id, workspace_id, operator_user_id, conversation_id, operator_mcp_invocation_id,
          agent_id, case_id, case_name, run_id, baseline_captured_at, recorded_status,
          verdict, overrides, directives_excluded
        )
        SELECT ${id}, ${input.workspaceId}, ${input.operatorUserId}, NULL, ${input.origin.invocationId},
          ${input.agentId}, ${input.caseId}, ${input.caseName}, ${input.runId}, ${input.baselineCapturedAt},
          ${input.recordedStatus}, ${input.verdict}, ${JSON.stringify(input.overrides)}::jsonb,
          ${JSON.stringify(input.directivesExcluded)}::jsonb
        FROM current_authorization
        RETURNING *
      `.execute(this.db);
      const row = result.rows[0];
      if (!row) throw new Error("Operator MCP evidence authorization is no longer current");
      return mapRecord(row);
    }
    const row = await this.db
      .insertInto("copilot_replay_evidence")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        operator_user_id: input.operatorUserId,
        conversation_id: input.origin.conversationId,
        operator_mcp_invocation_id: null,
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
