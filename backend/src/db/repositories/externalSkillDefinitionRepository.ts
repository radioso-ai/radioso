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
  connection_id: string;
  skill_name: string;
  tool_name: string;
  bound_params: Record<string, unknown>;
  exposed_params: Record<string, ExposedParamSpec>;
  declared_outcomes: string[] | null;
  outcome_map: Record<string, string> | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const mapRecord = (row: ExternalSkillDefinitionRow): ExternalSkillDefinitionRecord => ({
  id: row.id,
  agentId: row.agent_id,
  connectionId: row.connection_id,
  skillName: row.skill_name,
  toolName: row.tool_name,
  boundParams: row.bound_params ?? {},
  exposedParams: row.exposed_params ?? {},
  declaredOutcomes: row.declared_outcomes,
  outcomeMap: row.outcome_map,
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

// External MCP skills live on the shared `agent_skills` spine (kind = 'external_mcp')
// joined to their typed `external_skill_details`. The persisted record shape and the
// repository port are unchanged from when external skills owned a dedicated table.
const SELECT_COLUMNS = `s.id, s.agent_id, d.connection_id, s.skill_name, d.tool_name,
         d.bound_params, d.exposed_params, d.declared_outcomes, d.outcome_map,
         s.enabled, s.created_at, s.updated_at`;

const SELECT_BASE = `SELECT ${SELECT_COLUMNS}
   FROM agent_skills s
   JOIN external_skill_details d ON d.skill_id = s.id
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
    // Single data-modifying CTE so the spine row and its detail row are written
    // atomically without a separate transaction round-trip. workspace_id is derived
    // from the agent so the create input shape stays unchanged.
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `WITH new_skill AS (
         INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, enabled)
         SELECT $1, $2, a.workspace_id, $4, 'external_mcp', $10
         FROM agents a WHERE a.id = $2
         RETURNING id, agent_id, skill_name, enabled, created_at, updated_at
       ), new_detail AS (
         INSERT INTO external_skill_details
           (skill_id, connection_id, tool_name, bound_params, exposed_params, declared_outcomes, outcome_map)
         SELECT id, $3, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb FROM new_skill
         RETURNING skill_id, connection_id, tool_name, bound_params, exposed_params, declared_outcomes, outcome_map
       )
       SELECT s.id, s.agent_id, d.connection_id, s.skill_name, d.tool_name,
              d.bound_params, d.exposed_params, d.declared_outcomes, d.outcome_map,
              s.enabled, s.created_at, s.updated_at
       FROM new_skill s JOIN new_detail d ON d.skill_id = s.id`,
      [
        randomUUID(),
        input.agentId,
        input.connectionId,
        input.skillName,
        input.toolName,
        JSON.stringify(input.boundParams ?? {}),
        JSON.stringify(input.exposedParams ?? {}),
        input.declaredOutcomes ?? null,
        input.outcomeMap ? JSON.stringify(input.outcomeMap) : null,
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
      `${SELECT_BASE} AND s.agent_id = $1 AND d.connection_id = $2 ORDER BY s.skill_name ASC`,
      [agentId, connectionId],
    );
    return rows.map(mapRecord);
  }

  async update(
    agentId: string,
    id: string,
    input: UpdateExternalSkillDefinitionInput,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    // Bump the spine (enabled/updated_at) and patch the detail in one statement.
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `WITH upd_skill AS (
         UPDATE agent_skills SET
           enabled = COALESCE($7, enabled),
           updated_at = NOW()
         WHERE agent_id = $1 AND id = $2 AND kind = 'external_mcp'
         RETURNING id, agent_id, skill_name, enabled, created_at, updated_at
       ), upd_detail AS (
         UPDATE external_skill_details d SET
           bound_params = COALESCE($3::jsonb, d.bound_params),
           exposed_params = COALESCE($4::jsonb, d.exposed_params),
           declared_outcomes = COALESCE($5, d.declared_outcomes),
           outcome_map = COALESCE($6::jsonb, d.outcome_map)
         FROM upd_skill s WHERE d.skill_id = s.id
         RETURNING d.skill_id, d.connection_id, d.tool_name, d.bound_params, d.exposed_params, d.declared_outcomes, d.outcome_map
       )
       SELECT s.id, s.agent_id, d.connection_id, s.skill_name, d.tool_name,
              d.bound_params, d.exposed_params, d.declared_outcomes, d.outcome_map,
              s.enabled, s.created_at, s.updated_at
       FROM upd_skill s JOIN upd_detail d ON d.skill_id = s.id`,
      [
        agentId,
        id,
        input.boundParams ? JSON.stringify(input.boundParams) : null,
        input.exposedParams ? JSON.stringify(input.exposedParams) : null,
        input.declaredOutcomes ?? null,
        input.outcomeMap ? JSON.stringify(input.outcomeMap) : null,
        input.enabled ?? null,
      ],
    );
    return row ? mapRecord(row) : null;
  }

  async remove(agentId: string, id: string): Promise<boolean> {
    // Deleting the spine row cascades to external_skill_details.
    const affected = await this.database.execute(
      `DELETE FROM agent_skills WHERE agent_id = $1 AND id = $2 AND kind = 'external_mcp'`,
      [agentId, id],
    );
    return affected > 0;
  }
}
