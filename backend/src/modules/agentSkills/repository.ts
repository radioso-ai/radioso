import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";

import type { DB, Db } from "../../shared/infra/kysely/types.js";
import { currentTimestamp, optionalTimestampMatch, toJsonb, toSanitizedJsonb, transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import { agentRevisionLockKey, withAgentDraftMutation } from "../../db/repositories/agentDraftMutation.js";
import { parseAgentRevisionSnapshot } from "../agents/public.js";
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
  /**
   * Optional post-lock revalidation hook for the config-merge path (`updateWithConfigMerge`
   * only - a `replaceConfig` write already persists exactly the object the caller validated, so
   * there is no later merge to recheck). Called with the config actually about to be written -
   * the deep merge computed *after* the row's FOR UPDATE lock is held, against whatever the row
   * currently holds, not the caller's earlier pre-lock read - so it can veto a write by throwing.
   * A thrown error aborts the transaction (nothing is persisted) and propagates out of `update`.
   *
   * This exists because the caller (AgentSkillsService) validates one candidate before this
   * method ever runs, but this method recomputes the merge itself once it actually holds the
   * lock: two individually-valid concurrent partial patches can compose, under the lock, into a
   * config nobody validated. The repository owns the lock and the merge; it does not know
   * capability validation rules, so it accepts them as a callback instead of duplicating them.
   */
  validateMergedConfig?: (mergedConfig: Record<string, unknown>) => void;
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

  /**
   * Also projects the new skill into the agent's draft revision snapshot, in the same
   * transaction, so a conversation pinned to a frozen revision never observes this write
   * (see `agentSkillTurnSkillProvider.ts`). When the draft predates skill tracking
   * (`snapshot.agentSkills` absent), it re-reads the live table instead of seeding just
   * this one row, so pre-existing skills are not silently dropped from the snapshot.
   */
  async create(input: AgentSkillCreateRecord): Promise<AgentSkillSpine> {
    return withAgentDraftMutation(this.db, input.workspaceId, input.agentId, async (trx, snapshot) => {
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
      const spine = mapRow(row);
      const agentSkills = snapshot.agentSkills
        ? [...snapshot.agentSkills, spine]
        : await new AgentSkillRepository(trx).listByAgent(input.workspaceId, input.agentId);
      return { result: spine, snapshot: { ...snapshot, agentSkills } };
    });
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findByName(workspaceId: string, agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findByAgentAndName(agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("skill_name", "=", skillName)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findDefaultAnswer(workspaceId: string, agentId: string): Promise<AgentSkillSpine | null> {
    const row = await this.db
      .selectFrom("agent_skills")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("invocation_mode", "=", "default_answer")
      .executeTakeFirst();
    return row ? mapRow(row) : null;
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

  /**
   * Also projects the outcome into the draft revision snapshot, inside the same
   * transaction/lock the config-merge already runs in — unlike `create`, `update`
   * deliberately tolerates a foreign/nonexistent `agentId` as a silent no-op (existing,
   * tested contract: the row-scoped WHERE clause below simply matches nothing), so this
   * cannot use `withAgentDraftMutation`, which requires a draft row to exist up front.
   * `syncDraftAgentSkill` below only projects when a draft row for this agent actually
   * exists; a real agent lacking one is a data-integrity condition this repository does
   * not paper over.
   */
  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
  ): Promise<AgentSkillSpine | null> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
      const updated = input.config !== undefined && input.replaceConfig === undefined
        ? await this.updateWithConfigMerge(trx, workspaceId, agentId, id, input)
        : await this.applyUpdate(trx, workspaceId, agentId, id, input, input.replaceConfig);
      if (!updated) {
        return null;
      }
      await this.syncDraftAgentSkill(trx, workspaceId, agentId, (agentSkills) =>
        agentSkills?.map((skill) => (skill.id === id ? updated : skill)));
      return updated;
    });
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
   * still enforced in the final UPDATE's own WHERE predicate underneath that lock. `input.
   * validateMergedConfig`, when supplied, runs against this merge - the actual config about to
   * be written, not the caller's pre-lock candidate - and can veto the write by throwing, so a
   * second concurrent patch that composes into an invalid config is refused instead of persisted.
   *
   * The transaction/lock this used to open for itself now comes from `update`'s enclosing
   * `withAgentDraftMutation` call instead: that already holds a stronger, agent-scoped
   * advisory lock serializing every draft-affecting writer for this agent, so the FOR
   * UPDATE row lock below remains belt-and-suspenders rather than the sole guard.
   */
  private async updateWithConfigMerge(
    trx: Transaction<DB>,
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
    input.validateMergedConfig?.(mergedConfig);
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
    return row ? mapRow(row) : null;
  }

  /**
   * Also removes the skill from the draft revision snapshot in the same transaction
   * (same "foreign agentId is a no-op" rationale as `update`).
   */
  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
      const result = await trx
        .deleteFrom("agent_skills")
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .where("id", "=", id)
        .executeTakeFirst();
      const deleted = (result?.numDeletedRows ?? 0n) > 0n;
      if (!deleted) {
        return false;
      }
      await this.syncDraftAgentSkill(trx, workspaceId, agentId, (agentSkills) =>
        agentSkills?.filter((skill) => skill.id !== id));
      return true;
    });
  }

  /**
   * Projects an already-applied agent_skills write into the draft revision snapshot,
   * when (and only when) a draft row exists for this agent. `next` receives the
   * currently-tracked list (`undefined` when this draft predates skill tracking) and
   * either returns the updated list, or `undefined` to signal "not tracked yet" —
   * which reads the live table (already reflecting the write this transaction just
   * made) instead, so a draft that has never tracked skills is seeded with the full
   * current set rather than silently starting from just this one change.
   */
  private async syncDraftAgentSkill(
    trx: Transaction<DB>,
    workspaceId: string,
    agentId: string,
    next: (agentSkills: AgentSkillSpine[] | undefined) => AgentSkillSpine[] | undefined,
  ): Promise<void> {
    const draft = await trx
      .selectFrom("agent_drafts")
      .select(["generation", "snapshot"])
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    if (!draft) {
      return;
    }
    const snapshot = parseAgentRevisionSnapshot(draft.snapshot);
    // See agentRevision.ts: the snapshot's agentSkills entries are validated-shape-but-open
    // strings for kind/invocationMode, not the narrower runtime enums, so this repository
    // (which already validated them once via AgentSkillsService before they were ever
    // written) casts back to AgentSkillSpine at this boundary.
    const currentAgentSkills = snapshot.agentSkills as unknown as AgentSkillSpine[] | undefined;
    const agentSkills = next(currentAgentSkills) ?? await new AgentSkillRepository(trx).listByAgent(workspaceId, agentId);
    await trx
      .updateTable("agent_drafts")
      .set({
        generation: draft.generation + 1,
        snapshot: toSanitizedJsonb({ ...snapshot, agentSkills }),
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("generation", "=", draft.generation)
      .execute();
  }
}
