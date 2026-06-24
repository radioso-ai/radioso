import { randomUUID } from "node:crypto";

import type {
  WebhookSkillDefinitionSummary,
} from "../../modules/webhookSkills/domain.js";
import { currentTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

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

const webhookSkillColumns = [
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

const selectWebhookSkills = (db: Db) =>
  db.selectFrom("agent_skills").select(webhookSkillColumns).where("kind", "=", "webhook");

export class WebhookSkillDefinitionRepository implements WebhookSkillDefinitionRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateWebhookSkillDefinitionInput): Promise<WebhookSkillDefinitionRecord> {
    const config = {
      boundPayload: input.boundPayload ?? {},
      exposedPayload: input.exposedPayload ?? {},
    };
    const row = await this.db
      .insertInto("agent_skills")
      .values({
        id: randomUUID(),
        agent_id: input.agentId,
        workspace_id: input.workspaceId,
        skill_name: input.skillName,
        kind: "webhook",
        enabled: input.enabled ?? true,
        target_type: "webhook_destination",
        target_id: input.destinationId,
        config: toJsonb(config),
      })
      .returning(webhookSkillColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as WebhookSkillDefinitionRow);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<WebhookSkillDefinitionRecord | null> {
    const row = await selectWebhookSkills(this.db)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as WebhookSkillDefinitionRow) : null;
  }

  async findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<WebhookSkillDefinitionRecord | null> {
    const row = await selectWebhookSkills(this.db)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .where("enabled", "=", true)
      .executeTakeFirst();
    return row ? mapRecord(row as WebhookSkillDefinitionRow) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<WebhookSkillDefinitionRecord[]> {
    const rows = await selectWebhookSkills(this.db)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as WebhookSkillDefinitionRow));
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateWebhookSkillDefinitionInput,
  ): Promise<WebhookSkillDefinitionRecord | null> {
    // Only the provided sub-keys are merged into config (config || {...}); an empty object
    // is a no-op merge, matching the original COALESCE($::jsonb, '{}').
    const config = {
      ...("boundPayload" in input ? { boundPayload: input.boundPayload ?? {} } : {}),
      ...("exposedPayload" in input ? { exposedPayload: input.exposedPayload ?? {} } : {}),
    };
    const row = await this.db
      .updateTable("agent_skills")
      .set((eb) => ({
        ...(input.enabled != null ? { enabled: input.enabled } : {}),
        config: jsonbConcat(eb.ref("config"), toJsonb(config)),
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "webhook")
      .returning(webhookSkillColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as WebhookSkillDefinitionRow) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_skills")
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "webhook")
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async countByDestination(workspaceId: string, destinationId: string): Promise<number> {
    const row = await this.db
      .selectFrom("agent_skills")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("kind", "=", "webhook")
      .where("workspace_id", "=", workspaceId)
      .where("target_type", "=", "webhook_destination")
      .where("target_id", "=", destinationId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async listSkillNamesByDestination(workspaceId: string, destinationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("agent_skills")
      .select("skill_name")
      .where("kind", "=", "webhook")
      .where("workspace_id", "=", workspaceId)
      .where("target_type", "=", "webhook_destination")
      .where("target_id", "=", destinationId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => row.skill_name);
  }
}
