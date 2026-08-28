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
  /**
   * The most recent write to any of an agent's skills — including a delete that leaves none
   * remaining — `null` when the agent has never had one. `agents.updated_at` never moves when a
   * skill is created, edited, or removed, so a caller that needs to know whether "this agent's
   * effective configuration" changed cannot answer that from the `agents` row alone.
   */
  latestUpdatedAt(workspaceId: string, agentId: string): Promise<Date | null>;
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
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
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
      await this.touchSkillsWatermark(trx, input.workspaceId, input.agentId);
      return mapRow(row as AgentSkillRow);
    });
  }

  /**
   * Advances the durable per-agent skills freshness watermark `latestUpdatedAt` reads — touched
   * in the same transaction as the write it accompanies, so it shares that write's `now()`
   * (Postgres fixes `now()` for the whole transaction) and therefore reports the identical
   * instant a create/update's own `updated_at` does. Kept off `agents.updated_at` itself: that
   * column also backs optimistic-concurrency version tokens for unrelated proposal types
   * (directive, agent_setting, routine) on the same agent, so bumping it here would make those go
   * spuriously stale on every skill edit.
   */
  private async touchSkillsWatermark(executor: Db, workspaceId: string, agentId: string): Promise<void> {
    await executor
      .insertInto("agent_skills_watermarks")
      .values({ agent_id: agentId, workspace_id: workspaceId, updated_at: currentTimestamp() })
      .onConflict((oc) => oc.column("agent_id").doUpdateSet({ updated_at: currentTimestamp() }))
      .execute();
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
    return this.db.transaction().execute(async (trx) => {
      const row = input.config !== undefined && input.replaceConfig === undefined
        ? await this.updateWithConfigMerge(trx, workspaceId, agentId, id, input)
        : await this.applyUpdate(trx, workspaceId, agentId, id, input, input.replaceConfig);
      if (row) {
        await this.touchSkillsWatermark(trx, workspaceId, agentId);
      }
      return row;
    });
  }

  /**
   * A partial `config` patch deep-merges into the row's *current* stored config (recurses into
   * plain objects, replaces arrays/scalars outright the patch supplies - see `mergeSkillConfig`),
   * which a single UPDATE statement's jsonb `||` can only do shallowly. Computing that merge in
   * application code makes this a read-modify-write, so the read and the write share the caller's
   * transaction, and the read takes `FOR UPDATE`: the row lock blocks a concurrent writer from
   * reading a base until this transaction commits, so two concurrent partial patches to different
   * nested keys (e.g. notify's `delivery.recipientEmails` and `delivery.webhook`) serialize and
   * compose instead of one silently clobbering the other. `expectedUpdatedAt`, when supplied, is
   * still enforced in the final UPDATE's own WHERE predicate underneath that lock.
   */
  private async updateWithConfigMerge(
    trx: Db,
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
  ): Promise<AgentSkillSpine | null> {
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
    return this.db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom("agent_skills")
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .where("id", "=", id)
        .executeTakeFirst();
      const removed = (result?.numDeletedRows ?? 0n) > 0n;
      // A delete must advance the watermark too, not just a create/update: MAX(updated_at) over
      // surviving agent_skills rows leaves this unchanged (or lower) after a delete, so evidence
      // captured before the delete would still read as fresh — see latestUpdatedAt below.
      if (removed) {
        await this.touchSkillsWatermark(trx, workspaceId, agentId);
      }
      return removed;
    });
  }

  /**
   * The most recent write to any of an agent's skills — create, update, *or delete*. `MAX(watermark,
   * MAX(agent_skills.updated_at))`, not either alone: `MAX(agent_skills.updated_at)` over surviving
   * rows leaves a deletion unreported (the max is unchanged or lower) and reads as `null`, not
   * "recently changed", once the agent's last skill is removed — the watermark this class's own
   * `create`/`update`/`remove` touch closes that gap. But a handful of per-capability skill kinds
   * (webhook, customer_email, external_mcp, slack) are still written through their own dedicated
   * repositories that share the `agent_skills` table without touching this watermark, so the
   * surviving-rows max stays in the comparison too: dropping it would stop reporting *their*
   * creates and edits, not just fail to report their deletes.
   */
  async latestUpdatedAt(workspaceId: string, agentId: string): Promise<Date | null> {
    const [watermark, rows] = await Promise.all([
      this.db
        .selectFrom("agent_skills_watermarks")
        .select("updated_at")
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .executeTakeFirst(),
      this.db
        .selectFrom("agent_skills")
        .select((eb) => eb.fn.max<Date | string | null>("updated_at").as("latest"))
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .executeTakeFirst(),
    ]);
    const candidates = [
      watermark?.updated_at ? new Date(watermark.updated_at) : null,
      rows?.latest ? new Date(rows.latest) : null,
    ].filter((value): value is Date => value !== null);
    if (candidates.length === 0) {
      return null;
    }
    return new Date(Math.max(...candidates.map((value) => value.getTime())));
  }
}
