import { randomUUID } from "node:crypto";

import { currentTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
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
const externalSkillColumns = [
  "id",
  "agent_id",
  "target_id",
  "skill_name",
  "config",
  "enabled",
  "created_at",
  "updated_at",
] as const;

const selectExternalSkills = (db: Db) =>
  db.selectFrom("agent_skills").select(externalSkillColumns).where("kind", "=", "external_mcp");

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
  constructor(private readonly db: Db) {}

  async create(input: CreateExternalSkillDefinitionInput): Promise<ExternalSkillDefinitionRecord> {
    const config = {
      toolName: input.toolName,
      boundParams: input.boundParams ?? {},
      exposedParams: input.exposedParams ?? {},
      declaredOutcomes: input.declaredOutcomes ?? null,
      outcomeMap: input.outcomeMap ?? null,
    };
    // INSERT ... SELECT FROM agents derives workspace_id from the agent.
    const row = await this.db
      .insertInto("agent_skills")
      .columns(["id", "agent_id", "workspace_id", "skill_name", "kind", "enabled", "target_type", "target_id", "config"])
      .expression((eb) =>
        eb
          .selectFrom("agents as a")
          .select([
            eb.val(randomUUID()).as("id"),
            eb.val(input.agentId).as("agent_id"),
            "a.workspace_id",
            eb.val(input.skillName).as("skill_name"),
            eb.val("external_mcp").as("kind"),
            eb.val(input.enabled ?? true).as("enabled"),
            eb.val("mcp_connection").as("target_type"),
            eb.val(input.connectionId).as("target_id"),
            toJsonb(config).as("config"),
          ])
          .where("a.id", "=", input.agentId),
      )
      .returning(externalSkillColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as ExternalSkillDefinitionRow);
  }

  async findById(agentId: string, id: string): Promise<ExternalSkillDefinitionRecord | null> {
    const row = await selectExternalSkills(this.db)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as ExternalSkillDefinitionRow) : null;
  }

  async findEnabledByName(
    agentId: string,
    skillName: string,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    const row = await selectExternalSkills(this.db)
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .where("enabled", "=", true)
      .executeTakeFirst();
    return row ? mapRecord(row as ExternalSkillDefinitionRow) : null;
  }

  async listByAgent(agentId: string): Promise<ExternalSkillDefinitionRecord[]> {
    const rows = await selectExternalSkills(this.db)
      .where("agent_id", "=", agentId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as ExternalSkillDefinitionRow));
  }

  async listByConnection(
    agentId: string,
    connectionId: string,
  ): Promise<ExternalSkillDefinitionRecord[]> {
    const rows = await selectExternalSkills(this.db)
      .where("agent_id", "=", agentId)
      .where("target_type", "=", "mcp_connection")
      .where("target_id", "=", connectionId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as ExternalSkillDefinitionRow));
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
    const row = await this.db
      .updateTable("agent_skills")
      .set((eb) => ({
        ...(input.enabled != null ? { enabled: input.enabled } : {}),
        config: jsonbConcat(eb.ref("config"), toJsonb(config)),
        updated_at: currentTimestamp(),
      }))
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "external_mcp")
      .returning(externalSkillColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as ExternalSkillDefinitionRow) : null;
  }

  async remove(agentId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_skills")
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "external_mcp")
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
