import type { ConversationRoutineOfferMemory } from "@radioso/conversation-contract";

import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Records that a conversation was shown an offer to start a routine (#1716), once per routine.
 * Shared with the assistant-turn transaction, which writes it beside the offer's pending row.
 */
export const recordRoutineOffer = async (db: Db, input: { sessionId: string; routineId: string }): Promise<void> => {
  await db
    .insertInto("routine_offers")
    .values({ conversation_id: input.sessionId, routine_id: input.routineId })
    .onConflict((oc) => oc.columns(["conversation_id", "routine_id"]).doNothing())
    .execute();
};

/**
 * Which routines a conversation was offered. The pending offer is a `clarification_states` row,
 * which the next clarification replaces; `routine_offers` keeps the fact that the offer was shown
 * for as long as the conversation exists, so a routine is offered at most once per conversation.
 */
export class RoutineOfferRepository implements ConversationRoutineOfferMemory {
  constructor(private readonly db: Db) {}

  async loadOffered(input: { sessionId: string }): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("routine_offers")
      .select("routine_id")
      .where("conversation_id", "=", input.sessionId)
      .orderBy("offered_at")
      .execute();
    return rows.map((row) => row.routine_id);
  }

  async record(input: { sessionId: string; routineId: string }): Promise<void> {
    await recordRoutineOffer(this.db, input);
  }
}
