import type { Kysely } from "kysely";
import { z } from "zod";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type { A2aMessageReceiptStore, A2aReceiptClaim, A2aReceiptResult } from "../contracts/ports.js";

const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), replyMessageId: z.string().min(1), envelope: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("task"), taskId: z.string().min(1) }),
]);

/** A stored result this release can replay; anything else reads as no result at all. */
const readResult = (value: unknown): A2aReceiptResult | null => {
  const parsed = resultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export class A2aMessageReceiptRepository implements A2aMessageReceiptStore {
  constructor(private readonly db: Kysely<DB>) {}

  /**
   * One statement decides the claim: a new receipt is inserted in flight under the caller's claim
   * token, and an existing one is taken over, under the new token, only while it is in flight and
   * older than `staleBefore`. Anything else is read back as it stands, so two retries racing each
   * other cannot both run the turn.
   */
  async claim(input: Parameters<A2aMessageReceiptStore["claim"]>[0]): Promise<A2aReceiptClaim> {
    const now = new Date();
    const claimed = await this.db
      .insertInto("a2a_message_receipts")
      .values({
        conversation_id: input.conversationId,
        message_digest: input.messageKey,
        workspace_id: input.workspaceId,
        state: "in_flight",
        claim_token: input.claimToken,
        claimed_at: now,
        expires_at: input.expiresAt,
      })
      .onConflict((conflict) => conflict
        .columns(["conversation_id", "message_digest"])
        .doUpdateSet({ claim_token: input.claimToken, claimed_at: now })
        .where("a2a_message_receipts.state", "=", "in_flight")
        .where("a2a_message_receipts.claimed_at", "<", input.staleBefore))
      .returning("state")
      .executeTakeFirst();
    if (claimed) {
      return { kind: "claimed" };
    }
    const existing = await this.db
      .selectFrom("a2a_message_receipts")
      .select(["state", "result"])
      .where("conversation_id", "=", input.conversationId)
      .where("message_digest", "=", input.messageKey)
      .executeTakeFirst();
    const result = existing?.state === "completed" ? readResult(existing.result) : null;
    return result ? { kind: "completed", result } : { kind: "in_flight" };
  }

  async complete(input: Parameters<A2aMessageReceiptStore["complete"]>[0]): Promise<void> {
    const now = new Date();
    if (input.claimToken === null) {
      // A context's first send claimed nothing: record it only where no receipt exists.
      await this.db
        .insertInto("a2a_message_receipts")
        .values({
          conversation_id: input.conversationId,
          message_digest: input.messageKey,
          workspace_id: input.workspaceId,
          state: "completed",
          result: toJsonb(input.result),
          claimed_at: now,
          completed_at: now,
          expires_at: input.expiresAt,
        })
        .onConflict((conflict) => conflict.columns(["conversation_id", "message_digest"]).doNothing())
        .execute();
      return;
    }
    await this.db
      .updateTable("a2a_message_receipts")
      .set({ state: "completed", result: toJsonb(input.result), completed_at: now, expires_at: input.expiresAt })
      .where("conversation_id", "=", input.conversationId)
      .where("message_digest", "=", input.messageKey)
      .where("state", "=", "in_flight")
      .where("claim_token", "=", input.claimToken)
      .execute();
  }

  async release(input: Parameters<A2aMessageReceiptStore["release"]>[0]): Promise<void> {
    await this.db
      .deleteFrom("a2a_message_receipts")
      .where("conversation_id", "=", input.conversationId)
      .where("message_digest", "=", input.messageKey)
      .where("state", "=", "in_flight")
      .where("claim_token", "=", input.claimToken)
      .execute();
  }
}
