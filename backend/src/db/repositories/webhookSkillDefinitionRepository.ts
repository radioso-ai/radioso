import { randomUUID } from "node:crypto";

import type {
  WebhookSkillDefinitionSummary,
} from "../../modules/webhookSkills/domain.js";
import type { Database } from "../../shared/infra/database.js";

export interface WebhookSkillDefinitionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  destinationId: string;
  skillName: string;
  boundPayload: Record<string, unknown>;
  exposedPayload: WebhookSkillDefinitionSummary["exposedPayload"];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookSkillDefinitionInput {
  workspaceId: string;
  agentId: string;
  destinationId: string;
  skillName: string;
  boundPayload: Record<string, unknown>;
  exposedPayload: WebhookSkillDefinitionSummary["exposedPayload"];
  enabled?: boolean;
}

export interface UpdateWebhookSkillDefinitionInput {
  boundPayload?: Record<string, unknown>;
  exposedPayload?: WebhookSkillDefinitionSummary["exposedPayload"];
  enabled?: boolean;
}

interface WebhookSkillDefinitionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  target_id: string;
  skill_name: string;
  config: {
    boundPayload?: Record<string, unknown>;
    exposedPayload?: WebhookSkillDefinitionSummary["exposedPayload"];
  };
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const SELECT_BASE = `SELECT s.id, s.workspace_id, s.agent_id, s.target_id, s.skill_name,
         s.config, s.enabled, s.created_at, s.updated_at
   FROM agent_skills s
   WHERE s.kind = 'webhook'`;

const mapRecord = (row: WebhookSkillDefinitionRow): WebhookSkillDefinitionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  destinationId: row.target_id,
  skillName: row.skill_name,
  boundPayload: row.config?.boundPayload ?? {},
  exposedPayload: row.config?.exposedPayload ?? {},
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface WebhookSkillDefinitionRepositoryPort {
  create(input: CreateWebhookSkillDefinitionInput): Promise<WebhookSkillDefinitionRecord>;
  findById(workspaceId: string, agentId: string, id: string): Promise<WebhookSkillDefinitionRecord | null>;
  findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<WebhookSkillDefinitionRecord | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<WebhookSkillDefinitionRecord[]>;
  update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateWebhookSkillDefinitionInput,
  ): Promise<WebhookSkillDefinitionRecord | null>;
  remove(workspaceId: string, agentId: string, id: string): Promise<boolean>;
  countByDestination(workspaceId: string, destinationId: string): Promise<number>;
  listSkillNamesByDestination(workspaceId: string, destinationId: string): Promise<string[]>;
}

export class WebhookSkillDefinitionRepository implements WebhookSkillDefinitionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: CreateWebhookSkillDefinitionInput): Promise<WebhookSkillDefinitionRecord> {
    const config = {
      boundPayload: input.boundPayload ?? {},
      exposedPayload: input.exposedPayload ?? {},
    };
    const [row] = await this.database.query<WebhookSkillDefinitionRow>(
      `INSERT INTO agent_skills (
         id, agent_id, workspace_id, skill_name, kind, enabled, target_type, target_id, config
       )
       VALUES ($1, $3, $2, $5, 'webhook', $7, 'webhook_destination', $4, $6::jsonb)
       RETURNING id, workspace_id, agent_id, target_id, skill_name, config, enabled, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.destinationId,
        input.skillName,
        JSON.stringify(config),
        input.enabled ?? true,
      ],
    );
    return mapRecord(row);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<WebhookSkillDefinitionRecord | null> {
    const [row] = await this.database.query<WebhookSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 AND s.id = $3`,
      [workspaceId, agentId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<WebhookSkillDefinitionRecord | null> {
    const [row] = await this.database.query<WebhookSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 AND s.skill_name = $3 AND s.enabled = TRUE`,
      [workspaceId, agentId, skillName],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<WebhookSkillDefinitionRecord[]> {
    const rows = await this.database.query<WebhookSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 ORDER BY s.skill_name ASC`,
      [workspaceId, agentId],
    );
    return rows.map(mapRecord);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateWebhookSkillDefinitionInput,
  ): Promise<WebhookSkillDefinitionRecord | null> {
    const config = {
      ...("boundPayload" in input ? { boundPayload: input.boundPayload ?? {} } : {}),
      ...("exposedPayload" in input ? { exposedPayload: input.exposedPayload ?? {} } : {}),
    };
    const [row] = await this.database.query<WebhookSkillDefinitionRow>(
      `UPDATE agent_skills SET
         enabled = COALESCE($4, enabled),
         config = config || COALESCE($5::jsonb, '{}'::jsonb),
         updated_at = NOW()
       WHERE workspace_id = $1 AND agent_id = $2 AND id = $3 AND kind = 'webhook'
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
      `DELETE FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 AND id = $3 AND kind = 'webhook'`,
      [workspaceId, agentId, id],
    );
    return affected > 0;
  }

  async countByDestination(workspaceId: string, destinationId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM agent_skills s
       WHERE s.kind = 'webhook'
         AND s.workspace_id = $1
         AND s.target_type = 'webhook_destination'
         AND s.target_id = $2`,
      [workspaceId, destinationId],
    );
    return Number(row?.count ?? 0);
  }

  async listSkillNamesByDestination(workspaceId: string, destinationId: string): Promise<string[]> {
    const rows = await this.database.query<{ skill_name: string }>(
      `SELECT s.skill_name
       FROM agent_skills s
       WHERE s.kind = 'webhook'
         AND s.workspace_id = $1
         AND s.target_type = 'webhook_destination'
         AND s.target_id = $2
       ORDER BY s.skill_name ASC`,
      [workspaceId, destinationId],
    );
    return rows.map((row) => row.skill_name);
  }
}
