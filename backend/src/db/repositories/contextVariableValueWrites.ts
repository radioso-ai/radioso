import { randomUUID } from "node:crypto";

import {
  CONTEXT_VALUE_WRITER_KINDS,
  type ContextValueSaveStore,
  contextValueChanged,
  contextValueChangedEvent,
  keepsWriterOfEqualValue,
  mayOverwrite,
  validateValue,
  type ContextValueWriter,
  type ContextValueWriterKind,
  type ContextVariable,
  type ContextVariableOption,
  type ContextVariableScope,
  type ContextVariableSensitivity,
  type ContextVariableTrustTier,
  type ContextVariableValue,
  type ContextVariableValueType,
  type SaveTargetDefinition,
} from "../../modules/context-variables/public.js";
import { conflict, notFound } from "../../shared/domain/errors.js";
import type { WorkspaceEventRecorder } from "../../shared/domain/workspaceEventLog.js";
import type { WorkspaceEventDeliveryWake } from "../../shared/domain/workspaceEventSubscriptions.js";
import { currentTimestamp, toJsonb, transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { requireConversation } from "./contextVariableRowLocks.js";
import { contextVariableValueColumns, mapContextVariableValueRow, storedScopeId } from "./contextVariableValueReads.js";

/** Options as stored: the jsonb array of an enum variable, null otherwise. */
export const optionsFromRow = (value: unknown): readonly ContextVariableOption[] | null =>
  Array.isArray(value) ? (value as ContextVariableOption[]) : null;

/** The stored writers an incoming writer may replace, under the module's overwrite rule. */
const replaceableWriterKinds = (incoming: ContextValueWriterKind): ContextValueWriterKind[] =>
  CONTEXT_VALUE_WRITER_KINDS.filter((existing) => mayOverwrite({ kind: existing, ref: null }, incoming));

type ValueDefinition = Pick<ContextVariable, "id" | "workspaceId" | "name" | "valueType" | "options" | "sensitivity">;

/** A value as stored, with who last wrote it; `undefined` stands for none. */
interface StoredValue {
  readonly data: unknown;
  readonly writtenBy: ContextValueWriter;
}

/**
 * Where a change of a conversation's value is recorded: the log, in the write's own transaction,
 * then a delivery wake once it has committed, so subscriptions hear of it before the periodic sweep.
 */
export interface ContextValueEvents {
  readonly recorder: WorkspaceEventRecorder;
  readonly delivery: WorkspaceEventDeliveryWake;
}

const definitionColumns = ["id", "workspace_id", "name", "value_type", "options", "sensitivity", "trust_tier"] as const;

const mapDefinition = (row: {
  id: string;
  workspace_id: string;
  name: string;
  value_type: string;
  options: unknown;
  sensitivity: string;
  trust_tier: string;
}): SaveTargetDefinition => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  valueType: row.value_type as ContextVariableValueType,
  options: optionsFromRow(row.options),
  sensitivity: row.sensitivity as ContextVariableSensitivity,
  trustTier: row.trust_tier as ContextVariableTrustTier,
});

/**
 * The definition a value write is checked against and its event names, key-shared until the write
 * commits. A type change locks the row for update before it looks for values, so it waits for this
 * write, and a write after it reads the type it committed.
 */
const lockValueDefinition = async (trx: Db, variableId: string): Promise<ValueDefinition> => {
  const row = await trx
    .selectFrom("context_variables")
    .select(definitionColumns)
    .where("id", "=", variableId)
    .forKeyShare()
    .executeTakeFirst();
  if (!row) throw notFound("Context variable not found");
  return mapDefinition(row);
};

/**
 * Takes the conversation's value of the variable for the rest of the transaction and reads what it
 * holds, `undefined` for nothing. Writers of one conversation's value queue here, after the
 * conversation's share lock, so each compares against what the one before it committed, a first
 * value included, and a change is recorded once. That holds at READ COMMITTED, Postgres's default
 * and the pool's: each statement after the lock sees what the writer before it committed.
 */
const lockConversationValue = async (trx: Db, variableId: string, conversationId: string): Promise<StoredValue | undefined> => {
  await transactionAdvisoryLock(`context-variable-value:${variableId}:${conversationId}`).execute(trx);
  return readStoredValue(trx, variableId, { type: "conversation", id: conversationId });
};

