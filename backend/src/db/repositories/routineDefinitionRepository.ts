import { randomUUID } from "node:crypto";

import { sql, type Transaction } from "kysely";

import {
  routineDefinitionDraftInputSchema,
  routineReentryModes,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionDeleteDraftResult,
  type RoutineApprovalOption,
  type RoutineFieldGuardOp,
  type RoutineFieldGuardUnit,
  type RoutineGuardKind,
  type RoutineReentryMode,
  type RoutineSlotType,
  type RoutineStepKind,
  type RoutineTerminalKind,
} from "../../modules/routines/public.js";
import { toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import { withAgentDraftMutation } from "./agentDraftMutation.js";
import { mapDirectiveRow, type AgentDirectiveRow } from "./agentRepository.js";
import type { AgentRevisionSnapshot } from "../../modules/agents/public.js";
import {
  projectDirectiveScopeTagsForSelectedRoutines,
  selectCanonicalRoutineDefinitions,
} from "../../modules/routines/draftProjection.js";
import { answerCoverageCriteriaSchema } from "../../modules/answerCoverage/public.js";

interface RoutineDefinitionRow {
  id: string;
  agent_id: string;
  lineage_id: string;
  name: string;
  version: number;
  enabled: boolean;
  activation_trigger_description: string;
  activation_gate_ref: string | null;
  activation_priority: number;
  activation_reentry_mode: string;
  activation_coverage_criteria: unknown;
  slots: unknown;
  steps: unknown;
  transitions: unknown;
  terminals: unknown;
  completion_export: unknown;
  created_at: Date;
  updated_at: Date;
}

interface RoutineTriggerEmbeddingSearchRow {
  routine_id: string;
  distance: number | null;
  no_vector: boolean;
}

interface RoutineTriggerEmbeddingSearchResult {
  matches: Array<{ routineId: string; distance: number }>;
  noVectorRoutineIds: string[];
}

/**
 * The canonical row of a lineage: its highest version.
 *
 * Nothing branches a lineage any more — a routine is one row, created at version 1 — so this only
 * collapses history authored before that, and `idx_routine_definition_lineage_version` makes the
 * choice total and stable. Reads address it, writes target it, and the older rows stay in the
 * table for a pinned conversation to resume from.
 */
const canonicalLineageRow = sql<boolean>`d.version = (SELECT MAX(v.version) FROM routine_definition v WHERE v.lineage_id = d.lineage_id)`;

/**
 * Resolves `id` to its lineage's canonical (highest-version) row: shared by `findByIdOn`'s
 * full-graph read and `resolveCanonicalId`'s scalar lookup so the two can never drift on what
 * "the row this id addresses" means.
 */
const canonicalRowForId = (agentId: string, id: string) => sql`
  d.agent_id = ${agentId}
    AND d.lineage_id = (SELECT lineage_id FROM routine_definition WHERE agent_id = ${agentId} AND id = ${id})
  ORDER BY d.version DESC
  LIMIT 1
`;

// A row's timestamptz carries microseconds; the Date a caller read back from it carries
// milliseconds, so an equality guard has to compare at the precision both sides can hold. Same
// comparison the agent and directive writers use for their own expectedUpdatedAt guards.
const matchesExpectedUpdatedAt = (expectedUpdatedAt: Date) =>
  sql<boolean>`date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz)`;

/**
 * Advances an authored-write token at the precision JavaScript Date preserves.
 *
 * Postgres timestamps carry microseconds while the service boundary carries milliseconds. Plain
 * `now()` can therefore produce two distinct database values that collapse to one client token,
 * allowing a stale guard to match. The previous value plus one millisecond is the lower bound;
 * `now()` keeps the timestamp aligned with wall time when the database clock is ahead.
 */
const nextAuthoredUpdatedAt = () =>
  sql<Date>`greatest(now(), updated_at + interval '1 millisecond')`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

const readNullableString = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null;

const readNumber = (record: Record<string, unknown>, key: string): number =>
  typeof record[key] === "number" ? record[key] : 0;

const readBoolean = (record: Record<string, unknown>, key: string): boolean =>
  typeof record[key] === "boolean" ? record[key] : false;

const readMetadata = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  asRecord(record[key]);

// A field guard's comparison value is a string, number, or boolean (or absent). It rides
// in a jsonb column, so it arrives already typed — pass it through, drop anything else.
const readFieldValue = (record: Record<string, unknown>, key: string): string | number | boolean | null => {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
};

const readFieldValues = (record: Record<string, unknown>, key: string): (string | number | boolean)[] | null => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const primitives = value.filter((entry): entry is string | number | boolean =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  // An empty list is not a valid `in` guard (the domain enforces min(1)); surface it as
  // absent rather than a never-matching `values: []` the compiler would still spread.
  return primitives.length > 0 ? primitives : null;
};

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord) : [];

