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
  target_id: string;
  skill_name: string;
  config: {
    mode?: CustomerEmailSkillMode;
    boundInputs?: Record<string, unknown>;
    exposedInputs?: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  };
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// Customer email skills live on the shared `agent_skills` spine. Email-specific
// service validation owns the target/config shape.
const SELECT_BASE = `SELECT s.id, s.workspace_id, s.agent_id, s.target_id, s.skill_name,
         s.config, s.enabled, s.created_at, s.updated_at
   FROM agent_skills s
   WHERE s.kind = 'customer_email'`;

const mapRecord = (row: EmailSkillDefinitionRow): EmailSkillDefinitionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  connectionId: row.target_id,
  skillName: row.skill_name,
  mode: row.config.mode ?? "draft",
  boundInputs: row.config.boundInputs ?? {},
  exposedInputs: row.config.exposedInputs ?? {},
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
    const config = {
      mode: input.mode,
      boundInputs: input.boundInputs ?? {},
      exposedInputs: input.exposedInputs ?? {},
    };
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `INSERT INTO agent_skills (
         id, agent_id, workspace_id, skill_name, kind, enabled, target_type, target_id, config
       )
       VALUES ($1, $3, $2, $5, 'customer_email', $7, 'customer_email_connection', $4, $6::jsonb)
       RETURNING id, workspace_id, agent_id, target_id, skill_name, config, enabled, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.connectionId,
        input.skillName,
        JSON.stringify(config),
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
    const config = {
      ...("mode" in input ? { mode: input.mode } : {}),
      ...("boundInputs" in input ? { boundInputs: input.boundInputs ?? {} } : {}),
      ...("exposedInputs" in input ? { exposedInputs: input.exposedInputs ?? {} } : {}),
    };
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `UPDATE agent_skills SET
         enabled = COALESCE($4, enabled),
         config = config || COALESCE($5::jsonb, '{}'::jsonb),
         updated_at = NOW()
       WHERE workspace_id = $1 AND agent_id = $2 AND id = $3 AND kind = 'customer_email'
       RETURNING id, workspace_id, agent_id, target_id, skill_name, config, enabled, created_at, updated_at`,
      [
        workspaceId,
        agentId,
        id,
        "enabled" in input ? input.enabled ?? null : null,
        Object.keys(config).length > 0 ? JSON.stringify(config) : null,
      ],
    );
    return row ? mapRecord(row) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 AND id = $3 AND kind = 'customer_email'`,
      [workspaceId, agentId, id],
    );
    return affected > 0;
  }

  async countByConnection(workspaceId: string, connectionId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM agent_skills s
       WHERE s.kind = 'customer_email'
         AND s.workspace_id = $1
         AND s.target_type = 'customer_email_connection'
         AND s.target_id = $2`,
      [workspaceId, connectionId],
    );
    return Number(row?.count ?? 0);
  }
}
