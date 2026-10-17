import { anyOf } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The conversations and visitor rows an erasure removes. Everything with a foreign key to a
 * conversation cascades from {@link deleteConversations}; what no key reaches is each owning
 * module's eraser. Run it inside the erasure's transaction.
 */
export class ConversationErasureRepository {
  constructor(private readonly db: Db) {}

  /**
   * Locks the visitor's row `FOR UPDATE`, so a conversation cannot attach to it until the erasure
   * commits, and returns it with the conversations it has now.
   */
  async lockVisitor(
    workspaceId: string,
    visitorId: string,
  ): Promise<{ verifiedCustomerId: string | null; visitorKey: string | null; conversationIds: string[] } | null> {
    const visitor = await this.db
      .selectFrom("visitors")
      .select(["verified_customer_id", "visitor_key"])
      .where("id", "=", visitorId)
      .where("workspace_id", "=", workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!visitor) {
      return null;
    }
    const conversations = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("visitor_id", "=", visitorId)
      .execute();
    return {
      verifiedCustomerId: visitor.verified_customer_id,
      visitorKey: visitor.visitor_key,
      conversationIds: conversations.map((conversation) => conversation.id),
    };
  }

  /**
   * Deletes the conversations, lowers each of their visitors' conversation count by the ones it
   * lost, and deletes an *anonymous* visitor left with no conversation at all — a verified
   * visitor is the customer's identity, not one conversation's, so it stays as the handle a later
   * visitor erase needs to reach that customer's context values through. Returns how many
   * conversations and messages went.
   */
  async deleteConversations(
    workspaceId: string,
    conversationIds: readonly string[],
  ): Promise<{ conversations: number; messages: number }> {
    if (conversationIds.length === 0) {
      return { conversations: 0, messages: 0 };
    }
    const messages = await this.db
      .selectFrom("messages")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), conversationIds, "uuid[]"))
      .executeTakeFirstOrThrow();
    const deleted = await this.db
      .deleteFrom("conversations")
      .where("workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("id"), conversationIds, "uuid[]"))
      .returning("visitor_id")
      .execute();
    const lostByVisitor = new Map<string, number>();
    for (const { visitor_id: visitorId } of deleted) {
      if (visitorId) lostByVisitor.set(visitorId, (lostByVisitor.get(visitorId) ?? 0) + 1);
    }
    for (const [visitorId, lost] of lostByVisitor) {
      await this.db
        .updateTable("visitors")
        .set((eb) => ({ conversation_count: eb.fn("greatest", [eb("conversation_count", "-", lost), eb.val(0)]) }))
        .where("id", "=", visitorId)
        .where("workspace_id", "=", workspaceId)
        .execute();
    }
    if (lostByVisitor.size > 0) {
      const candidateIds = [...lostByVisitor.keys()];
      // Lock the candidates in their own statement first, before deciding whether each still has a
      // conversation. A concurrent insert for one of them holds a FOR KEY SHARE lock on its visitor
      // row for the life of that transaction (the new conversation's foreign key); FOR UPDATE here
      // waits for it. Running the delete below as a separate, later statement then gives it a fresh
      // READ COMMITTED snapshot — taken only once that wait is over — that sees the new conversation,
      // instead of reusing the snapshot the delete would otherwise have taken before the wait, which
      // would still show no conversation and remove a visitor whose new one just committed.
      await this.db
        .selectFrom("visitors")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where((eb) => anyOf(eb.ref("id"), candidateIds, "uuid[]"))
        .where("verified_customer_id", "is", null)
        .orderBy("id")
        .forUpdate()
        .execute();
      await this.db
        .deleteFrom("visitors")
        .where("workspace_id", "=", workspaceId)
        .where((eb) => anyOf(eb.ref("id"), candidateIds, "uuid[]"))
        .where("verified_customer_id", "is", null)
        .where(({ not, exists, selectFrom }) => not(exists(
          selectFrom("conversations").select("conversations.id").whereRef("conversations.visitor_id", "=", "visitors.id"),
        )))
        .execute();
    }
    return { conversations: deleted.length, messages: Number(messages.count) };
  }

  async deleteVisitor(workspaceId: string, visitorId: string): Promise<void> {
    await this.db
      .deleteFrom("visitors")
      .where("id", "=", visitorId)
      .where("workspace_id", "=", workspaceId)
      .execute();
  }
}