// An approval step's options ride in a jsonb column. Read back the {id,label,description?}
// shape the domain expects, dropping anything malformed. Absent for non-approval steps.
const readApprovalOptions = (record: Record<string, unknown>, key: string): RoutineApprovalOption[] | null => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(asRecord)
    .filter((option) => typeof option.id === "string" && typeof option.label === "string")
    .map((option) => ({
      id: option.id as string,
      label: option.label as string,
      description: typeof option.description === "string" ? option.description : null,
    }));
  return options.length > 0 ? options : null;
};

const normalizeStepKind = (kind: string): RoutineStepKind =>
  kind === "fork" ? "chat" : kind as RoutineStepKind;

const normalizeGuardKind = (kind: string): RoutineGuardKind =>
  kind === "always" || kind === "fallback" ? "default" : kind as RoutineGuardKind;

// The full definition projection: a routine plus its children rolled up via json_agg in
// LATERAL subqueries. Expressed with the Kysely `sql` tag (the sanctioned escape hatch for
// complex read SQL) rather than the builder — the LATERAL/json_build_object shape would be
// far noisier in the query builder, and `mapRow` depends on these exact object keys. Runs
// through Kysely on the shared pool, so it counts as migrated. The trailing WHERE/ORDER BY
// is appended per call site as a `sql` fragment.
const definitionSelect = sql`
  SELECT
    d.id::text,
    d.agent_id::text,
    d.lineage_id::text,
    d.name,
    d.version,
    d.enabled,
    d.activation_trigger_description,
    d.activation_gate_ref,
    d.activation_priority,
    d.activation_reentry_mode,
    d.activation_coverage_criteria,
    COALESCE(slots.items, '[]'::json) AS slots,
    COALESCE(steps.items, '[]'::json) AS steps,
    COALESCE(transitions.items, '[]'::json) AS transitions,
    COALESCE(terminals.items, '[]'::json) AS terminals,
    completion_export.item AS completion_export,
    d.created_at,
    d.updated_at
  FROM routine_definition d
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
      'stableSlotId', s.stable_slot_id,
      'key', s.key,
      'type', s.type,
      'required', s.required,
      'description', s.description,
      'ordinal', s.ordinal,
      'mutable', s.mutable
    ) ORDER BY s.ordinal ASC, s.stable_slot_id ASC) AS items
    FROM routine_slot s
    WHERE s.definition_id = d.id
  ) slots ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
      'stableStepId', st.stable_step_id,
      'kind', st.kind,
      'instruction', st.instruction,
      'toolRef', st.tool_ref,
      'actionType', st.action_type,
      'captureKey', st.capture_key,
      'options', st.options,
      'ordinal', st.ordinal,
      'metadata', st.metadata
    ) ORDER BY st.ordinal ASC, st.stable_step_id ASC) AS items
    FROM routine_step st
    WHERE st.definition_id = d.id
  ) steps ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
      'fromStep', tr.from_step,
      'toRef', tr.to_ref,
      'guardKind', tr.guard_kind,
      'guardText', tr.guard_text,
      'outcomeStatus', tr.outcome_status,
      'counterLimit', tr.counter_limit,
      'fieldRef', tr.field_ref,
      'fieldOp', tr.field_op,
      'fieldValue', tr.field_value,
      'fieldValues', tr.field_values,
      'fieldUnit', tr.field_unit,
      'ordinal', tr.ordinal
    ) ORDER BY tr.ordinal ASC, tr.from_step ASC, tr.to_ref ASC) AS items
    FROM routine_transition tr
    WHERE tr.definition_id = d.id
  ) transitions ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
      'stableStepId', te.stable_step_id,
      'kind', te.kind,
      'instruction', te.instruction,
      'ordinal', te.ordinal
    ) ORDER BY te.ordinal ASC, te.stable_step_id ASC) AS items
    FROM routine_terminal te
    WHERE te.definition_id = d.id
  ) terminals ON true
  LEFT JOIN LATERAL (
    SELECT json_build_object(
      'enabled', ce.enabled,
      'triggerKinds', ce.trigger_kinds,
      'destinationRef', ce.destination_ref::text
    ) AS item
    FROM routine_completion_export ce
    WHERE ce.definition_id = d.id
  ) completion_export ON true
`;

