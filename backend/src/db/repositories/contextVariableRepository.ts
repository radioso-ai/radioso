import { randomUUID } from "node:crypto";

import type { ResolvedVariableInput } from "../../modules/context-variables/public.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableSensitivity,
  ContextVariableSource,
  ContextVariableTrustTier,
  ContextVariableValue,
  ContextVariableValueType,
} from "../../modules/context-variables/public.js";
import type { ContextVariableSurfacing } from "../../modules/context-variables/public.js";
import { badRequest, conflict } from "../../shared/domain/errors.js";
import { currentTimestamp, optionalTimestampMatch, timestampMatchOrAbsent, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface ContextVariableCreateRecord {
  workspaceId: string;
  name: string;
  description?: string | null;
  valueType: ContextVariableValueType;
  trustTier: ContextVariableTrustTier;
  sensitivity: ContextVariableSensitivity;
  defaultSurfacing: ContextVariableSurfacing;
}

export interface ContextVariableUpdateRecord {
  name?: string;
  description?: string | null;
  valueType?: ContextVariableValueType;
  trustTier?: ContextVariableTrustTier;
  sensitivity?: ContextVariableSensitivity;
  defaultSurfacing?: ContextVariableSurfacing;
}

export interface AgentContextVariableEnablementRecord {
  agentId: string;
  variableId: string;
  source: ContextVariableSource;
  resolverSkillId?: string | null;
  maxAgeSeconds?: number | null;
  resolverTimeoutMs?: number | null;
  surfacing: ContextVariableSurfacing;
  enabled?: boolean;
}

/** Full replacement value for a variable's definition, used only by {@link ApplyContextVariableProposalInput}. */
export interface ContextVariableDefinitionWrite {
  readonly name: string;
  readonly description: string | null;
  readonly valueType: ContextVariableValueType;
  readonly trustTier: ContextVariableTrustTier;
  readonly sensitivity: ContextVariableSensitivity;
  readonly defaultSurfacing: ContextVariableSurfacing;
}

/** Full replacement value for one agent's enablement, used only by {@link ApplyContextVariableProposalInput}. */
export interface ContextVariableEnablementWrite {
  readonly source: ContextVariableSource;
  readonly resolverSkillId: string | null;
  readonly maxAgeSeconds: number | null;
  readonly resolverTimeoutMs: number | null;
  readonly surfacing: ContextVariableSurfacing;
  readonly enabled: boolean;
}

export interface ApplyContextVariableProposalInput {
  readonly workspaceId: string;
  readonly agentId: string;
  /** Existing variable id, or null to create a new variable. */
  readonly variableId: string | null;
  /** Definition create/update, or null when the proposal only touches the enablement. */
  readonly definition: ContextVariableDefinitionWrite | null;
  /**
   * Required (and enforced) only when variableId is set and definition is non-null: the
   * variable's `updated_at` at draft time. Ignored for a fresh insert (variableId null) — there is
   * nothing yet to race against.
   */
  readonly expectedVariableUpdatedAt: Date | null;
  /** Enablement upsert, or null when the proposal only touches the definition. */
  readonly enablement: ContextVariableEnablementWrite | null;
  /**
   * Draft-time enablement `updated_at`, or `null` when no enablement existed for this
   * agent+variable at draft time (the proposal expects a fresh insert). Ignored when enablement
   * is null.
   */
  readonly expectedEnablementUpdatedAt: Date | null;
}

export interface ApplyContextVariableProposalResult {
  readonly variableId: string;
}

export interface ContextVariableRepositoryPort {
  create(input: ContextVariableCreateRecord): Promise<ContextVariable>;
  update(workspaceId: string, id: string, input: ContextVariableUpdateRecord): Promise<ContextVariable | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
  listByWorkspace(workspaceId: string): Promise<ContextVariable[]>;
  get(workspaceId: string, id: string): Promise<ContextVariable | null>;

  upsertEnablement(input: AgentContextVariableEnablementRecord): Promise<AgentContextVariableEnablement>;
  deleteEnablement(agentId: string, variableId: string): Promise<boolean>;
  listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;

  upsertValue(variableId: string, scope: ContextVariableScope, data: unknown): Promise<ContextVariableValue>;
  readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null>;
  deleteValue(variableId: string, scope: ContextVariableScope): Promise<boolean>;

  resolveForAgent(
    workspaceId: string,
    agentId: string,
    scopes: ContextVariableScope[],
  ): Promise<ResolvedVariableInput[]>;

  /**
   * Applies a copilot proposal's definition write, enablement write, or both as a single
   * all-or-nothing transaction, each write version-gated in its own predicate rather than by a
   * separate read-then-compare. Throws a `conflict` AppError (not a discriminated "stale" return)
   * when either write's version guard fails, so a partially-applied write is always rolled back —
   * a definition update that would have succeeded on its own must not survive a stale enablement
   * write, and vice versa. A brand-new variable (`variableId: null`) has no earlier row to
   * version-gate against, so a replayed apply is instead caught by, and also throws `conflict`
   * for, the workspace+name uniqueness constraint the insert itself would violate.
   */
  applyProposal(input: ApplyContextVariableProposalInput): Promise<ApplyContextVariableProposalResult>;
}

interface ContextVariableRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  value_type: string;
  trust_tier: string;
  sensitivity: string;
  default_surfacing: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AgentContextVariableRow {
  id: string;
  agent_id: string;
  variable_id: string;
  source: string;
  resolver_skill_id: string | null;
  max_age_seconds: number | null;
  resolver_timeout_ms: number | null;
  surfacing: string;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AgentContextVariableWithVariableRow extends AgentContextVariableRow {
  variable_workspace_id: string;
  variable_name: string;
  variable_description: string | null;
  variable_value_type: string;
  variable_trust_tier: string;
  variable_sensitivity: string;
  variable_default_surfacing: string;
  variable_created_at: Date | string;
  variable_updated_at: Date | string;
}

interface ContextVariableValueRow {
  id: string;
  workspace_id: string;
  variable_id: string;
  scope_type: string;
  scope_id: string;
  data: unknown;
  last_modified: Date | string;
}

const contextVariableColumns = [
  "id",
  "workspace_id",
  "name",
  "description",
  "value_type",
  "trust_tier",
  "sensitivity",
  "default_surfacing",
  "created_at",
  "updated_at",
] as const;

const agentContextVariableColumns = [
  "id",
  "agent_id",
  "variable_id",
  "source",
  "resolver_skill_id",
  "max_age_seconds",
  "resolver_timeout_ms",
  "surfacing",
  "enabled",
  "created_at",
  "updated_at",
] as const;

const contextVariableValueColumns = [
  "id",
  "workspace_id",
  "variable_id",
  "scope_type",
  "scope_id",
  "data",
  "last_modified",
] as const;

const mapContextVariableRow = (row: ContextVariableRow): ContextVariable => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  description: row.description,
  valueType: row.value_type as ContextVariableValueType,
  trustTier: row.trust_tier as ContextVariableTrustTier,
  sensitivity: row.sensitivity as ContextVariableSensitivity,
  defaultSurfacing: row.default_surfacing as ContextVariableSurfacing,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapAgentContextVariableRow = (
  row: AgentContextVariableRow,
  variable?: ContextVariable,
): AgentContextVariableEnablement => ({
  id: row.id,
  agentId: row.agent_id,
  variableId: row.variable_id,
  source: row.source as ContextVariableSource,
  resolverSkillId: row.resolver_skill_id,
  maxAgeSeconds: row.max_age_seconds,
  resolverTimeoutMs: row.resolver_timeout_ms,
  surfacing: row.surfacing as ContextVariableSurfacing,
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  variable,
});

const mapAgentContextVariableWithVariableRow = (
  row: AgentContextVariableWithVariableRow,
): AgentContextVariableEnablement => mapAgentContextVariableRow(row, {
  id: row.variable_id,
  workspaceId: row.variable_workspace_id,
  name: row.variable_name,
  description: row.variable_description,
  valueType: row.variable_value_type as ContextVariableValueType,
  trustTier: row.variable_trust_tier as ContextVariableTrustTier,
  sensitivity: row.variable_sensitivity as ContextVariableSensitivity,
  defaultSurfacing: row.variable_default_surfacing as ContextVariableSurfacing,
  createdAt: new Date(row.variable_created_at),
  updatedAt: new Date(row.variable_updated_at),
});

const mapContextVariableValueRow = (row: ContextVariableValueRow): ContextVariableValue => ({
  id: row.id,
  workspaceId: row.workspace_id,
  variableId: row.variable_id,
  scope: {
    type: row.scope_type as ContextVariableScope["type"],
    id: row.scope_id,
  },
  data: row.data,
  lastModified: new Date(row.last_modified),
});

// Mirrors RoutineDefinitionService's isRoutineDefinitionNameVersionConstraintError: applyProposal
// is the only writer of a brand-new context_variables row that has no earlier read to compare
// against (see the comment on ApplyContextVariableProposalInput.expectedVariableUpdatedAt), so a
// name collision from a replayed apply can only be caught here, at the constraint itself. Without
// this translation the raw pg driver error is not an AppError, so the copilot's isStale() check
// never recognizes it and the proposal is left reporting "failed" instead of "stale" even though
// the variable this same request created is sitting right there.
const isContextVariableNameConflict = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return record.code === "23505" &&
    (
      record.constraint === "context_variables_workspace_id_name_key" ||
      (typeof record.message === "string" && record.message.includes("context_variables_workspace_id_name_key"))
    );
};

type ResolverSkillLockState = "missing" | "disabled" | "enabled";

const lockResolverSkillForProposal = async (
  db: Db,
  input: { workspaceId: string; agentId: string; resolverSkillId: string },
): Promise<ResolverSkillLockState> => {
  const skill = await db
    .selectFrom("agent_skills")
    .select("enabled")
    .where("id", "=", input.resolverSkillId)
    .where("agent_id", "=", input.agentId)
    .where("workspace_id", "=", input.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  return !skill ? "missing" : skill.enabled ? "enabled" : "disabled";
};

const lockResolverSkillForEnablement = async (
  db: Db,
  input: { agentId: string; variableId: string; resolverSkillId: string },
): Promise<ResolverSkillLockState> => {
  const skill = await db
    .selectFrom("agent_skills")
    .innerJoin("context_variables", "context_variables.workspace_id", "agent_skills.workspace_id")
    .select("agent_skills.enabled")
    .where("agent_skills.id", "=", input.resolverSkillId)
    .where("agent_skills.agent_id", "=", input.agentId)
    .where("context_variables.id", "=", input.variableId)
    .forUpdate()
    .executeTakeFirst();
  return !skill ? "missing" : skill.enabled ? "enabled" : "disabled";
};

export class ContextVariableRepository implements ContextVariableRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: ContextVariableCreateRecord): Promise<ContextVariable> {
    const row = await this.db
      .insertInto("context_variables")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
        value_type: input.valueType,
        trust_tier: input.trustTier,
        sensitivity: input.sensitivity,
        default_surfacing: input.defaultSurfacing,
      })
      .returning(contextVariableColumns)
      .executeTakeFirstOrThrow();
    return mapContextVariableRow(row as ContextVariableRow);
  }

  async update(workspaceId: string, id: string, input: ContextVariableUpdateRecord): Promise<ContextVariable | null> {
    const row = await this.db
      .updateTable("context_variables")
      .set({
        updated_at: currentTimestamp(),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...("description" in input ? { description: input.description ?? null } : {}),
        ...(input.valueType !== undefined ? { value_type: input.valueType } : {}),
        ...(input.trustTier !== undefined ? { trust_tier: input.trustTier } : {}),
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.defaultSurfacing !== undefined ? { default_surfacing: input.defaultSurfacing } : {}),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(contextVariableColumns)
      .executeTakeFirst();
    return row ? mapContextVariableRow(row as ContextVariableRow) : null;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("context_variables")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  async listByWorkspace(workspaceId: string): Promise<ContextVariable[]> {
    const rows = await this.db
      .selectFrom("context_variables")
      .select(contextVariableColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("name", "asc")
      .execute();
    return rows.map((row) => mapContextVariableRow(row as ContextVariableRow));
  }

  async get(workspaceId: string, id: string): Promise<ContextVariable | null> {
    const row = await this.db
      .selectFrom("context_variables")
      .select(contextVariableColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapContextVariableRow(row as ContextVariableRow) : null;
  }

  async upsertEnablement(input: AgentContextVariableEnablementRecord): Promise<AgentContextVariableEnablement> {
    return this.db.transaction().execute(async (trx) => {
      if (input.source === "resolver" && input.resolverSkillId) {
        const state = await lockResolverSkillForEnablement(trx, {
          agentId: input.agentId,
          variableId: input.variableId,
          resolverSkillId: input.resolverSkillId,
        });
        if (state === "missing") {
          throw badRequest(`resolverSkillId "${input.resolverSkillId}" does not name an enabled skill on this agent`);
        }
        if (state === "disabled") {
          throw badRequest(`resolverSkillId "${input.resolverSkillId}" names a skill that is disabled on this agent`);
        }
      }

      const row = await trx
        .insertInto("agent_context_variables")
        .values({
          id: randomUUID(),
          agent_id: input.agentId,
          variable_id: input.variableId,
          source: input.source,
          resolver_skill_id: input.resolverSkillId ?? null,
          max_age_seconds: input.maxAgeSeconds ?? null,
          resolver_timeout_ms: input.resolverTimeoutMs ?? null,
          surfacing: input.surfacing,
          enabled: input.enabled ?? true,
        })
        .onConflict((oc) =>
          oc.columns(["agent_id", "variable_id"]).doUpdateSet((eb) => ({
            source: eb.ref("excluded.source"),
            resolver_skill_id: eb.ref("excluded.resolver_skill_id"),
            max_age_seconds: eb.ref("excluded.max_age_seconds"),
            resolver_timeout_ms: eb.ref("excluded.resolver_timeout_ms"),
            surfacing: eb.ref("excluded.surfacing"),
            enabled: eb.ref("excluded.enabled"),
            updated_at: currentTimestamp(),
          })),
        )
        .returning(agentContextVariableColumns)
        .executeTakeFirstOrThrow();
      return mapAgentContextVariableRow(row as AgentContextVariableRow);
    });
  }

  async deleteEnablement(agentId: string, variableId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_context_variables")
      .where("agent_id", "=", agentId)
      .where("variable_id", "=", variableId)
      .executeTakeFirst();
    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]> {
    const rows = await this.db
      .selectFrom("agent_context_variables")
      .innerJoin("context_variables", "context_variables.id", "agent_context_variables.variable_id")
      .select([
        "agent_context_variables.id",
        "agent_context_variables.agent_id",
        "agent_context_variables.variable_id",
        "agent_context_variables.source",
        "agent_context_variables.resolver_skill_id",
        "agent_context_variables.max_age_seconds",
        "agent_context_variables.resolver_timeout_ms",
        "agent_context_variables.surfacing",
        "agent_context_variables.enabled",
        "agent_context_variables.created_at",
        "agent_context_variables.updated_at",
        "context_variables.workspace_id as variable_workspace_id",
        "context_variables.name as variable_name",
        "context_variables.description as variable_description",
        "context_variables.value_type as variable_value_type",
        "context_variables.trust_tier as variable_trust_tier",
        "context_variables.sensitivity as variable_sensitivity",
        "context_variables.default_surfacing as variable_default_surfacing",
        "context_variables.created_at as variable_created_at",
        "context_variables.updated_at as variable_updated_at",
      ])
      .where("context_variables.workspace_id", "=", workspaceId)
      .where("agent_context_variables.agent_id", "=", agentId)
      .orderBy("context_variables.name", "asc")
      .execute();
    return rows.map((row) => mapAgentContextVariableWithVariableRow(row as AgentContextVariableWithVariableRow));
  }

  async upsertValue(variableId: string, scope: ContextVariableScope, data: unknown): Promise<ContextVariableValue> {
    const variable = await this.db
      .selectFrom("context_variables")
      .select(["workspace_id"])
      .where("id", "=", variableId)
      .executeTakeFirstOrThrow();

    const row = await this.db
      .insertInto("context_variable_values")
      .values({
        id: randomUUID(),
        workspace_id: variable.workspace_id,
        variable_id: variableId,
        scope_type: scope.type,
        scope_id: scope.id,
        data: toJsonb(data),
        last_modified: currentTimestamp(),
      })
      .onConflict((oc) =>
        oc.columns(["variable_id", "scope_type", "scope_id"]).doUpdateSet((eb) => ({
          workspace_id: eb.ref("excluded.workspace_id"),
          data: eb.ref("excluded.data"),
          last_modified: currentTimestamp(),
        })),
      )
      .returning(contextVariableValueColumns)
      .executeTakeFirstOrThrow();
    return mapContextVariableValueRow(row as ContextVariableValueRow);
  }

  async readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null> {
    const row = await this.db
      .selectFrom("context_variable_values")
      .select(contextVariableValueColumns)
      .where("variable_id", "=", variableId)
      .where("scope_type", "=", scope.type)
      .where("scope_id", "=", scope.id)
      .executeTakeFirst();
    return row ? mapContextVariableValueRow(row as ContextVariableValueRow) : null;
  }

  async deleteValue(variableId: string, scope: ContextVariableScope): Promise<boolean> {
    const result = await this.db
      .deleteFrom("context_variable_values")
      .where("variable_id", "=", variableId)
      .where("scope_type", "=", scope.type)
      .where("scope_id", "=", scope.id)
      .executeTakeFirst();
    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  async resolveForAgent(
    workspaceId: string,
    agentId: string,
    scopes: ContextVariableScope[],
  ): Promise<ResolvedVariableInput[]> {
    const enablements = (await this.listByAgent(workspaceId, agentId))
      .filter((enablement) => enablement.enabled && enablement.source === "pushed" && enablement.variable);
    const resolved: ResolvedVariableInput[] = [];

    for (const enablement of enablements) {
      const variable = enablement.variable;
      if (!variable) {
        continue;
      }
      const value = await this.readFirstScopedValue(variable.id, scopes);
      if (!value) {
        continue;
      }
      resolved.push({
        name: variable.name,
        description: variable.description,
        value: value.data,
        surfacing: enablement.surfacing,
        sensitive: variable.sensitivity === "sensitive",
        trust: variable.trustTier === "signed" ? "verified" : "unverified",
      });
    }

    return resolved;
  }

  private async readFirstScopedValue(
    variableId: string,
    scopes: readonly ContextVariableScope[],
  ): Promise<ContextVariableValue | null> {
    for (const scope of scopes) {
      const value = await this.readValue(variableId, scope);
      if (value) {
        return value;
      }
    }
    return null;
  }

  async applyProposal(input: ApplyContextVariableProposalInput): Promise<ApplyContextVariableProposalResult> {
    return this.db.transaction().execute(async (trx) => {
      let variableId = input.variableId;

      if (input.definition) {
        if (variableId) {
          // Wrapped the same way the insert branch below is: a rename onto another variable's
          // name hits the identical context_variables_workspace_id_name_key constraint, just
          // through UPDATE instead of INSERT. The copilot adapter's own draft-time name check
          // (copilotProposalAdapters.ts's resolveProposal) closes the common case, but a second
          // proposal can still take the name between this proposal's draft and its Apply: without
          // this translation that raw pg driver error isn't an AppError, so isStale() never
          // recognizes it and the proposal reports "failed" instead of "stale".
          let row: { id: string } | undefined;
          try {
            row = await trx
              .updateTable("context_variables")
              .set({
                updated_at: currentTimestamp(),
                name: input.definition.name,
                description: input.definition.description,
                value_type: input.definition.valueType,
                trust_tier: input.definition.trustTier,
                sensitivity: input.definition.sensitivity,
                default_surfacing: input.definition.defaultSurfacing,
              })
              .where("workspace_id", "=", input.workspaceId)
              .where("id", "=", variableId)
              .where((eb) => optionalTimestampMatch(eb.ref("updated_at"), input.expectedVariableUpdatedAt))
              .returning(["id"])
              .executeTakeFirst();
          } catch (error) {
            if (isContextVariableNameConflict(error)) {
              throw conflict(`A context variable named "${input.definition.name}" already exists for this workspace`);
            }
            throw error;
          }
          if (!row) {
            throw conflict("Context variable was updated by another writer; reload before saving again");
          }
        } else {
          try {
            const created = await trx
              .insertInto("context_variables")
              .values({
                id: randomUUID(),
                workspace_id: input.workspaceId,
                name: input.definition.name,
                description: input.definition.description,
                value_type: input.definition.valueType,
                trust_tier: input.definition.trustTier,
                sensitivity: input.definition.sensitivity,
                default_surfacing: input.definition.defaultSurfacing,
              })
              .returning(["id"])
              .executeTakeFirstOrThrow();
            variableId = created.id;
          } catch (error) {
            if (isContextVariableNameConflict(error)) {
              throw conflict(`A context variable named "${input.definition.name}" already exists for this workspace`);
            }
            throw error;
          }
        }
      }

      if (input.enablement) {
        if (!variableId) {
          throw badRequest("Cannot enable a context variable with no resolved id");
        }
        if (!input.definition) {
          // Nothing above already proved this row still exists: the definition branch either
          // just inserted a fresh one (variableId came from that INSERT) or re-checked an
          // existing one's presence via its own UPDATE...WHERE id (throwing conflict when it
          // found no row). An enablement-only proposal has no definition write to piggyback that
          // proof on, and agent_context_variables.variable_id carries no foreign key check here
          // otherwise - a proposal can sit pending indefinitely, and this variable can just as
          // easily be deleted between draft and Apply as the resolver skill below can, so without
          // this the insert below would raise a raw agent_context_variables_variable_id_fkey
          // violation instead of the same stale-proposal contract every other check here upholds.
          // Locked (SELECT ... FOR UPDATE), matching the resolver-skill check immediately below,
          // so a concurrent delete cannot land between this check and the insert.
          const variableRow = await trx
            .selectFrom("context_variables")
            .select("id")
            .where("workspace_id", "=", input.workspaceId)
            .where("id", "=", variableId)
            .forUpdate()
            .executeTakeFirst();
          if (!variableRow) {
            throw conflict("Context variable no longer exists");
          }
        }
        if (input.enablement.source === "resolver" && input.enablement.resolverSkillId) {
          const state = await lockResolverSkillForProposal(trx, {
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            resolverSkillId: input.enablement.resolverSkillId,
          });
          if (state === "missing") {
            throw conflict(`Resolver skill "${input.enablement.resolverSkillId}" no longer exists on this agent`);
          }
          if (state === "disabled") {
            throw conflict(`Resolver skill "${input.enablement.resolverSkillId}" is disabled on this agent`);
          }
        }
        const row = await trx
          .insertInto("agent_context_variables")
          .values({
            id: randomUUID(),
            agent_id: input.agentId,
            variable_id: variableId,
            source: input.enablement.source,
            resolver_skill_id: input.enablement.resolverSkillId,
            max_age_seconds: input.enablement.maxAgeSeconds,
            resolver_timeout_ms: input.enablement.resolverTimeoutMs,
            surfacing: input.enablement.surfacing,
            enabled: input.enablement.enabled,
          })
          .onConflict((oc) =>
            oc.columns(["agent_id", "variable_id"]).doUpdateSet((eb) => ({
              source: eb.ref("excluded.source"),
              resolver_skill_id: eb.ref("excluded.resolver_skill_id"),
              max_age_seconds: eb.ref("excluded.max_age_seconds"),
              resolver_timeout_ms: eb.ref("excluded.resolver_timeout_ms"),
              surfacing: eb.ref("excluded.surfacing"),
              enabled: eb.ref("excluded.enabled"),
              updated_at: currentTimestamp(),
            // Qualified with the table name: inside ON CONFLICT ... DO UPDATE ... WHERE, an
            // unqualified column is ambiguous between the target row and the `excluded` row.
            })).where((eb) => timestampMatchOrAbsent(eb.ref("agent_context_variables.updated_at"), input.expectedEnablementUpdatedAt)),
          )
          .returning(["id"])
          .executeTakeFirst();
        if (!row) {
          throw conflict("Context variable enablement was updated by another writer; reload before saving again");
        }
      }

      if (!variableId) {
        throw badRequest("A context variable proposal must include a definition or target an existing variable");
      }
      return { variableId };
    });
  }
}
