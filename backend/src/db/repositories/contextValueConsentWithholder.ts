import { sql } from "kysely";

import { routineWriterMatch } from "../../modules/context-variables/public.js";
import type { ConversationChannelPersonKeys } from "../../shared/domain/channelPersonKey.js";
import type { MessageCopyWithholder, WithheldMessages } from "../../shared/domain/messageWithholding.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * A withdrawn consent's attribute values go (#1544, #1884): every value a run of a routine whose
 * consent was withdrawn saved while it ran in this conversation, whether to the conversation, to
 * the verified customer the conversation's row is bound to, or to the person its channel keeps for
 * it (a WhatsApp number, by the conversation's id). A run in another conversation, even the
 * same person's, is covered by that conversation's consent and keeps its values. Found by the writer
 * reference a routine's save records (`routineValueWriter`), so they go even after the routine's
 * state, which held the values, has expired. A value another writer has since replaced is no longer
 * the routine's and stays. A turn that raced a withdrawal names its own run (`savedByRuns`), and
 * only that run's values go. Their `context_value.changed` events leave with the routine's other
 * events (`WorkspaceEventValueWithholder`), and the deletion records none: like an erasure, it is
 * not a change an automation acts on. Every value the routine saved goes, not only the consented
 * slots', as its events do.
 */
export class ContextValueConsentWithholder implements MessageCopyWithholder {
  readonly owner = "context-values";

  constructor(
    private readonly db: Db,
    private readonly personKeys: ConversationChannelPersonKeys,
  ) {}

  async withhold(messages: WithheldMessages): Promise<number> {
    const routineIds = messages.withdrawnRoutineSlots.map((withdrawn) => withdrawn.routineId);
    if (routineIds.length === 0 || messages.savedByRuns?.length === 0) return 0;
    const conversation = await this.db
      .selectFrom("conversations")
      .select(["id", "verified_customer_id", "source_channel"])
      .where("workspace_id", "=", messages.workspaceId)
      .where("id", "=", messages.conversationId)
      .executeTakeFirst();
    if (!conversation) return 0;
    const customerId = conversation.verified_customer_id;
    // The number a run saved for is not on the conversation's row: its channel keeps it by the conversation's id.
    const personKey = await this.personKeys.personKeyOf({
      workspaceId: messages.workspaceId, conversationId: conversation.id, sourceChannel: conversation.source_channel,
    });
    const deleted = await this.db
      .deleteFrom("context_variable_values")
      .where("workspace_id", "=", messages.workspaceId)
      .where("written_by_kind", "=", "routine")
      .where((eb) => eb.or([
        eb.and([eb("scope_type", "=", "conversation"), eb("scope_id", "=", conversation.id)]),
        ...(customerId ? [eb.and([eb("scope_type", "=", "customer"), eb("scope_id", "=", customerId)])] : []),
        ...(personKey ? [eb.and([eb("scope_type", "=", personKey.kind), eb("scope_id", "=", personKey.id)])] : []),
      ]))
      .where((eb) => eb.or(routineIds.map((routineId) => {
        const { prefixes: [run, runWithoutExecution], suffix } = routineWriterMatch(routineId, conversation.id);
        return eb.and([
          sql<boolean>`(starts_with(written_by_ref, ${run}) OR starts_with(written_by_ref, ${runWithoutExecution}))`,
          sql<boolean>`right(written_by_ref, length(${suffix})) = ${suffix}`,
        ]);
      })))
      .$if(messages.savedByRuns !== undefined, (query) => query.where("written_by_ref", "in", [...messages.savedByRuns ?? []]))
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}
