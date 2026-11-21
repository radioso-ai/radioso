/**
 * The row locks the context-variable repository's writes take before they write, in the order
 * `app/composition/conversationLockOrder.ts` records: a definition edit locks its variable row for
 * update; a conversation-scope value write share-locks its conversation.
 */

import { typeChangeWithValuesRefused, type ContextVariableValueType } from "../../modules/context-variables/public.js";
import { notFound } from "../../shared/domain/errors.js";
import { optionalTimestampMatch } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * A conversation-scope value names a conversation of its own workspace, so its erasure reaches it.
 * Returns the conversation's id as stored, whatever case the caller sent it in. The row is share-locked
 * until the write commits: an erasure locks it before its erasers run, so a write either commits
 * first and is erased, or waits and finds the conversation gone.
 */
export const requireConversation = async (db: Db, workspaceId: string, conversationId: string): Promise<string> => {
  const conversation = await db
    .selectFrom("conversations")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", conversationId)
    .forShare()
    .executeTakeFirst();
  if (!conversation) throw notFound("Conversation not found");
  return conversation.id;
};

/** A variable's type and options as an edit of its definition reads them under the row lock. */
interface LockedDefinition {
  readonly id: string;
  readonly valueType: ContextVariableValueType;
  /** The `options` column as stored; the repository maps it. */
  readonly storedOptions: unknown;
}

/**
 * Locks a variable's row for an edit of its definition and reads what the edit is checked against,
 * or null when no row matches. With `expectedUpdatedAt`, only the version a proposal was drafted
 * against matches. Locked for update, so a value write in flight, which key-shares the row, commits
 * first and is seen, and a second edit waits for this one and reads what it committed.
 */
export const lockDefinition = async (
  trx: Db,
  workspaceId: string,
  variableId: string,
  expectedUpdatedAt: Date | null = null,
): Promise<LockedDefinition | null> => {
  const row = await trx
    .selectFrom("context_variables")
    .select(["id", "value_type", "options"])
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", variableId)
    .where((eb) => optionalTimestampMatch(eb.ref("updated_at"), expectedUpdatedAt))
    .forUpdate()
    .executeTakeFirst();
  return row
    ? { id: row.id, valueType: row.value_type as ContextVariableValueType, storedOptions: row.options }
    : null;
};

/** Refuses to change the type of a variable that has values; the caller holds its row locked. */
export const refuseTypeChangeWithValues = async (
  trx: Db,
  locked: LockedDefinition,
  valueType: ContextVariableValueType,
): Promise<void> => {
  if (locked.valueType === valueType) return;
  const value = await trx
    .selectFrom("context_variable_values")
    .select("id")
    .where("variable_id", "=", locked.id)
    .limit(1)
    .executeTakeFirst();
  if (value) throw typeChangeWithValuesRefused();
};
