import { randomUUID } from "node:crypto";

import { currentTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  SlackSkillDefinitionSummary,
  SlackSkillDefinitionUpdateInput,
} from "./domain.js";

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

// The columns the SELECT/RETURNING projections expose (the slack skill view of
// agent_skills). `target_id` carries the Slack installation id.
const SKILL_COLUMNS = [
  "id",
  "workspace_id",
  "agent_id",
  "target_id",
  "skill_name",
  "config",
  "enabled",
  "created_at",
  "updated_at",
] as const;

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
  findById(workspaceId: string, agentId: string, id: string): Promise<SlackSkillDefinitionSummary | null>;
  findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<SlackSkillDefinitionSummary | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<SlackSkillDefinitionSummary[]>;
  update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: SlackSkillDefinitionUpdateInput,
  ): Promise<SlackSkillDefinitionSummary | null>;
  remove(workspaceId: string, agentId: string, id: string): Promise<boolean>;
}

export class SlackSkillDefinitionRepository implements SlackSkillDefinitionRepositoryPort {
  constructor(private readonly db: Db) {}

  // Base select scoped to the slack-kind rows of agent_skills.
  private selectSlackSkills() {
    return this.db.selectFrom("agent_skills").select(SKILL_COLUMNS).where("kind", "=", "slack");
  }

  async create(input: CreateSlackSkillDefinitionInput): Promise<SlackSkillDefinitionSummary> {
    const config = {
      boundInputs: input.boundInputs ?? {},
      exposedInputs: input.exposedInputs ?? {},
    };
    const row = await this.db
      .insertInto("agent_skills")
      .values({
        id: randomUUID(),
        agent_id: input.agentId,
        workspace_id: input.workspaceId,
        skill_name: input.skillName,
        kind: "slack",
        enabled: input.enabled ?? true,
        target_type: "slack_installation",
        target_id: input.installationId,
        config: toJsonb(config),
      })
      .returning(SKILL_COLUMNS)
      .executeTakeFirstOrThrow();
    return mapRecord(row as unknown as SlackSkillDefinitionRow);
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<SlackSkillDefinitionSummary | null> {
    const row = await this.selectSlackSkills()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .where("enabled", "=", true)
      .executeTakeFirst();
    return row ? mapRecord(row as unknown as SlackSkillDefinitionRow) : null;
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<SlackSkillDefinitionSummary | null> {
    const row = await this.selectSlackSkills()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as unknown as SlackSkillDefinitionRow) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<SlackSkillDefinitionSummary[]> {
    const rows = await this.selectSlackSkills()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as unknown as SlackSkillDefinitionRow));
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: SlackSkillDefinitionUpdateInput,
  ): Promise<SlackSkillDefinitionSummary | null> {
    const config = {
      ...("boundInputs" in input ? { boundInputs: input.boundInputs ?? {} } : {}),
      ...("exposedInputs" in input ? { exposedInputs: input.exposedInputs ?? {} } : {}),
    };
    // Mirror the raw COALESCE semantics exactly: enabled stays when not provided;
    // config is shallow-merged only when there is something to merge (an empty
    // config patch leaves the stored config untouched, like `|| '{}'::jsonb`).
    const enabled = "enabled" in input ? input.enabled ?? null : null;
    const hasConfig = Object.keys(config).length > 0;
    const row = await this.db
      .updateTable("agent_skills")
      .set((eb) => ({
        enabled: eb.fn.coalesce(eb.val(enabled), eb.ref("enabled")),
        ...(hasConfig ? { config: jsonbConcat(eb.ref("config"), toJsonb(config)) } : {}),
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "slack")
      .returning(SKILL_COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row as unknown as SlackSkillDefinitionRow) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_skills")
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "slack")
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
