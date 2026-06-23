import { randomUUID } from "node:crypto";

import type {
  CustomerEmailSkillMode,
  CustomerEmailSkillOutcome,
  EmailSkillRecipientSummary,
} from "../../modules/customerEmail/domain.js";
import { toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface EmailSkillActivityRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  routineId: string | null;
  conversationId: string | null;
  skillDefinitionId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  outcome: CustomerEmailSkillOutcome;
  recipientSummary: EmailSkillRecipientSummary;
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: Date;
}

export interface CreateEmailSkillActivityInput {
  workspaceId: string;
  agentId: string;
  routineId?: string | null;
  conversationId?: string | null;
  skillDefinitionId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  outcome: CustomerEmailSkillOutcome;
  recipientSummary: EmailSkillRecipientSummary;
  providerMessageId?: string | null;
  errorCode?: string | null;
}

export interface ListEmailSkillActivityInput {
  workspaceId: string;
  agentId?: string;
  connectionId?: string;
  skillDefinitionId?: string;
  outcome?: CustomerEmailSkillOutcome;
  createdFrom?: Date;
  createdTo?: Date;
  limit?: number;
}

interface EmailSkillActivityRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  routine_id: string | null;
  conversation_id: string | null;
  skill_definition_id: string;
  connection_id: string;
  skill_name: string;
  mode: CustomerEmailSkillMode;
  outcome: CustomerEmailSkillOutcome;
  recipient_summary: EmailSkillRecipientSummary;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: Date;
}

const emailSkillActivityColumns = [
  "id",
  "workspace_id",
  "agent_id",
  "routine_id",
  "conversation_id",
  "skill_definition_id",
  "connection_id",
  "skill_name",
  "mode",
  "outcome",
  "recipient_summary",
  "provider_message_id",
  "error_code",
  "created_at",
] as const;

const normalizeRecipientSummary = (value: EmailSkillRecipientSummary | null | undefined): EmailSkillRecipientSummary => ({
  toCount: Number(value?.toCount ?? 0),
  ccCount: Number(value?.ccCount ?? 0),
  domains: Array.isArray(value?.domains) ? value.domains.filter((item): item is string => typeof item === "string") : [],
  redactedRecipients: Array.isArray(value?.redactedRecipients)
    ? value.redactedRecipients.filter((item): item is string => typeof item === "string")
    : [],
});

const mapRecord = (row: EmailSkillActivityRow): EmailSkillActivityRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  routineId: row.routine_id,
  conversationId: row.conversation_id,
  skillDefinitionId: row.skill_definition_id,
  connectionId: row.connection_id,
  skillName: row.skill_name,
  mode: row.mode,
  outcome: row.outcome,
  recipientSummary: normalizeRecipientSummary(row.recipient_summary),
  providerMessageId: row.provider_message_id,
  errorCode: row.error_code,
  createdAt: new Date(row.created_at),
});

export interface EmailSkillActivityRepositoryPort {
  record(input: CreateEmailSkillActivityInput): Promise<EmailSkillActivityRecord>;
  list(input: ListEmailSkillActivityInput): Promise<EmailSkillActivityRecord[]>;
}

export class EmailSkillActivityRepository implements EmailSkillActivityRepositoryPort {
  constructor(private readonly db: Db) {}

  async record(input: CreateEmailSkillActivityInput): Promise<EmailSkillActivityRecord> {
    const row = await this.db
      .insertInto("email_skill_activity")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        routine_id: input.routineId ?? null,
        conversation_id: input.conversationId ?? null,
        skill_definition_id: input.skillDefinitionId,
        connection_id: input.connectionId,
        skill_name: input.skillName,
        mode: input.mode,
        outcome: input.outcome,
        recipient_summary: toJsonb(normalizeRecipientSummary(input.recipientSummary)),
        provider_message_id: input.providerMessageId ?? null,
        error_code: input.errorCode ?? null,
      })
      .returning(emailSkillActivityColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as unknown as EmailSkillActivityRow);
  }

  async list(input: ListEmailSkillActivityInput): Promise<EmailSkillActivityRecord[]> {
    let query = this.db
      .selectFrom("email_skill_activity")
      .select(emailSkillActivityColumns)
      .where("workspace_id", "=", input.workspaceId);

    if (input.agentId) query = query.where("agent_id", "=", input.agentId);
    if (input.connectionId) query = query.where("connection_id", "=", input.connectionId);
    if (input.skillDefinitionId) query = query.where("skill_definition_id", "=", input.skillDefinitionId);
    if (input.outcome) query = query.where("outcome", "=", input.outcome);
    if (input.createdFrom) query = query.where("created_at", ">=", input.createdFrom);
    if (input.createdTo) query = query.where("created_at", "<=", input.createdTo);

    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit ?? 50)
      .execute();
    return rows.map((row) => mapRecord(row as unknown as EmailSkillActivityRow));
  }
}
