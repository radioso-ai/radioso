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
  ): Promise<{ verifiedCustomerId: string | null; conversationIds: string[] } | null> {
    const visitor = await this.db
      .selectFrom("visitors")
      .select("verified_customer_id")
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
      conversationIds: conversations.map((conversation) => conversation.id),
    };
  }

  /**
   * Deletes the conversations, lowers each of their visitors' conversation count by the ones it lost,
   * and deletes a visitor left with no conversation at all. Returns how many conversations and
   * messages went.
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
      await this.db
        .deleteFrom("visitors")
        .where("workspace_id", "=", workspaceId)
        .where((eb) => anyOf(eb.ref("id"), [...lostByVisitor.keys()], "uuid[]"))
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
