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

const COLUMNS =
  "id, agent_id, connection_id, skill_name, tool_name, bound_params, exposed_params, declared_outcomes, outcome_map, enabled, created_at, updated_at";

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
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `INSERT INTO external_skill_definitions
         (id, agent_id, connection_id, skill_name, tool_name, bound_params, exposed_params, declared_outcomes, outcome_map, enabled)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10)
       RETURNING ${COLUMNS}`,
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
      `SELECT ${COLUMNS} FROM external_skill_definitions WHERE agent_id = $1 AND id = $2`,
      [agentId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async findEnabledByName(
    agentId: string,
    skillName: string,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `SELECT ${COLUMNS} FROM external_skill_definitions
       WHERE agent_id = $1 AND skill_name = $2 AND enabled = TRUE`,
      [agentId, skillName],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(agentId: string): Promise<ExternalSkillDefinitionRecord[]> {
    const rows = await this.database.query<ExternalSkillDefinitionRow>(
      `SELECT ${COLUMNS} FROM external_skill_definitions WHERE agent_id = $1 ORDER BY skill_name ASC`,
      [agentId],
    );
    return rows.map(mapRecord);
  }

  async listByConnection(
    agentId: string,
    connectionId: string,
  ): Promise<ExternalSkillDefinitionRecord[]> {
    const rows = await this.database.query<ExternalSkillDefinitionRow>(
      `SELECT ${COLUMNS} FROM external_skill_definitions
       WHERE agent_id = $1 AND connection_id = $2 ORDER BY skill_name ASC`,
      [agentId, connectionId],
    );
    return rows.map(mapRecord);
  }

  async update(
    agentId: string,
    id: string,
    input: UpdateExternalSkillDefinitionInput,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    const [row] = await this.database.query<ExternalSkillDefinitionRow>(
      `UPDATE external_skill_definitions SET
         bound_params = COALESCE($3::jsonb, bound_params),
         exposed_params = COALESCE($4::jsonb, exposed_params),
         declared_outcomes = COALESCE($5, declared_outcomes),
         outcome_map = COALESCE($6::jsonb, outcome_map),
         enabled = COALESCE($7, enabled),
         updated_at = NOW()
       WHERE agent_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
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
    const affected = await this.database.execute(
      `DELETE FROM external_skill_definitions WHERE agent_id = $1 AND id = $2`,
      [agentId, id],
    );
    return affected > 0;
  }
}
