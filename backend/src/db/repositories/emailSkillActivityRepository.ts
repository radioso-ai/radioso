import { randomUUID } from "node:crypto";

import type {
  CustomerEmailSkillMode,
  CustomerEmailSkillOutcome,
  EmailSkillRecipientSummary,
} from "../../modules/customerEmail/domain.js";
import type { Database } from "../../shared/infra/database.js";

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

const COLUMNS =
  "id, workspace_id, agent_id, routine_id, conversation_id, skill_definition_id, connection_id, skill_name, mode, outcome, recipient_summary, provider_message_id, error_code, created_at";

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
  constructor(private readonly database: Database) {}

  async record(input: CreateEmailSkillActivityInput): Promise<EmailSkillActivityRecord> {
    const [row] = await this.database.query<EmailSkillActivityRow>(
      `INSERT INTO email_skill_activity
         (id, workspace_id, agent_id, routine_id, conversation_id, skill_definition_id, connection_id, skill_name, mode, outcome,
          recipient_summary, provider_message_id, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.routineId ?? null,
        input.conversationId ?? null,
        input.skillDefinitionId,
        input.connectionId,
        input.skillName,
        input.mode,
        input.outcome,
        JSON.stringify(normalizeRecipientSummary(input.recipientSummary)),
        input.providerMessageId ?? null,
        input.errorCode ?? null,
      ],
    );
    return mapRecord(row);
  }

  async list(input: ListEmailSkillActivityInput): Promise<EmailSkillActivityRecord[]> {
    const params: unknown[] = [input.workspaceId];
    const conditions = ["workspace_id = $1"];
    const addCondition = (column: string, value: unknown, operator = "="): void => {
      params.push(value);
      conditions.push(`${column} ${operator} $${params.length}`);
    };

    if (input.agentId) addCondition("agent_id", input.agentId);
    if (input.connectionId) addCondition("connection_id", input.connectionId);
    if (input.skillDefinitionId) addCondition("skill_definition_id", input.skillDefinitionId);
    if (input.outcome) addCondition("outcome", input.outcome);
    if (input.createdFrom) addCondition("created_at", input.createdFrom, ">=");
    if (input.createdTo) addCondition("created_at", input.createdTo, "<=");
    params.push(input.limit ?? 50);

    const rows = await this.database.query<EmailSkillActivityRow>(
      `SELECT ${COLUMNS}
       FROM email_skill_activity
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapRecord);
  }
}
