import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { ExposedParamSpec } from "../../modules/externalSkills/skillDefinitions/resolver.js";

export interface ExternalSkillDefinitionRecord {
  id: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, ExposedParamSpec>;
  declaredOutcomes: string[] | null;
  outcomeMap: Record<string, string> | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateExternalSkillDefinitionInput {
  agentId: string;
  connectionId: string;
  skillName: string;
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, ExposedParamSpec>;
  declaredOutcomes?: string[] | null;
  outcomeMap?: Record<string, string> | null;
  enabled?: boolean;
}

export interface UpdateExternalSkillDefinitionInput {
  boundParams?: Record<string, unknown>;
  exposedParams?: Record<string, ExposedParamSpec>;
  declaredOutcomes?: string[] | null;
  outcomeMap?: Record<string, string> | null;
  enabled?: boolean;
}

interface ExternalSkillDefinitionRow {
  id: string;
  agent_id: string;
  target_id: string;
  skill_name: string;
  config: {
    toolName?: string;
    boundParams?: Record<string, unknown>;
    exposedParams?: Record<string, ExposedParamSpec>;
    declaredOutcomes?: string[] | null;
    outcomeMap?: Record<string, string> | null;
  };
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const mapRecord = (row: ExternalSkillDefinitionRow): ExternalSkillDefinitionRecord => ({
  id: row.id,
  agentId: row.agent_id,
  connectionId: row.target_id,
  skillName: row.skill_name,
  toolName: row.config.toolName ?? "",
  boundParams: row.config.boundParams ?? {},
  exposedParams: row.config.exposedParams ?? {},
  declaredOutcomes: row.config.declaredOutcomes ?? null,
  outcomeMap: row.config.outcomeMap ?? null,
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

// External MCP skills live on the shared `agent_skills` spine. MCP-specific
// service validation owns the target/config shape.
const SELECT_COLUMNS = `s.id, s.agent_id, s.target_id, s.skill_name, s.config,
         s.enabled, s.created_at, s.updated_at`;
const RETURNING_COLUMNS = `id, agent_id, target_id, skill_name, config,
         enabled, created_at, updated_at`;

const SELECT_BASE = `SELECT ${SELECT_COLUMNS}
   FROM agent_skills s
   WHERE s.kind = 'external_mcp'`;

export interface ExternalSkillDefinitionRepositoryPort {
  create(input: CreateExternalSkillDefinitionInput): Promise<ExternalSkillDefinitionRecord>;
  findById(agentId: string, id: string): Promise<ExternalSkillDefinitionRecord | null>;
  findEnabledByName(agentId: string, skillName: string): Promise<ExternalSkillDefinitionRecord | null>;
  listByAgent(agentId: string): Promise<ExternalSkillDefinitionRecord[]>;
  listByConnection(agentId: string, connectionId: string): Promise<ExternalSkillDefinitionRecord[]>;
  update(agentId: string, id: string, input: UpdateExternalSkillDefinitionInput): Promise<ExternalSkillDefinitionRecord | null>;
  remove(agentId: string, id: string): Promise<boolean>;
}

export class ExternalSkillDefinitionRepository implements ExternalSkillDefinitionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: CreateExternalSkillDefinitionInput): Promise<ExternalSkillDefinitionRecord> {
    const config = {
      toolName: input.toolName,
      boundParams: input.boundParams ?? {},
      exposedParams: input.exposedParams ?? {},
      declaredOutcomes: input.declaredOutcomes ?? null,
      outcomeMap: input.outcomeMap ?? null,
    };
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `INSERT INTO agent_skills (
         id, agent_id, workspace_id, skill_name, kind, enabled, target_type, target_id, config
       )
       SELECT $1, $2, a.workspace_id, $4, 'external_mcp', $6, 'mcp_connection', $3, $5::jsonb
         FROM agents a WHERE a.id = $2
       RETURNING ${RETURNING_COLUMNS}`,
      [
        randomUUID(),
        input.agentId,
        input.connectionId,
        input.skillName,
        JSON.stringify(config),
        input.enabled ?? true,
      ],
    );
    return mapRecord(row);
  }

  async findById(agentId: string, id: string): Promise<ExternalSkillDefinitionRecord | null> {
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `${SELECT_BASE} AND s.agent_id = $1 AND s.id = $2`,
      [agentId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async findEnabledByName(
    agentId: string,
    skillName: string,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `${SELECT_BASE} AND s.agent_id = $1 AND s.skill_name = $2 AND s.enabled = TRUE`,
      [agentId, skillName],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(agentId: string): Promise<ExternalSkillDefinitionRecord[]> {
    const rows = await this.database.query<ExternalSkillDefinitionRow>(
      `${SELECT_BASE} AND s.agent_id = $1 ORDER BY s.skill_name ASC`,
      [agentId],
    );
    return rows.map(mapRecord);
  }

  async listByConnection(
    agentId: string,
    connectionId: string,
  ): Promise<ExternalSkillDefinitionRecord[]> {
    const rows = await this.database.query<ExternalSkillDefinitionRow>(
      `${SELECT_BASE} AND s.agent_id = $1 AND s.target_type = 'mcp_connection' AND s.target_id = $2 ORDER BY s.skill_name ASC`,
      [agentId, connectionId],
    );
    return rows.map(mapRecord);
  }

  async update(
    agentId: string,
    id: string,
    input: UpdateExternalSkillDefinitionInput,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    const config = {
      ...("boundParams" in input ? { boundParams: input.boundParams ?? {} } : {}),
      ...("exposedParams" in input ? { exposedParams: input.exposedParams ?? {} } : {}),
      ...("declaredOutcomes" in input ? { declaredOutcomes: input.declaredOutcomes ?? null } : {}),
      ...("outcomeMap" in input ? { outcomeMap: input.outcomeMap ?? null } : {}),
    };
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `UPDATE agent_skills SET
         enabled = COALESCE($3, enabled),
         config = config || COALESCE($4::jsonb, '{}'::jsonb),
         updated_at = NOW()
       WHERE agent_id = $1 AND id = $2 AND kind = 'external_mcp'
       RETURNING ${RETURNING_COLUMNS}`,
      [
        agentId,
        id,
        input.enabled ?? null,
        Object.keys(config).length > 0 ? JSON.stringify(config) : null,
      ],
    );
    return row ? mapRecord(row) : null;
  }

  async remove(agentId: string, id: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM agent_skills WHERE agent_id = $1 AND id = $2 AND kind = 'external_mcp'`,
      [agentId, id],
    );
    return affected > 0;
  }
}
