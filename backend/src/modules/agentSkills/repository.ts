import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";
import { currentTimestamp, optionalTimestampMatch, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import { mergeSkillConfig } from "./configMerge.js";
import type { AgentSkillInvocationMode, AgentSkillKind, AgentSkillSpine } from "./domain.js";

export interface AgentSkillCreateRecord {
  workspaceId: string;
  agentId: string;
  skillName: string;
  kind: AgentSkillKind;
  targetType?: string | null;
  targetId?: string | null;
  config?: Record<string, unknown>;
  invocationMode: AgentSkillInvocationMode;
  enabled?: boolean;
}

export interface AgentSkillUpdateRecord {
  targetType?: string | null;
  targetId?: string | null;
  config?: Record<string, unknown>;
  replaceConfig?: Record<string, unknown>;
  invocationMode?: AgentSkillInvocationMode;
  enabled?: boolean;
  /**
   * Optional optimistic-concurrency guard, enforced in the UPDATE's own WHERE predicate: when
   * supplied, the update is a no-op (returns null) unless the row's current `updated_at` matches.
   * Omitted entirely by callers that do not need version gating (the pre-existing default).
   */
  expectedUpdatedAt?: Date;
}

export interface AgentSkillRepositoryPort {
  create(input: AgentSkillCreateRecord): Promise<AgentSkillSpine>;
  findById(workspaceId: string, agentId: string, id: string): Promise<AgentSkillSpine | null>;
  findByName(workspaceId: string, agentId: string, skillName: string): Promise<AgentSkillSpine | null>;
  findByAgentAndName(agentId: string, skillName: string): Promise<AgentSkillSpine | null>;
  findDefaultAnswer(workspaceId: string, agentId: string): Promise<AgentSkillSpine | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<AgentSkillSpine[]>;
  /** Every skill in the workspace, across agents — for workspace-wide projections. */
  listByWorkspace(workspaceId: string): Promise<AgentSkillSpine[]>;
  update(workspaceId: string, agentId: string, id: string, input: AgentSkillUpdateRecord): Promise<AgentSkillSpine | null>;
  remove(workspaceId: string, agentId: string, id: string): Promise<boolean>;
}

// Loosely typed so the Kysely `selectAll()`/`returningAll()` row (jsonb → JsonValue,
// enum columns → string, timestamps → Timestamp) maps in via a single cast, then
// `mapRow` narrows back to the domain enums.
interface AgentSkillRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  skill_name: string;
  kind: string;
  target_type: string | null;
  target_id: string | null;
  config: unknown;
  invocation_mode: string;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const mapRow = (row: AgentSkillRow): AgentSkillSpine => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  skillName: row.skill_name,
  kind: row.kind as AgentSkillKind,
  targetType: row.target_type,
  targetId: row.target_id,
  config: (row.config as Record<string, unknown> | null) ?? {},
  invocationMode: row.invocation_mode as AgentSkillInvocationMode,
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class AgentSkillRepository implements AgentSkillRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: AgentSkillCreateRecord): Promise<AgentSkillSpine> {
    const row = await this.db
      .insertInto("agent_skills")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        skill_name: input.skillName,
        kind: input.kind,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        config: toJsonb(input.config ?? {}),
        invocation_mode: input.invocationMode,
        enabled: input.enabled ?? true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapRow(row as AgentSkillRow);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRow(row as AgentSkillRow) : null;
  }

  async findByName(workspaceId: string, agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .executeTakeFirst();
    return row ? mapRow(row as AgentSkillRow) : null;
  }

  async findByAgentAndName(agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .executeTakeFirst();
    return row ? mapRow(row as AgentSkillRow) : null;
  }

  async findDefaultAnswer(workspaceId: string, agentId: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("invocation_mode", "=", "default_answer")
      .executeTakeFirst();
    return row ? mapRow(row as AgentSkillRow) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<AgentSkillSpine[]> {
    const rows = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRow(row as AgentSkillRow));
  }

  async listByWorkspace(workspaceId: string): Promise<AgentSkillSpine[]> {
    const rows = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("skill_name", "asc")
      .execute();
    return rows.map((row) => mapRow(row as AgentSkillRow));
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
  ): Promise<AgentSkillSpine | null> {
    if (input.config !== undefined && input.replaceConfig === undefined) {
      return this.updateWithConfigMerge(workspaceId, agentId, id, input);
    }
    return this.applyUpdate(this.db, workspaceId, agentId, id, input, input.replaceConfig);
  }

  /**
   * A partial `config` patch deep-merges into the row's *current* stored config (recurses into
   * plain objects, replaces arrays/scalars outright the patch supplies - see `mergeSkillConfig`),
   * which a single UPDATE statement's jsonb `||` can only do shallowly. Computing that merge in
   * application code makes this a read-modify-write, so the read and the write share one
   * transaction, and the read takes `FOR UPDATE`: the row lock blocks a concurrent writer from
   * reading a base until this transaction commits, so two concurrent partial patches to different
   * nested keys (e.g. notify's `delivery.recipientEmails` and `delivery.webhook`) serialize and
   * compose instead of one silently clobbering the other. `expectedUpdatedAt`, when supplied, is
   * still enforced in the final UPDATE's own WHERE predicate underneath that lock.
   */
  private async updateWithConfigMerge(
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
  ): Promise<AgentSkillSpine | null> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("agent_skills")
        .select("config")
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) {
        return null;
      }
      const mergedConfig = mergeSkillConfig((existing.config as Record<string, unknown> | null) ?? {}, input.config);
      return this.applyUpdate(trx, workspaceId, agentId, id, input, mergedConfig);
    });
  }

  private async applyUpdate(
    executor: Db,
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
    config: Record<string, unknown> | undefined,
  ): Promise<AgentSkillSpine | null> {
    const row = await executor
      .updateTable("agent_skills")
      .set({
        updated_at: currentTimestamp(),
        // Mirror the prior COALESCE/CASE semantics: target_type updates only when a
        // value is supplied; target_id distinguishes an explicit null (key present)
        // from "leave unchanged" (key absent).
        ...(input.targetType != null ? { target_type: input.targetType } : {}),
        ...("targetId" in input ? { target_id: input.targetId ?? null } : {}),
        ...(config !== undefined ? { config: toJsonb(config) } : {}),
        ...(input.invocationMode != null ? { invocation_mode: input.invocationMode } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      })
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where((eb) => optionalTimestampMatch(eb.ref("updated_at"), input.expectedUpdatedAt))
      .returningAll()
      .executeTakeFirst();
    return row ? mapRow(row as AgentSkillRow) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_skills")
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return (result?.numDeletedRows ?? 0n) > 0n;
  }
}
