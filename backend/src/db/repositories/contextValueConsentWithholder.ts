import { writtenByRoutine, type ContextValueWriterKind } from "../../modules/context-variables/public.js";
import type { MessageCopyWithholder, WithheldMessages } from "../../shared/domain/messageWithholding.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * A withdrawn consent's attribute values go (#1544, #1884): every value a routine whose consent was
 * withdrawn saved from this conversation, for the conversation and for its verified customer. Found
 * by the writer reference a routine's save records (`routineValueWriter`), so they go even after the
 * routine's state, which held the values, has expired. A value another writer has since replaced is
 * no longer the routine's and stays. Their `context_value.changed` events leave with the routine's
 * other events (`WorkspaceEventValueWithholder`), and the deletion records none: like an erasure, it
 * is not a change an automation acts on. Every value the routine saved goes, not only the consented
 * slots', as its events do.
 */
export class ContextValueConsentWithholder implements MessageCopyWithholder {
  readonly owner = "context-values";

  constructor(private readonly db: Db) {}

  async withhold(messages: WithheldMessages): Promise<number> {
    const routineIds = messages.withdrawnRoutineSlots.map((withdrawn) => withdrawn.routineId);
    if (routineIds.length === 0) return 0;
    const conversation = await this.db
      .selectFrom("conversations")
      .select(["id", "verified_customer_id"])
      .where("workspace_id", "=", messages.workspaceId)
      .where("id", "=", messages.conversationId)
      .executeTakeFirst();
    if (!conversation) return 0;
    const customerId = conversation.verified_customer_id;
    const routineWritten = await this.db
      .selectFrom("context_variable_values")
      .select(["id", "written_by_kind", "written_by_ref"])
      .where("workspace_id", "=", messages.workspaceId)
      .where("written_by_kind", "=", "routine")
      .where((eb) => eb.or([
        eb.and([eb("scope_type", "=", "conversation"), eb("scope_id", "=", conversation.id)]),
        ...(customerId ? [eb.and([eb("scope_type", "=", "customer"), eb("scope_id", "=", customerId)])] : []),
      ]))
      .forUpdate()
      .execute();
    const withdrawn = routineWritten
      .filter((row) => routineIds.some((routineId) =>
        writtenByRoutine({ kind: row.written_by_kind as ContextValueWriterKind, ref: row.written_by_ref }, routineId)))
      .map((row) => row.id);
    if (withdrawn.length === 0) return 0;
    const deleted = await this.db.deleteFrom("context_variable_values").where("id", "in", withdrawn).executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}
