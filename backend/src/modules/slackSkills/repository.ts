import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { SlackSkillDefinitionSummary } from "./domain.js";

interface SlackSkillDefinitionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  target_id: string;
  skill_name: string;
  config: {
    boundInputs?: Record<string, unknown>;
    exposedInputs?: SlackSkillDefinitionSummary["exposedInputs"];
  };
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const SELECT_BASE = `SELECT s.id, s.workspace_id, s.agent_id, s.target_id, s.skill_name,
         s.config, s.enabled, s.created_at, s.updated_at
   FROM agent_skills s
   WHERE s.kind = 'slack'`;

const mapRecord = (row: SlackSkillDefinitionRow): SlackSkillDefinitionSummary => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  installationId: row.target_id,
  skillName: row.skill_name,
  boundInputs: row.config.boundInputs ?? {},
  exposedInputs: row.config.exposedInputs ?? {},
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface CreateSlackSkillDefinitionInput {
  workspaceId: string;
  agentId: string;
  installationId: string;
  skillName: string;
  boundInputs?: Record<string, unknown>;
  exposedInputs?: SlackSkillDefinitionSummary["exposedInputs"];
  enabled?: boolean;
}

export interface SlackSkillDefinitionRepositoryPort {
  create(input: CreateSlackSkillDefinitionInput): Promise<SlackSkillDefinitionSummary>;
  findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<SlackSkillDefinitionSummary | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<SlackSkillDefinitionSummary[]>;
}

export class SlackSkillDefinitionRepository implements SlackSkillDefinitionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: CreateSlackSkillDefinitionInput): Promise<SlackSkillDefinitionSummary> {
    const config = {
      boundInputs: input.boundInputs ?? {},
      exposedInputs: input.exposedInputs ?? {},
    };
    const [row] = await this.database.query<SlackSkillDefinitionRow>(
      `INSERT INTO agent_skills (
         id, agent_id, workspace_id, skill_name, kind, enabled, target_type, target_id, config
       )
       VALUES ($1, $3, $2, $5, 'slack', $7, 'slack_installation', $4, $6::jsonb)
       RETURNING id, workspace_id, agent_id, target_id, skill_name, config, enabled, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.installationId,
        input.skillName,
        JSON.stringify(config),
        input.enabled ?? true,
      ],
    );
    return mapRecord(row);
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<SlackSkillDefinitionSummary | null> {
    const [row] = await this.database.query<SlackSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 AND s.skill_name = $3 AND s.enabled = TRUE`,
      [workspaceId, agentId, skillName],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<SlackSkillDefinitionSummary[]> {
    const rows = await this.database.query<SlackSkillDefinitionRow>(
      `${SELECT_BASE} AND s.workspace_id = $1 AND s.agent_id = $2 ORDER BY s.skill_name ASC`,
      [workspaceId, agentId],
    );
    return rows.map(mapRecord);
  }
}
