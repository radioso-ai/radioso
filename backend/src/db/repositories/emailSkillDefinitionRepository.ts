import { randomUUID } from "node:crypto";

import type {
  CustomerEmailSkillMode,
  CustomerEmailSkillDefinitionSummary,
} from "../../modules/customerEmail/domain.js";
import { currentTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

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
const emailSkillColumns = [
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

const selectEmailSkills = (db: Db) =>
  db.selectFrom("agent_skills").select(emailSkillColumns).where("kind", "=", "customer_email");

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
  constructor(private readonly db: Db) {}

  async create(input: CreateEmailSkillDefinitionInput): Promise<EmailSkillDefinitionRecord> {
    const config = {
      mode: input.mode,
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
        kind: "customer_email",
        enabled: input.enabled ?? true,
        target_type: "customer_email_connection",
        target_id: input.connectionId,
        config: toJsonb(config),
      })
      .returning(emailSkillColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as EmailSkillDefinitionRow);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<EmailSkillDefinitionRecord | null> {
    const row = await selectEmailSkills(this.db)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as EmailSkillDefinitionRow) : null;
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<EmailSkillDefinitionRecord | null> {
    const row = await selectEmailSkills(this.db)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .where("enabled", "=", true)
      .executeTakeFirst();
    return row ? mapRecord(row as EmailSkillDefinitionRow) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<EmailSkillDefinitionRecord[]> {
    const rows = await selectEmailSkills(this.db)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as EmailSkillDefinitionRow));
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
      .where("kind", "=", "customer_email")
      .returning(emailSkillColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as EmailSkillDefinitionRow) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_skills")
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("kind", "=", "customer_email")
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async countByConnection(workspaceId: string, connectionId: string): Promise<number> {
    const row = await this.db
      .selectFrom("agent_skills")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("kind", "=", "customer_email")
      .where("workspace_id", "=", workspaceId)
      .where("target_type", "=", "customer_email_connection")
      .where("target_id", "=", connectionId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}
