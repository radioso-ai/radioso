import { randomUUID } from "node:crypto";

import type {
  CustomerEmailSkillMode,
  CustomerEmailSkillDefinitionSummary,
} from "../../modules/customerEmail/domain.js";
import type { Database } from "../../shared/infra/database.js";

export interface EmailSkillDefinitionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  boundInputs: Record<string, unknown>;
  exposedInputs: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEmailSkillDefinitionInput {
  workspaceId: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  boundInputs: Record<string, unknown>;
  exposedInputs: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled?: boolean;
}

export interface UpdateEmailSkillDefinitionInput {
  mode?: CustomerEmailSkillMode;
  boundInputs?: Record<string, unknown>;
  exposedInputs?: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled?: boolean;
}

interface EmailSkillDefinitionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  connection_id: string;
  skill_name: string;
  mode: CustomerEmailSkillMode;
  bound_inputs: Record<string, unknown>;
  exposed_inputs: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// Customer email skills live on the shared `agent_skills` spine (kind = 'customer_email')
// joined to their typed `email_skill_details`. The persisted record shape and repository
// port are unchanged from when email skills owned a dedicated table.
const SELECT_BASE = `SELECT s.id, s.workspace_id, s.agent_id, d.connection_id, s.skill_name, d.mode,
         d.bound_inputs, d.exposed_inputs, s.enabled, s.created_at, s.updated_at
   FROM agent_skills s
   JOIN email_skill_details d ON d.skill_id = s.id
   WHERE s.kind = 'customer_email'`;

const mapRecord = (row: EmailSkillDefinitionRow): EmailSkillDefinitionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  connectionId: row.connection_id,
  skillName: row.skill_name,
  mode: row.mode,
  boundInputs: row.bound_inputs ?? {},
  exposedInputs: row.exposed_inputs ?? {},
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface EmailSkillDefinitionRepositoryPort {
  create(input: CreateEmailSkillDefinitionInput): Promise<EmailSkillDefinitionRecord>;
  findById(workspaceId: string, agentId: string, id: string): Promise<EmailSkillDefinitionRecord | null>;
  findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<EmailSkillDefinitionRecord | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<EmailSkillDefinitionRecord[]>;
  update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateEmailSkillDefinitionInput,
  ): Promise<EmailSkillDefinitionRecord | null>;
  remove(workspaceId: string, agentId: string, id: string): Promise<boolean>;
  countByConnection(workspaceId: string, connectionId: string): Promise<number>;
}

export class EmailSkillDefinitionRepository implements EmailSkillDefinitionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: CreateEmailSkillDefinitionInput): Promise<EmailSkillDefinitionRecord> {
    // Single data-modifying CTE writes the spine row and its detail row atomically.
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `WITH new_skill AS (
         INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, enabled)
         VALUES ($1, $3, $2, $5, 'customer_email', $9)
         RETURNING id, workspace_id, agent_id, skill_name, enabled, created_at, updated_at
       ), new_detail AS (
         INSERT INTO email_skill_details (skill_id, connection_id, mode, bound_inputs, exposed_inputs)
         SELECT id, $4, $6, $7::jsonb, $8::jsonb FROM new_skill
         RETURNING skill_id, connection_id, mode, bound_inputs, exposed_inputs
       )
       SELECT s.id, s.workspace_id, s.agent_id, d.connection_id, s.skill_name, d.mode,
              d.bound_inputs, d.exposed_inputs, s.enabled, s.created_at, s.updated_at
       FROM new_skill s JOIN new_detail d ON d.skill_id = s.id`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.connectionId,
        input.skillName,
        input.mode,
        JSON.stringify(input.boundInputs ?? {}),
        JSON.stringify(input.exposedInputs ?? {}),
        input.enabled ?? true,
      ],
    );
    return mapRecord(row);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<EmailSkillDefinitionRecord | null> {
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 AND s.id = $3`,
      [workspaceId, agentId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<EmailSkillDefinitionRecord | null> {
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 AND s.skill_name = $3 AND s.enabled = TRUE`,
      [workspaceId, agentId, skillName],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<EmailSkillDefinitionRecord[]> {
    const rows = await this.database.query<EmailSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 ORDER BY s.skill_name ASC`,
      [workspaceId, agentId],
    );
    return rows.map(mapRecord);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateEmailSkillDefinitionInput,
  ): Promise<EmailSkillDefinitionRecord | null> {
    // Bump the spine (enabled/updated_at) and patch the detail (mode/inputs) in one statement.
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `WITH upd_skill AS (
         UPDATE agent_skills SET
           enabled = COALESCE($4, enabled),
           updated_at = NOW()
         WHERE workspace_id = $1 AND agent_id = $2 AND id = $3 AND kind = 'customer_email'
         RETURNING id, workspace_id, agent_id, skill_name, enabled, created_at, updated_at
       ), upd_detail AS (
         UPDATE email_skill_details d SET
           mode = COALESCE($5, d.mode),
           bound_inputs = COALESCE($6::jsonb, d.bound_inputs),
           exposed_inputs = COALESCE($7::jsonb, d.exposed_inputs)
         FROM upd_skill s WHERE d.skill_id = s.id
         RETURNING d.skill_id, d.connection_id, d.mode, d.bound_inputs, d.exposed_inputs
       )
       SELECT s.id, s.workspace_id, s.agent_id, d.connection_id, s.skill_name, d.mode,
              d.bound_inputs, d.exposed_inputs, s.enabled, s.created_at, s.updated_at
       FROM upd_skill s JOIN upd_detail d ON d.skill_id = s.id`,
      [
        workspaceId,
        agentId,
        id,
        "enabled" in input ? input.enabled ?? null : null,
        "mode" in input ? input.mode ?? null : null,
        "boundInputs" in input ? JSON.stringify(input.boundInputs ?? {}) : null,
        "exposedInputs" in input ? JSON.stringify(input.exposedInputs ?? {}) : null,
      ],
    );
    return row ? mapRecord(row) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    // Deleting the spine row cascades to email_skill_details.
    const affected = await this.database.execute(
      `DELETE FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 AND id = $3 AND kind = 'customer_email'`,
      [workspaceId, agentId, id],
    );
    return affected > 0;
  }

  async countByConnection(workspaceId: string, connectionId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM email_skill_details d
       JOIN agent_skills s ON s.id = d.skill_id
       WHERE s.workspace_id = $1 AND d.connection_id = $2`,
      [workspaceId, connectionId],
    );
    return Number(row?.count ?? 0);
  }
}
