import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import {
  routineDefinitionDraftInputSchema,
  routineReentryModes,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionPublishOptions,
  type RoutineFieldGuardOp,
  type RoutineFieldGuardUnit,
  type RoutineGuardKind,
  type RoutineReentryMode,
  type RoutineSlotType,
  type RoutineStepKind,
  type RoutineTerminalKind,
} from "../../modules/routines/public.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface RoutineDefinitionRow {
  id: string;
  agent_id: string;
  lineage_id: string;
  name: string;
  version: number;
  status: "draft" | "published" | "superseded" | "archived";
  activation_trigger_description: string;
  activation_gate_ref: string | null;
  activation_priority: number;
  activation_reentry_mode: string;
  slots: unknown;
  steps: unknown;
  transitions: unknown;
  terminals: unknown;
  completion_export: unknown;
  created_at: Date;
  updated_at: Date;
}

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

const normalizeStepKind = (kind: string): RoutineStepKind =>
  kind === "fork" ? "chat" : kind as RoutineStepKind;

const normalizeGuardKind = (kind: string): RoutineGuardKind =>
  kind === "always" || kind === "fallback" ? "default" : kind as RoutineGuardKind;

const isUniqueViolation = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");

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
    d.status,
    d.activation_trigger_description,
    d.activation_gate_ref,
    d.activation_priority,
    d.activation_reentry_mode,
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
  status: row.status,
  activation: {
    triggerDescription: row.activation_trigger_description,
    gateRef: row.activation_gate_ref,
    priority: row.activation_priority,
    reentryMode: routineReentryModes.includes(row.activation_reentry_mode as RoutineReentryMode)
      ? (row.activation_reentry_mode as RoutineReentryMode)
      : "once_per_conversation",
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
  steps: asArray(row.steps).map((step) => ({
    stableStepId: readString(step, "stableStepId"),
    kind: normalizeStepKind(readString(step, "kind")),
    instruction: readString(step, "instruction"),
    toolRef: readNullableString(step, "toolRef"),
    actionType: readNullableString(step, "actionType"),
    ordinal: readNumber(step, "ordinal"),
    metadata: readMetadata(step, "metadata"),
  })),
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

  async listPublishedByAgent(agentId: string): Promise<RoutineDefinition[]> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND d.status = 'published'
      ORDER BY d.activation_priority DESC, d.created_at ASC, d.id ASC
    `.execute(this.db);
    return result.rows.map(mapRow);
  }

  async listByAgent(agentId: string): Promise<RoutineDefinition[]> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId}
      ORDER BY d.status ASC, d.name ASC, d.version ASC, d.created_at ASC, d.id ASC
    `.execute(this.db);
    return result.rows.map(mapRow);
  }

  async findById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND d.id = ${id}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  // Resume-only lookup for routine_states pins: a pinned id can reference any
  // lifecycle status except draft (drafts never run).
  async findPinnedById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND d.id = ${id} AND d.status <> 'draft'
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
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
          status: "draft",
          activation_trigger_description: draft.activation.triggerDescription,
          activation_gate_ref: draft.activation.gateRef,
          activation_priority: draft.activation.priority,
          activation_reentry_mode: draft.activation.reentryMode,
          lineage_id: randomUUID(),
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

  async updateDraft(agentId: string, id: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("routine_definition")
        .set({
          name: draft.name,
          activation_trigger_description: draft.activation.triggerDescription,
          activation_gate_ref: draft.activation.gateRef,
          activation_priority: draft.activation.priority,
          activation_reentry_mode: draft.activation.reentryMode,
          updated_at: currentTimestamp(),
        })
        .where("agent_id", "=", agentId)
        .where("id", "=", id)
        .where("status", "=", "draft")
        .returning("id")
        .execute();
      // A save racing publish (which flips the draft row to published in place)
      // matches zero rows here; replacing children then would silently mutate
      // the published version. Abort before touching children.
      if (updated.length === 0) {
        throw new Error(`routine_definition_update_conflict:${id}`);
      }
      await this.replaceChildren(trx, id, draft);
    });
    const loaded = await this.findById(agentId, id);
    if (!loaded) {
      throw new Error(`routine_definition_not_found:${id}`);
    }
    return loaded;
  }

  async publish(agentId: string, draftId: string, options: RoutineDefinitionPublishOptions = {}): Promise<RoutineDefinition> {
    const draft = await this.findById(agentId, draftId);
    if (!draft) {
      throw new Error(`routine_definition_not_found:${draftId}`);
    }
    await this.db.transaction().execute(async (trx) => {
      // Serialize concurrent publishes of the same lineage before any supersede/flip,
      // so the supersede→publish pair below is atomic per lineage. Order matters.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`routine_definition_publish:${draft.lineageId}`}, 0))`.execute(trx);
      const superseded = await trx
        .updateTable("routine_definition")
        .set({ status: "superseded", updated_at: currentTimestamp() })
        .where("lineage_id", "=", draft.lineageId)
        .where("status", "=", "published")
        .returning("id")
        .execute();
      const published = await trx
        .updateTable("routine_definition")
        .set({ status: "published", updated_at: currentTimestamp() })
        .where("agent_id", "=", agentId)
        .where("id", "=", draftId)
        .where("status", "=", "draft")
        .returning("id")
        .execute();
      if (published.length === 0) {
        throw new Error(`routine_definition_publish_conflict:${draftId}`);
      }
      await this.touchCompletionExportDestinationRef(trx, draftId);
      await options.onPublished?.({
        previousPublishedId: superseded[0]?.id ?? null,
        newDefinitionId: draftId,
        transaction: trx,
      });
    });
    const loaded = await this.findById(agentId, draftId);
    if (!loaded) {
      throw new Error(`routine_definition_not_found:${draftId}`);
    }
    return loaded;
  }

  async createRevisionDraft(agentId: string, publishedId: string): Promise<RoutineDefinition | null> {
    const published = await this.findById(agentId, publishedId);
    if (!published || published.status !== "published") {
      return null;
    }
    const existingDraft = await this.findDraftByLineage(agentId, published.lineageId);
    if (existingDraft) {
      return existingDraft;
    }

    const id = randomUUID();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("routine_definition")
          .values({
            id,
            agent_id: agentId,
            // Next version for this lineage, computed in-statement to stay correct under
            // the unique (lineage_id, version) constraint that drives the retry below.
            version: sql<number>`(
              SELECT COALESCE(MAX(version), 0) + 1
              FROM routine_definition
              WHERE lineage_id = ${published.lineageId}
            )`,
            name: published.name,
            status: "draft",
            activation_trigger_description: published.activation.triggerDescription,
            activation_gate_ref: published.activation.gateRef,
            activation_priority: published.activation.priority,
            activation_reentry_mode: published.activation.reentryMode,
            lineage_id: published.lineageId,
          })
          .execute();
        await this.replaceChildren(trx, id, published);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const racedDraft = await this.findDraftByLineage(agentId, published.lineageId);
      if (racedDraft) {
        return racedDraft;
      }
      throw error;
    }
    const loaded = await this.findById(agentId, id);
    if (!loaded) {
      throw new Error(`routine_definition_not_found:${id}`);
    }
    return loaded;
  }

  async archive(agentId: string, id: string): Promise<boolean> {
    const row = await this.db
      .updateTable("routine_definition")
      .set({ status: "archived", updated_at: currentTimestamp() })
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("status", "=", "published")
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async restore(agentId: string, id: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // NOT EXISTS guards the lineage invariant of at most one published row: restore is a
      // no-op if another version of this lineage is already published.
      const row = await trx
        .updateTable("routine_definition as target")
        .set({ status: "published", updated_at: currentTimestamp() })
        .where("target.agent_id", "=", agentId)
        .where("target.id", "=", id)
        .where("target.status", "=", "archived")
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("routine_definition as other")
                .select(sql`1`.as("one"))
                .whereRef("other.lineage_id", "=", "target.lineage_id")
                .where("other.status", "=", "published")
                .whereRef("other.id", "<>", "target.id"),
            ),
          ),
        )
        .returning("target.id as id")
        .execute();
      if (row.length === 0) {
        return false;
      }
      await this.touchCompletionExportDestinationRef(trx, id);
      return true;
    });
  }

  async deleteDraft(agentId: string, id: string): Promise<boolean> {
    const row = await this.db
      .deleteFrom("routine_definition")
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .where("status", "=", "draft")
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async listPublishedRoutineNamesReferencingDestination(workspaceId: string, destinationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("routine_completion_export as ce")
      .innerJoin("routine_definition as d", "d.id", "ce.definition_id")
      .innerJoin("agents as a", "a.id", "d.agent_id")
      .select("d.name")
      .where("a.workspace_id", "=", workspaceId)
      .where("ce.enabled", "=", true)
      .where(sql<boolean>`lower(ce.destination_ref) = lower(${destinationId})`)
      .where("d.status", "=", "published")
      .orderBy("d.name", "asc")
      .orderBy("d.version", "asc")
      .orderBy("d.id", "asc")
      .execute();
    return rows.map((row) => row.name);
  }

  private async findDraftByLineage(agentId: string, lineageId: string): Promise<RoutineDefinition | null> {
    const result = await sql<RoutineDefinitionRow>`
      ${definitionSelect}
      WHERE d.agent_id = ${agentId} AND d.lineage_id = ${lineageId} AND d.status = 'draft'
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  private async touchCompletionExportDestinationRef(db: Db, definitionId: string): Promise<void> {
    await db
      .updateTable("routine_completion_export")
      .set((eb) => ({ destination_ref: eb.ref("destination_ref") }))
      .where("definition_id", "=", definitionId)
      .where("enabled", "=", true)
      .execute();
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