const readStoredValue = async (trx: Db, variableId: string, scope: ContextVariableScope): Promise<StoredValue | undefined> => {
  const row = await trx
    .selectFrom("context_variable_values")
    .select(["data", "written_by_kind", "written_by_ref"])
    .where("variable_id", "=", variableId)
    .where("scope_type", "=", scope.type)
    .where("scope_id", "=", storedScopeId(scope))
    .executeTakeFirst();
  return row
    ? { data: row.data, writtenBy: { kind: row.written_by_kind as ContextValueWriterKind, ref: row.written_by_ref } }
    : undefined;
};

/**
 * Inserts or replaces a value under the overwrite rule, decided against the stored row in the same
 * statement, so a write racing this one cannot slip between a read of the stored writer and the
 * update. Null when the stored value is kept.
 */
const upsertRow = async (
  trx: Db,
  definition: ValueDefinition,
  scope: ContextVariableScope,
  data: unknown,
  writtenBy: ContextValueWriter,
): Promise<ContextVariableValue | null> => {
  const row = await trx
    .insertInto("context_variable_values")
    .values({
      id: randomUUID(),
      workspace_id: definition.workspaceId,
      variable_id: definition.id,
      scope_type: scope.type,
      scope_id: storedScopeId(scope),
      data: toJsonb(data),
      last_modified: currentTimestamp(),
      written_by_kind: writtenBy.kind,
      written_by_ref: writtenBy.ref,
    })
    .onConflict((oc) =>
      oc.columns(["variable_id", "scope_type", "scope_id"]).doUpdateSet((eb) => ({
        workspace_id: eb.ref("excluded.workspace_id"),
        data: eb.ref("excluded.data"),
        last_modified: currentTimestamp(),
        written_by_kind: eb.ref("excluded.written_by_kind"),
        written_by_ref: eb.ref("excluded.written_by_ref"),
      })).where("context_variable_values.written_by_kind", "in", replaceableWriterKinds(writtenBy.kind)),
    )
    .returning(contextVariableValueColumns)
    .executeTakeFirst();
  return row ? mapContextVariableValueRow(row) : null;
};

/**
 * Writes and deletes of stored values. A conversation's value is about that conversation, so a write
 * that changes it records `context_value.changed` in its own transaction, through the events
 * composition hands in: the value and its event commit together or not at all, and delivery is woken
 * once they have. A write that leaves the value as it was records nothing. Values kept at any other
 * scope record no event: a session's or a customer's value spans conversations, and an agent's or
 * workspace's is a default. `events` is null only where composition says a write is no change an
 * automation acts on.
 */
export class ContextVariableValueWrites implements ContextValueSaveStore {
  constructor(
    private readonly db: Db,
    private readonly events: ContextValueEvents | null,
  ) {}

  /** Stores a value under the overwrite rule; null when the stored value is kept. */
  async upsertValue(variableId: string, scope: ContextVariableScope, data: unknown, writtenBy: ContextValueWriter): Promise<ContextVariableValue | null> {
    return this.afterChange(this.db.transaction().execute(async (trx) => {
      const definition = await lockValueDefinition(trx, variableId);
      if (!validateValue(definition, data).ok) {
        throw conflict("The context variable's type or options changed while the value was written");
      }
      // A conversation is keyed by its own id, in the form every reader compares against.
      const conversationId = scope.type === "conversation" ? await requireConversation(trx, definition.workspaceId, scope.id) : null;
      const previous = conversationId ? await lockConversationValue(trx, variableId, conversationId) : undefined;
      const value = await upsertRow(trx, definition, conversationId ? { type: "conversation", id: conversationId } : scope, data, writtenBy);
      if (!value) return { result: null, recorded: null };
      if (conversationId && contextValueChanged(previous?.data, value.data)) {
        return { result: value, recorded: await this.recordChange(trx, { definition, conversationId, value: value.data, writtenBy, routineId: null }) };
      }
      return { result: value, recorded: null };
    }));
  }

  /**
   * The workspace's variable named `name`, key-shared for the rest of the caller's transaction, as a
   * save reads it; null when none has the name.
   */
  async lockDefinitionNamedIn(trx: Db, workspaceId: string, name: string): Promise<SaveTargetDefinition | null> {
    const row = await trx
      .selectFrom("context_variables")
      .select(definitionColumns)
      .where("workspace_id", "=", workspaceId)
      .where("name", "=", name)
      .forKeyShare()
      .executeTakeFirst();
    return row ? mapDefinition(row) : null;
  }