const mapRow = (row: RoutineDefinitionRow): RoutineDefinition => ({
  id: row.id,
  agentId: row.agent_id,
  lineageId: row.lineage_id,
  name: row.name,
  version: row.version,
  enabled: row.enabled,
  activation: {
    triggerDescription: row.activation_trigger_description,
    gateRef: row.activation_gate_ref,
    priority: row.activation_priority,
    reentryMode: routineReentryModes.includes(row.activation_reentry_mode as RoutineReentryMode)
      ? (row.activation_reentry_mode as RoutineReentryMode)
      : "once_per_conversation",
    ...(answerCoverageCriteriaSchema.safeParse(row.activation_coverage_criteria).success
      ? { coverageCriteria: answerCoverageCriteriaSchema.parse(row.activation_coverage_criteria) }
      : {}),
  },
  slots: asArray(row.slots).map((slot) => ({
    stableSlotId: readString(slot, "stableSlotId"),
    key: readString(slot, "key"),
    type: readString(slot, "type") as RoutineSlotType,
    required: readBoolean(slot, "required"),
    description: readNullableString(slot, "description"),
    ordinal: readNumber(slot, "ordinal"),
    ...(readBoolean(slot, "mutable") ? { mutable: true } : {}),
  })),
  steps: asArray(row.steps).map((step) => {
    // captureKey/options are only valid on approval steps; the domain rejects them on any
    // other kind, so include them only when present (NULL columns on every other step).
    const captureKey = readNullableString(step, "captureKey");
    const options = readApprovalOptions(step, "options");
    return {
      stableStepId: readString(step, "stableStepId"),
      kind: normalizeStepKind(readString(step, "kind")),
      instruction: readString(step, "instruction"),
      toolRef: readNullableString(step, "toolRef"),
      actionType: readNullableString(step, "actionType"),
      ...(captureKey !== null ? { captureKey } : {}),
      ...(options !== null ? { options } : {}),
      ordinal: readNumber(step, "ordinal"),
      metadata: readMetadata(step, "metadata"),
    };
  }),
  transitions: asArray(row.transitions).map((transition) => ({
    fromStep: readString(transition, "fromStep"),
    toRef: readString(transition, "toRef"),
    guardKind: normalizeGuardKind(readString(transition, "guardKind")),
    guardText: readNullableString(transition, "guardText"),
    outcomeStatus: readNullableString(transition, "outcomeStatus"),
    counterLimit: readNumber(transition, "counterLimit") || null,
    fieldRef: readNullableString(transition, "fieldRef"),
    fieldOp: readNullableString(transition, "fieldOp") as RoutineFieldGuardOp | null,
    fieldValue: readFieldValue(transition, "fieldValue"),
    fieldValues: readFieldValues(transition, "fieldValues"),
    fieldUnit: readNullableString(transition, "fieldUnit") as RoutineFieldGuardUnit | null,
    ordinal: readNumber(transition, "ordinal"),
  })),
  terminals: asArray(row.terminals).map((terminal) => ({
    stableStepId: readString(terminal, "stableStepId"),
    kind: readString(terminal, "kind") as RoutineTerminalKind,
    instruction: readNullableString(terminal, "instruction"),
    ordinal: readNumber(terminal, "ordinal"),
  })),
  completionExport: (() => {
    const exportRecord = asRecord(row.completion_export);
    return {
      enabled: readBoolean(exportRecord, "enabled"),
      triggerKinds: Array.isArray(exportRecord.triggerKinds)
        ? exportRecord.triggerKinds.filter((kind): kind is RoutineTerminalKind =>
            kind === "complete" || kind === "handoff"
          )
        : [],
      destinationRef: readString(exportRecord, "destinationRef"),
    };
  })(),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class RoutineDefinitionRepository {
  constructor(private readonly db: Db) {}

  /**
   * The routines that may activate for a new conversation: canonical and enabled. SQL's own
   * expression of the same rule `routineCanActivate` (modules/routines/compiler.ts) applies to a
   * frozen agent revision snapshot, which has no database to query against.
   */
  async listActiveByAgent(agentId: string): Promise<RoutineDefinition[]> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND d.enabled AND ${canonicalLineageRow}
      ORDER BY d.activation_priority DESC, d.created_at ASC, d.id ASC
    `.execute(this.db);
    return result.rows.map(mapRow);
  }

  /** The authoring read surface: one row per routine. */
  async listByAgent(agentId: string): Promise<RoutineDefinition[]> {
    return this.listByAgentOn(this.db, agentId);
  }

  /**
   * Every stored version, newest last. Only two readers need history: resolving a pre-cutover
   * `routine:<agent>:<name>:v<n>` pin, and re-pointing a directive scope tag that names a row a
   * lineage branched past before routines collapsed to one row.
   */
  async listVersionsByAgent(agentId: string): Promise<RoutineDefinition[]> {
    return this.listVersionsByAgentOn(this.db, agentId);
  }

  async findById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    return this.findByIdOn(this.db, agentId, id);
  }

  /**
   * These variants keep the normalized routine graph and the agent draft projection in one
   * transaction, so a routine edit lands in the agent's private draft the same way a directive
   * or skill edit does. Application composition never gets a post-commit hook.
   */
  async createDraftWithAgentDraft(
    workspaceId: string,
    agentId: string,
    input: RoutineDefinitionDraftInput,
  ): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    return this.mutateAgentDraft(workspaceId, agentId, async (trx) => {
      const id = randomUUID();
      await trx.insertInto("routine_definition").values({
        id,
        agent_id: agentId,
        version: 1,
        name: draft.name,
        // The retired lifecycle column still carries a CHECK constraint and still gates the
        // webhook-destination triggers. 'published' keeps both satisfied for a routine that is
        // live the moment the agent's draft is released.
        status: "published",
        enabled: draft.enabled,
        activation_trigger_description: draft.activation.triggerDescription,
        activation_gate_ref: draft.activation.gateRef,
        activation_priority: draft.activation.priority,
        activation_reentry_mode: draft.activation.reentryMode,
        activation_coverage_criteria: draft.activation.coverageCriteria ? toJsonb(draft.activation.coverageCriteria) : null,
        lineage_id: id,
      }).execute();
      await this.replaceChildren(trx, id, draft);
      return this.requireDefinition(trx, agentId, id);
    });
  }

  async updateDraftWithAgentDraft(
    workspaceId: string,
    agentId: string,
    id: string,
    input: RoutineDefinitionDraftInput,
    options: { expectedUpdatedAt?: Date } = {},
  ): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    return this.mutateAgentDraft(workspaceId, agentId, async (trx) => {
      // Writes target the canonical row whatever its stored status says, so a routine authored
      // before the collapse stays editable through the id its lineage is addressed by.
      const current = await this.findByIdOn(trx, agentId, id);
      if (!current) throw new Error(`routine_definition_update_conflict:${id}`);
      const updated = await trx.updateTable("routine_definition")
        .set({
          name: draft.name,
          enabled: draft.enabled,
          activation_trigger_description: draft.activation.triggerDescription,
          activation_gate_ref: draft.activation.gateRef,
          activation_priority: draft.activation.priority,
          activation_reentry_mode: draft.activation.reentryMode,
          activation_coverage_criteria: draft.activation.coverageCriteria ? toJsonb(draft.activation.coverageCriteria) : null,
          updated_at: nextAuthoredUpdatedAt(),
        })
        .where("agent_id", "=", agentId)
        .where("id", "=", current.id)
        .$if(options.expectedUpdatedAt !== undefined, (query) => query.where(matchesExpectedUpdatedAt(options.expectedUpdatedAt!)))
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new Error(`routine_definition_update_conflict:${id}`);
      await this.replaceChildren(trx, current.id, draft);
      return this.requireDefinition(trx, agentId, current.id);
    });
  }

  /**
   * Takes a routine in or out of service without touching its authored graph, so a list-row
   * toggle cannot rewrite steps the caller never read.
   */
  async setEnabledWithAgentDraft(
    workspaceId: string,
    agentId: string,
    id: string,
    enabled: boolean,
  ): Promise<RoutineDefinition | null> {
    return this.mutateAgentDraft(workspaceId, agentId, async (trx) => {
      const current = await this.findByIdOn(trx, agentId, id);
      if (!current) return null;
      await trx.updateTable("routine_definition")
        .set({ enabled, updated_at: nextAuthoredUpdatedAt() })
        .where("agent_id", "=", agentId)
        .where("id", "=", current.id)
        .execute();
      return this.requireDefinition(trx, agentId, current.id);
    });
  }

  async deleteDraftWithAgentDraft(
    workspaceId: string,
    agentId: string,
    id: string,
    options: { expectedUpdatedAt?: Date } = {},
  ): Promise<RoutineDefinitionDeleteDraftResult> {
    return this.mutateAgentDraft(workspaceId, agentId, async (trx) => {
      const current = await this.findByIdOn(trx, agentId, id);
      if (!current) return { outcome: "not_found" };
      if (options.expectedUpdatedAt && current.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
        return { outcome: "conflict" };
      }
      return this.deleteLineageOn(trx, agentId, current, options);
    });
  }

  private async findByIdOn(db: Db, agentId: string, id: string): Promise<RoutineDefinition | null> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE ${canonicalRowForId(agentId, id)}
    `.execute(db);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /** The scalar half of `findByIdOn`, for a caller that only needs the canonical row's own id. */
  private async resolveCanonicalId(db: Db, agentId: string, id: string): Promise<string | null> {
    const result = await sql<{ id: string }>`
      SELECT d.id::text
      FROM routine_definition d
      WHERE ${canonicalRowForId(agentId, id)}
    `.execute(db);
    return result.rows[0]?.id ?? null;
  }

  /**
   * Resume-only lookup for a routine_states pin: the exact stored row, not its lineage's
   * canonical one. A visitor mid-routine finishes the version they started, including one an
   * operator has since replaced or disabled.
   */
  async findPinnedById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND d.id = ${id}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async getTriggerEmbeddingMetadata(
    agentId: string,
    routineId: string,
  ): Promise<{ hash: string | null; model: string | null } | null> {
    const row = await this.db
      .selectFrom("routine_definition")
      .select(["trigger_embedding_hash", "trigger_embedding_model"])
      .where("agent_id", "=", agentId)
      .where("id", "=", routineId)
      .executeTakeFirst();
    return row ? { hash: row.trigger_embedding_hash, model: row.trigger_embedding_model } : null;
  }

  async saveTriggerEmbedding(input: {
    agentId: string;
    routineId: string;
    embedding: readonly number[];
    model: string;
    hash: string;
  }): Promise<void> {
    const vector = `[${input.embedding.join(",")}]`;
    // Typeless ::vector on purpose: workspace embedding models differ in width
    // and this column carries no fixed-dimension index (see migration 128).
    await this.db
      .updateTable("routine_definition")
      .set({
        trigger_embedding: sql<string>`${vector}::vector`,
        trigger_embedding_model: input.model,
        trigger_embedding_hash: input.hash,
      })
      .where("agent_id", "=", input.agentId)
      .where("id", "=", input.routineId)
      .execute();
  }

  async clearTriggerEmbedding(input: { agentId: string; routineId: string }): Promise<void> {
    await this.db
      .updateTable("routine_definition")
      .set({
        trigger_embedding: null,
        trigger_embedding_model: null,
        trigger_embedding_hash: null,
      })
      .where("agent_id", "=", input.agentId)
      .where("id", "=", input.routineId)
      .execute();
  }

  async searchActivationTriggerEmbeddings(input: {
    candidateRoutineIds: readonly string[];
    embeddingModel: string;
    queryEmbedding: readonly number[];
    topK: number;
  }): Promise<RoutineTriggerEmbeddingSearchResult> {
    if (input.candidateRoutineIds.length === 0) {
      return { matches: [], noVectorRoutineIds: [] };
    }
    const queryVector = `[${input.queryEmbedding.join(",")}]`;
    const result = await sql<RoutineTriggerEmbeddingSearchRow>`
      WITH candidates AS MATERIALIZED (
        SELECT id, trigger_embedding, trigger_embedding_model
        FROM routine_definition
        WHERE id = ANY(${input.candidateRoutineIds}::uuid[])
      ), nearest AS (
        -- The model-equality predicate also guarantees dimension compatibility
        -- for <=>: stored vectors under the query's model share its width.
        SELECT id::text AS routine_id,
               trigger_embedding <=> ${queryVector}::vector AS distance,
               false AS no_vector
        FROM candidates
        WHERE trigger_embedding IS NOT NULL
          AND trigger_embedding_model = ${input.embeddingModel}
        ORDER BY trigger_embedding <=> ${queryVector}::vector ASC
        LIMIT ${input.topK}
      ), no_vector AS (
        SELECT id::text AS routine_id,
               NULL::double precision AS distance,
               true AS no_vector
        FROM candidates
        WHERE trigger_embedding IS NULL
          OR trigger_embedding_model IS DISTINCT FROM ${input.embeddingModel}
      )
      SELECT routine_id, distance, no_vector FROM nearest
      UNION ALL
      SELECT routine_id, distance, no_vector FROM no_vector
    `.execute(this.db);
    return {
      matches: result.rows.flatMap((row) =>
        row.no_vector || row.distance === null ? [] : [{ routineId: row.routine_id, distance: Number(row.distance) }]
      ),
      noVectorRoutineIds: result.rows.flatMap((row) => row.no_vector ? [row.routine_id] : []),
    };
  }

  async createDraft(agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    const id = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("routine_definition")
        .values({
          id,
          agent_id: agentId,
          version: 1,
          name: draft.name,
          status: "published",
          enabled: draft.enabled,
          activation_trigger_description: draft.activation.triggerDescription,
          activation_gate_ref: draft.activation.gateRef,
          activation_priority: draft.activation.priority,
          activation_reentry_mode: draft.activation.reentryMode,
          activation_coverage_criteria: draft.activation.coverageCriteria ? toJsonb(draft.activation.coverageCriteria) : null,
          lineage_id: id,
        })
        .execute();
      await this.replaceChildren(trx, id, draft);
    });
    const loaded = await this.findById(agentId, id);
    if (!loaded) {
      throw new Error(`routine_definition_not_found:${id}`);
    }
    return loaded;
  }

  async updateDraft(
    agentId: string,
    id: string,
    input: RoutineDefinitionDraftInput,
    options: { expectedUpdatedAt?: Date } = {},
  ): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    // A scalar id lookup, not the full graph read `findById` would do: every field this method
    // touches is either supplied by the caller's draft or is the row's own identity.
    const canonicalId = await this.resolveCanonicalId(this.db, agentId, id);
    if (!canonicalId) {
      throw new Error(`routine_definition_update_conflict:${id}`);
    }
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("routine_definition")
        .set({
          name: draft.name,
          enabled: draft.enabled,
          activation_trigger_description: draft.activation.triggerDescription,
          activation_gate_ref: draft.activation.gateRef,
          activation_priority: draft.activation.priority,
          activation_reentry_mode: draft.activation.reentryMode,
          activation_coverage_criteria: draft.activation.coverageCriteria ? toJsonb(draft.activation.coverageCriteria) : null,
          updated_at: nextAuthoredUpdatedAt(),
        })
        .where("agent_id", "=", agentId)
        .where("id", "=", canonicalId)
        .$if(options.expectedUpdatedAt !== undefined, (query) => query.where(matchesExpectedUpdatedAt(options.expectedUpdatedAt!)))
        .returning("id")
        .execute();
      // A caller that supplied expectedUpdatedAt lands here for a racing edit: its decision was
      // made against content this row no longer holds, so abort before touching children.
      if (updated.length === 0) {
        throw new Error(`routine_definition_update_conflict:${id}`);
      }
      await this.replaceChildren(trx, canonicalId, draft);
    });
    const loaded = await this.findById(agentId, canonicalId);
    if (!loaded) {
      throw new Error(`routine_definition_not_found:${canonicalId}`);
    }
    return loaded;
  }

  async deleteDraft(
    agentId: string,
    id: string,
    options: { expectedUpdatedAt?: Date } = {},
  ): Promise<RoutineDefinitionDeleteDraftResult> {
    const current = await this.findById(agentId, id);
    if (!current) {
      return { outcome: "not_found" };
    }
    if (options.expectedUpdatedAt !== undefined && current.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
      return { outcome: "conflict" };
    }
    return this.db.transaction().execute((trx) => this.deleteLineageOn(trx, agentId, current, options));
  }

  /**
   * A "deleted" routine is disabled, not removed, unless nothing could possibly still depend on
   * it. `findPinnedById` addresses the exact stored row an in-flight `routine_states` pin names,
   * independent of `enabled` — an unpinned conversation mid-routine resolves through it too, on
   * the reactivation path. Hard-deleting a row that ever served would turn that lookup into a
   * null and break the conversation.
   *
   * A row is safe to remove outright only when nothing in its lineage could ever have been live:
   * exactly one row (a branched, pre-collapse lineage only exists because an earlier version was
   * published — see migration 090), and its containing agent has never published a revision
   * created at or after the row's own creation. The agent revision system is the only publication
   * boundary (see the routine lifecycle collapse), so that — not the row's own current `enabled`
   * flag — is the true "could this ever have gone live" signal: a routine defaults to `enabled:
   * true` the moment it is created, long before any operator gets a chance to turn it off, so an
   * ordinary create-then-immediately-delete flow must not read as "may have served" just because
   * nothing has toggled it yet. Everything else is disabled in place.
   */
  private async deleteLineageOn(
    db: Db,
    agentId: string,
    canonical: RoutineDefinition,
    options: { expectedUpdatedAt?: Date } = {},
  ): Promise<RoutineDefinitionDeleteDraftResult> {
    const [{ count }] = (await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM routine_definition WHERE lineage_id = ${canonical.lineageId}
    `.execute(db)).rows;
    const [{ couldHaveServed }] = (await sql<{ couldHaveServed: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM agent_revisions
        WHERE agent_id = ${agentId}
          AND published_at IS NOT NULL
          AND created_at >= ${canonical.createdAt}::timestamptz
      ) AS "couldHaveServed"
    `.execute(db)).rows;
    const neverServed = Number(count) === 1 && !couldHaveServed;
    // A caller that names an expectation already confirmed the row existed a moment ago (the
    // callers above both re-read it first), so a guard mismatch here can only mean a concurrent
    // write landed in between — the write races checked in application code, not "not found".
    const guardMissOutcome = options.expectedUpdatedAt !== undefined ? "conflict" as const : "not_found" as const;

    if (!neverServed) {
      const disabled = await db
        .updateTable("routine_definition")
        .set({ enabled: false, updated_at: nextAuthoredUpdatedAt() })
        .where("agent_id", "=", agentId)
        .where("id", "=", canonical.id)
        .$if(options.expectedUpdatedAt !== undefined, (query) => query.where(matchesExpectedUpdatedAt(options.expectedUpdatedAt!)))
        .returning("id")
        .execute();
      return disabled.length > 0 ? { outcome: "deleted" } : { outcome: guardMissOutcome };
    }

    const deleted = await db
      .deleteFrom("routine_definition")
      .where("agent_id", "=", agentId)
      .where("lineage_id", "=", canonical.lineageId)
      .$if(options.expectedUpdatedAt !== undefined, (query) => query.where(matchesExpectedUpdatedAt(options.expectedUpdatedAt!)))
      .returning("id")
      .execute();
    return deleted.length > 0 ? { outcome: "deleted" } : { outcome: guardMissOutcome };
  }

  /**
   * Routines that reference a webhook destination, so deleting it cannot orphan one. Matches the
   * `enabled`-gated delete-block trigger on `workspace_webhook_destinations` (migration 182):
   * a disabled routine no longer holds the destination in service, so it must not appear here
   * either, or the friendly pre-check would report a block the trigger itself would not enforce.
   */
  async listRoutineNamesReferencingDestination(workspaceId: string, destinationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("routine_completion_export as ce")
      .innerJoin("routine_definition as d", "d.id", "ce.definition_id")
      .innerJoin("agents as a", "a.id", "d.agent_id")
      .select("d.name")
      .where("a.workspace_id", "=", workspaceId)
      .where("d.enabled", "=", true)
      .where("ce.enabled", "=", true)
      .where(sql<boolean>`lower(ce.destination_ref) = lower(${destinationId})`)
      .where(canonicalLineageRow)
      .orderBy("d.name", "asc")
      .orderBy("d.version", "asc")
      .orderBy("d.id", "asc")
      .execute();
    return rows.map((row) => row.name);
  }

  /**
   * The row (if any) already occupying `(agent_id, name, version=1)` — the exact identity a
   * fresh `createDraft` would take, and the real unique-constraint key
   * (`routine_definition_agent_id_name_version_key`). Deliberately not scoped to canonical rows:
   * a retired, non-canonical row from a pre-cutover branched lineage can still hold this slot
   * while its lineage's canonical row has since been renamed to something else, so a canonical-
   * only read would miss a real conflict. Backs the copilot's create-proposal version token
   * (`proposalAdapters.ts`), which needs to know whether a create would conflict without
   * attempting one.
   */
  async findNameVersionOneOccupant(agentId: string, name: string): Promise<{ id: string; updatedAt: Date } | null> {
    const result = await sql<{ id: string; updated_at: Date }>`
      SELECT id, updated_at FROM routine_definition
      WHERE agent_id = ${agentId} AND name = ${name} AND version = 1
    `.execute(this.db);
    const row = result.rows[0];
    return row ? { id: row.id, updatedAt: new Date(row.updated_at) } : null;
  }

  private async listByAgentOn(db: Db, agentId: string): Promise<RoutineDefinition[]> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND ${canonicalLineageRow}
      ORDER BY d.name ASC, d.created_at ASC, d.id ASC
    `.execute(db);
    return result.rows.map(mapRow);
  }

  private async listVersionsByAgentOn(db: Db, agentId: string): Promise<RoutineDefinition[]> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId}
      ORDER BY d.name ASC, d.version ASC, d.created_at ASC, d.id ASC
    `.execute(db);
    return result.rows.map(mapRow);
  }

  private async requireDefinition(db: Db, agentId: string, id: string): Promise<RoutineDefinition> {
    const definition = await this.findByIdOn(db, agentId, id);
    if (!definition) throw new Error(`routine_definition_not_found:${id}`);
    return definition;
  }

  private async mutateAgentDraft<T>(
    workspaceId: string,
    agentId: string,
    operation: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return withAgentDraftMutation(this.db, workspaceId, agentId, async (trx, snapshot) => {
      const result = await operation(trx);
      if (result === null ||
        (typeof result === "object" && result !== null && "outcome" in result && result.outcome !== "deleted")) {
        return { result, unchanged: true };
      }
      return {
        result,
        snapshot: await this.projectDraftSnapshot(trx, agentId, snapshot),
      };
    });
  }

  /** Reads the final normalized graph after a routine write, never a stale input object. */
  private async projectDraftSnapshot(
    trx: Transaction<DB>,
    agentId: string,
    snapshot: AgentRevisionSnapshot,
  ): Promise<AgentRevisionSnapshot> {
    // Every stored version, because a directive scope tag authored before the collapse can still
    // name a row its lineage branched past; the projection below is what moves that tag onto the
    // row the snapshot actually carries.
    const [definitions, directives] = await Promise.all([
      this.listVersionsByAgentOn(trx, agentId),
      sql<AgentDirectiveRow>`
        SELECT * FROM agent_directives
        WHERE agent_id = ${agentId}
        ORDER BY created_at ASC, id ASC
      `.execute(trx),
    ]);
    const selectedRoutines = selectCanonicalRoutineDefinitions(definitions);
    return {
      ...snapshot,
      routines: selectedRoutines,
      directives: projectDirectiveScopeTagsForSelectedRoutines(
        directives.rows.map(mapDirectiveRow),
        definitions,
        selectedRoutines,
      ),
    };
  }

  private async replaceChildren(db: Db, definitionId: string, input: RoutineDefinitionDraftInput): Promise<void> {
    await db.deleteFrom("routine_slot").where("definition_id", "=", definitionId).execute();
    await db.deleteFrom("routine_step").where("definition_id", "=", definitionId).execute();
    await db.deleteFrom("routine_transition").where("definition_id", "=", definitionId).execute();
    await db.deleteFrom("routine_terminal").where("definition_id", "=", definitionId).execute();
    await db.deleteFrom("routine_completion_export").where("definition_id", "=", definitionId).execute();

    for (const slot of input.slots) {
      await db
        .insertInto("routine_slot")
        .values({
          definition_id: definitionId,
          stable_slot_id: slot.stableSlotId,
          key: slot.key,
          type: slot.type,
          required: slot.required,
          description: slot.description,
          ordinal: slot.ordinal,
          mutable: slot.mutable ?? false,
        })
        .execute();
    }
    for (const step of input.steps) {
      await db
        .insertInto("routine_step")
        .values({
          definition_id: definitionId,
          stable_step_id: step.stableStepId,
          kind: step.kind,
          instruction: step.instruction,
          tool_ref: step.toolRef,
          action_type: step.actionType,
          capture_key: step.captureKey ?? null,
          options: step.options ? toJsonb(step.options) : null,
          ordinal: step.ordinal,
          metadata: toJsonb(step.metadata),
        })
        .execute();
    }
    for (const transition of input.transitions) {
      await db
        .insertInto("routine_transition")
        .values({
          definition_id: definitionId,
          from_step: transition.fromStep,
          to_ref: transition.toRef,
          guard_kind: transition.guardKind,
          guard_text: transition.guardText,
          outcome_status: transition.outcomeStatus,
          counter_limit: transition.counterLimit,
          field_ref: transition.fieldRef ?? null,
          field_op: transition.fieldOp ?? null,
          // Explicit null/undefined check (not a truthy shortcut): a field guard value of
          // `0` or `false` is meaningful and must survive serialization, not collapse to NULL.
          field_value:
            transition.fieldValue === null || transition.fieldValue === undefined
              ? null
              : toJsonb(transition.fieldValue),
          field_values: transition.fieldValues ? toJsonb(transition.fieldValues) : null,
          field_unit: transition.fieldUnit ?? null,
          ordinal: transition.ordinal,
        })
        .execute();
    }
    for (const terminal of input.terminals) {
      await db
        .insertInto("routine_terminal")
        .values({
          definition_id: definitionId,
          stable_step_id: terminal.stableStepId,
          kind: terminal.kind,
          instruction: terminal.instruction,
          ordinal: terminal.ordinal,
        })
        .execute();
    }
    if (input.completionExport?.enabled) {
      await db
        .insertInto("routine_completion_export")
        .values({
          definition_id: definitionId,
          enabled: input.completionExport.enabled,
          trigger_kinds: input.completionExport.triggerKinds,
          destination_ref: input.completionExport.destinationRef,
        })
        .execute();
    }
  }
}
