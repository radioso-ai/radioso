import type {
  AgentBundleImportFailureCode,
  AgentBundleImportRecord,
  AgentBundleImportState,
  AgentBundleUnresolvedReference,
} from "../../modules/agentBundle/public.js";

export interface AgentBundleImportRow {
  id: string;
  workspace_id: string;
  actor_account_id: string | null;
  idempotency_key: string | null;
  state: string;
  agent_id: string | null;
  unresolved: AgentBundleUnresolvedReference[] | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
  compensated_at: Date | null;
}

export const agentBundleImportColumns = [
  "id",
  "workspace_id",
  "actor_account_id",
  "idempotency_key",
  "state",
  "agent_id",
  "unresolved",
  "failure_code",
  "created_at",
  "updated_at",
  "applied_at",
  "compensated_at",
] as const;

export const mapAgentBundleImport = (row: AgentBundleImportRow): AgentBundleImportRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  actorAccountId: row.actor_account_id,
  idempotencyKey: row.idempotency_key,
  state: row.state as AgentBundleImportState,
  agentId: row.agent_id,
  unresolved: row.unresolved ?? [],
  failureCode: row.failure_code as AgentBundleImportFailureCode | null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  appliedAt: row.applied_at,
  compensatedAt: row.compensated_at,
});