  /**
   * The transaction-joining write: stores a value in a transaction the caller owns, a chat turn's, with
   * the same locks, overwrite rule and change event as `upsertValue`, so they commit or roll back
   * with what the caller commits. The caller has checked the value against `definition` under its
   * lock, and its commit wakes delivery. A value its writer already stored, same writer and same
   * value, is `unchanged` and writes nothing, as is a value a teammate or the host already set
   * (`keepsWriterOfEqualValue`); the same value from any other writer rewrites only the provenance
   * and records no event.
   */
  async storeIn(trx: Db, write: Parameters<ContextValueSaveStore["storeIn"]>[1]): Promise<"written" | "unchanged" | "kept"> {
    const { definition, data, writtenBy } = write;
    const conversationId = write.scope.type === "conversation" ? await requireConversation(trx, definition.workspaceId, write.scope.id) : null;
    const scope: ContextVariableScope = conversationId ? { type: "conversation", id: conversationId } : write.scope;
    const previous = conversationId
      ? await lockConversationValue(trx, definition.id, conversationId)
      : await readStoredValue(trx, definition.id, scope);
    const sameWriter = previous?.writtenBy.kind === writtenBy.kind && previous.writtenBy.ref === writtenBy.ref;
    if (previous && !contextValueChanged(previous.data, data) && (sameWriter || keepsWriterOfEqualValue(previous.writtenBy.kind))) return "unchanged";
    if (!await upsertRow(trx, definition, scope, data, writtenBy)) return "kept";
    if (conversationId && contextValueChanged(previous?.data, data)) {
      await this.recordChange(trx, { definition, conversationId, value: data, writtenBy, routineId: write.routineId });
    }
    return "written";
  }

  /** Deletes the value; whether a row went. `deletedBy` is the writer the change is recorded against. */
  deleteValue(variableId: string, scope: ContextVariableScope, deletedBy: ContextValueWriter): Promise<boolean> {
    return this.delete(variableId, scope, deletedBy, null);
  }

  /** Deletes the value only when one of `writerKinds` wrote it, decided in the delete itself. */
  async deleteValueWrittenBy(
    variableId: string,
    scope: ContextVariableScope,
    writerKinds: readonly ContextValueWriterKind[],
    deletedBy: ContextValueWriter,
  ): Promise<boolean> {
    return writerKinds.length === 0 ? false : this.delete(variableId, scope, deletedBy, writerKinds);
  }

  private async delete(
    variableId: string,
    scope: ContextVariableScope,
    deletedBy: ContextValueWriter,
    writerKinds: readonly ContextValueWriterKind[] | null,
  ): Promise<boolean> {
    const deleteRow = async (db: Db, scopeId: string): Promise<boolean> => {
      let statement = db
        .deleteFrom("context_variable_values")
        .where("variable_id", "=", variableId)
        .where("scope_type", "=", scope.type)
        .where("scope_id", "=", scopeId);
      if (writerKinds) statement = statement.where("written_by_kind", "in", [...writerKinds]);
      const result = await statement.executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    };
    if (scope.type !== "conversation") return deleteRow(this.db, storedScopeId(scope));
    // The same locks as a write, in the same order, so a delete meets an erasure of the conversation
    // the way a write does: it either commits first and is erased, or finds the conversation gone.
    return this.afterChange(this.db.transaction().execute(async (trx) => {
      const definition = await lockValueDefinition(trx, variableId);
      const conversationId = await requireConversation(trx, definition.workspaceId, scope.id);
      await lockConversationValue(trx, variableId, conversationId);
      if (!await deleteRow(trx, conversationId)) return { result: false, recorded: null };
      return { result: true, recorded: await this.recordChange(trx, { definition, conversationId, value: null, writtenBy: deletedBy, routineId: null }) };
    }));
  }

  /** Records the change in the write's transaction; the workspace whose log it went to, null when none did. */
  private async recordChange(trx: Db, change: {
    definition: ValueDefinition;
    conversationId: string;
    value: unknown;
    writtenBy: ContextValueWriter;
    routineId: string | null;
  }): Promise<string | null> {
    if (!this.events) return null;
    await this.events.recorder.record(trx, contextValueChangedEvent({
      workspaceId: change.definition.workspaceId,
      conversationId: change.conversationId,
      variable: change.definition,
      value: change.value,
      writtenBy: change.writtenBy,
      routineId: change.routineId,
    }));
    return change.definition.workspaceId;
  }

  /** Wakes delivery for the workspace a committed write recorded a change in. */
  private async afterChange<T>(committed: Promise<{ result: T; recorded: string | null }>): Promise<T> {
    const { result, recorded } = await committed;
    if (recorded && this.events) this.events.delivery.requestDelivery(recorded);
    return result;
  }
}
