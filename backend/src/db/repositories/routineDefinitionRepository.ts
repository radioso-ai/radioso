import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import type { Database } from "../../shared/infra/database.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionPublishOptions,
  type RoutineGuardKind,
  type RoutineSlotType,
  type RoutineStepKind,
  type RoutineTerminalKind,
} from "../../modules/routines/public.js";

interface RoutineDefinitionRow extends QueryResultRow {
  id: string;
  agent_id: string;
  lineage_id: string;
  name: string;
  version: number;
  status: "draft" | "published" | "superseded" | "archived";
  activation_trigger_description: string;
  activation_gate_ref: string | null;
  activation_priority: number;
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

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord) : [];

const normalizeStepKind = (kind: string): RoutineStepKind =>
  kind === "fork" ? "chat" : kind as RoutineStepKind;

const normalizeGuardKind = (kind: string): RoutineGuardKind =>
  kind === "always" || kind === "fallback" ? "default" : kind as RoutineGuardKind;

const isUniqueViolation = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");

const definitionSelect = `
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
      'ordinal', s.ordinal
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
  },
  slots: asArray(row.slots).map((slot) => ({
    stableSlotId: readString(slot, "stableSlotId"),
    key: readString(slot, "key"),
    type: readString(slot, "type") as RoutineSlotType,
    required: readBoolean(slot, "required"),
    description: readNullableString(slot, "description"),
    ordinal: readNumber(slot, "ordinal"),
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
  constructor(private readonly database: Database) {}

  async listPublishedByAgent(agentId: string): Promise<RoutineDefinition[]> {
    const rows = await this.database.query<RoutineDefinitionRow>(
      `${definitionSelect}
       WHERE d.agent_id = $1 AND d.status = 'published'
       ORDER BY d.activation_priority DESC, d.created_at ASC, d.id ASC`,
      [agentId],
    );
    return rows.map(mapRow);
  }

  async listByAgent(agentId: string): Promise<RoutineDefinition[]> {
    const rows = await this.database.query<RoutineDefinitionRow>(
      `${definitionSelect}
       WHERE d.agent_id = $1
       ORDER BY d.status ASC, d.name ASC, d.version ASC, d.created_at ASC, d.id ASC`,
      [agentId],
    );
    return rows.map(mapRow);
  }

  async findById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    const row = await this.database.queryOptional<RoutineDefinitionRow>(
      `${definitionSelect}
       WHERE d.agent_id = $1 AND d.id = $2`,
      [agentId, id],
    );
    return row ? mapRow(row) : null;
  }

  async createDraft(agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    const id = randomUUID();
    await this.database.withTransaction(async (client) => {
      await client.query<{ id: string }>(
        `INSERT INTO routine_definition (
           id, agent_id, version, name, status, activation_trigger_description,
           activation_gate_ref, activation_priority, lineage_id
         )
         VALUES ($1, $2, 1, $3, 'draft', $4, $5, $6, $7)
         RETURNING id::text`,
        [
          id,
          agentId,
          draft.name,
          draft.activation.triggerDescription,
          draft.activation.gateRef,
          draft.activation.priority,
          randomUUID(),
        ],
      );
      await this.replaceChildren(client, id, draft);
    });
    const loaded = await this.findById(agentId, id);
    if (!loaded) {
      throw new Error(`routine_definition_not_found:${id}`);
    }
    return loaded;
  }

  async updateDraft(agentId: string, id: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    await this.database.withTransaction(async (client) => {
      await client.query(
        `UPDATE routine_definition
         SET name = $3,
             activation_trigger_description = $4,
             activation_gate_ref = $5,
             activation_priority = $6,
             updated_at = NOW()
         WHERE agent_id = $1 AND id = $2 AND status = 'draft'`,
        [agentId, id, draft.name, draft.activation.triggerDescription, draft.activation.gateRef, draft.activation.priority],
      );
      await this.replaceChildren(client, id, draft);
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
    await this.database.withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`routine_definition_publish:${draft.lineageId}`],
      );
      const superseded = await client.query<{ id: string }>(
        `UPDATE routine_definition
         SET status = 'superseded',
             updated_at = NOW()
         WHERE lineage_id = $1
           AND status = 'published'
         RETURNING id::text`,
        [draft.lineageId],
      );
      const published = await client.query<{ id: string }>(
        `UPDATE routine_definition
         SET status = 'published',
             updated_at = NOW()
         WHERE agent_id = $1
           AND id = $2
           AND status = 'draft'
         RETURNING id::text`,
        [agentId, draftId],
      );
      if (published.rows.length === 0) {
        throw new Error(`routine_definition_publish_conflict:${draftId}`);
      }
      await this.touchCompletionExportDestinationRef(client, draftId);
      await options.onPublished?.({
        previousPublishedId: superseded.rows[0]?.id ?? null,
        newDefinitionId: draftId,
        transaction: client,
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
    const existingDraft = await this.database.queryOptional<RoutineDefinitionRow>(
      `${definitionSelect}
       WHERE d.agent_id = $1 AND d.lineage_id = $2 AND d.status = 'draft'`,
      [agentId, published.lineageId],
    );
    if (existingDraft) {
      return mapRow(existingDraft);
    }

    const id = randomUUID();
    try {
      await this.database.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO routine_definition (
             id, agent_id, version, name, status, activation_trigger_description,
             activation_gate_ref, activation_priority, lineage_id
           )
           VALUES (
             $1,
             $2,
             (
               SELECT COALESCE(MAX(version), 0) + 1
               FROM routine_definition
               WHERE lineage_id = $7
             ),
             $3,
             'draft',
             $4,
             $5,
             $6,
             $7
           )`,
          [
            id,
            agentId,
            published.name,
            published.activation.triggerDescription,
            published.activation.gateRef,
            published.activation.priority,
            published.lineageId,
          ],
        );
        await this.replaceChildren(client, id, published);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const racedDraft = await this.database.queryOptional<RoutineDefinitionRow>(
        `${definitionSelect}
         WHERE d.agent_id = $1 AND d.lineage_id = $2 AND d.status = 'draft'`,
        [agentId, published.lineageId],
      );
      if (racedDraft) {
        return mapRow(racedDraft);
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
    const row = await this.database.queryOptional<{ id: string }>(
      `UPDATE routine_definition
       SET status = 'archived',
           updated_at = NOW()
       WHERE agent_id = $1 AND id = $2 AND status = 'published'
       RETURNING id::text`,
      [agentId, id],
    );
    return Boolean(row);
  }

  async restore(agentId: string, id: string): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const row = await client.query<{ id: string }>(
        `UPDATE routine_definition target
         SET status = 'published',
             updated_at = NOW()
         WHERE target.agent_id = $1
           AND target.id = $2
           AND target.status = 'archived'
           AND NOT EXISTS (
             SELECT 1
             FROM routine_definition other
             WHERE other.lineage_id = target.lineage_id
               AND other.status = 'published'
               AND other.id <> target.id
           )
         RETURNING target.id::text`,
        [agentId, id],
      );
      if (row.rows.length === 0) {
        return false;
      }
      await this.touchCompletionExportDestinationRef(client, id);
      return true;
    });
  }

  async deleteDraft(agentId: string, id: string): Promise<boolean> {
    const row = await this.database.queryOptional<{ id: string }>(
      `DELETE FROM routine_definition
       WHERE agent_id = $1 AND id = $2 AND status = 'draft'
       RETURNING id::text`,
      [agentId, id],
    );
    return Boolean(row);
  }

  async listPublishedRoutineNamesReferencingDestination(workspaceId: string, destinationId: string): Promise<string[]> {
    const rows = await this.database.query<{ name: string }>(
      `SELECT d.name
       FROM routine_completion_export ce
       JOIN routine_definition d ON d.id = ce.definition_id
       JOIN agents a ON a.id = d.agent_id
       WHERE a.workspace_id = $1
         AND ce.enabled = TRUE
         AND lower(ce.destination_ref) = lower($2)
         AND d.status = 'published'
       ORDER BY d.name ASC, d.version ASC, d.id ASC`,
      [workspaceId, destinationId],
    );
    return rows.map((row) => row.name);
  }

  private async touchCompletionExportDestinationRef(client: Pick<PoolClient, "query">, definitionId: string): Promise<void> {
    await client.query(
      `UPDATE routine_completion_export
       SET destination_ref = destination_ref
       WHERE definition_id = $1
         AND enabled = TRUE`,
      [definitionId],
    );
  }

  private async replaceChildren(client: Pick<PoolClient, "query">, definitionId: string, input: RoutineDefinitionDraftInput): Promise<void> {
    await client.query(`DELETE FROM routine_slot WHERE definition_id = $1`, [definitionId]);
    await client.query(`DELETE FROM routine_step WHERE definition_id = $1`, [definitionId]);
    await client.query(`DELETE FROM routine_transition WHERE definition_id = $1`, [definitionId]);
    await client.query(`DELETE FROM routine_terminal WHERE definition_id = $1`, [definitionId]);
    await client.query(`DELETE FROM routine_completion_export WHERE definition_id = $1`, [definitionId]);

    for (const slot of input.slots) {
      await client.query(
        `INSERT INTO routine_slot (definition_id, stable_slot_id, key, type, required, description, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [definitionId, slot.stableSlotId, slot.key, slot.type, slot.required, slot.description, slot.ordinal],
      );
    }
    for (const step of input.steps) {
      await client.query(
        `INSERT INTO routine_step (definition_id, stable_step_id, kind, instruction, tool_ref, action_type, ordinal, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          definitionId,
          step.stableStepId,
          step.kind,
          step.instruction,
          step.toolRef,
          step.actionType,
          step.ordinal,
          JSON.stringify(step.metadata),
        ],
      );
    }
    for (const transition of input.transitions) {
      await client.query(
        `INSERT INTO routine_transition (
           definition_id, from_step, to_ref, guard_kind, guard_text, outcome_status, counter_limit, ordinal
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          definitionId,
          transition.fromStep,
          transition.toRef,
          transition.guardKind,
          transition.guardText,
          transition.outcomeStatus,
          transition.counterLimit,
          transition.ordinal,
        ],
      );
    }
    for (const terminal of input.terminals) {
      await client.query(
        `INSERT INTO routine_terminal (definition_id, stable_step_id, kind, instruction, ordinal)
         VALUES ($1, $2, $3, $4, $5)`,
        [definitionId, terminal.stableStepId, terminal.kind, terminal.instruction, terminal.ordinal],
      );
    }
    if (input.completionExport?.enabled) {
      await client.query(
        `INSERT INTO routine_completion_export (definition_id, enabled, trigger_kinds, destination_ref)
         VALUES ($1, $2, $3, $4)`,
        [
          definitionId,
          input.completionExport.enabled,
          input.completionExport.triggerKinds,
          input.completionExport.destinationRef,
        ],
      );
    }
  }
}
