import type {
  NotificationDeliveryPosition,
  NotificationDeliveryRecord,
  NotificationDeliveryStore,
  NotificationKind,
  RecipientDelivery,
  RecipientDeliveryOutcome,
} from "../../modules/operatorNotifications/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The per-address record of notices. Rows are keyed by action request and address, so a retried
 * request updates what it wrote before, and timestamps come from the application's clock to the
 * millisecond so a page cursor (which carries a JavaScript date) never falls between two rows that
 * were written together.
 */
export class NotificationDeliveryRepository implements NotificationDeliveryStore {
  constructor(private readonly db: Db) {}

  async upsert(
    subject: {
      workspaceId: string;
      agentId: string | null;
      conversationId: string;
      requestId: string;
      kind: NotificationKind;
    },
    deliveries: readonly RecipientDelivery[],
  ): Promise<void> {
    // One outcome per address: the last one a caller reports for it wins.
    const byEmail = new Map(deliveries.map((delivery) => [delivery.email, delivery.outcome]));
    const at = new Date();
    await this.db.transaction().execute(async (transaction) => {
      for (const [email, outcome] of byEmail) {
        // Selected from the conversation so a conversation erased since the notice was sent leaves
        // nothing to write instead of failing, and so a notice that names no agent takes the
        // conversation's.
        await transaction
          .insertInto("notification_deliveries")
          .columns(["workspace_id", "agent_id", "conversation_id", "request_id", "kind", "recipient_email", "outcome", "created_at", "updated_at"])
          .expression((eb) => eb
            .selectFrom("conversations as c")
            .select((selected) => [
              "c.workspace_id",
              selected.fn.coalesce(selected.val(subject.agentId), "c.agent_id").as("agent_id"),
              "c.id as conversation_id",
              selected.val(subject.requestId).as("request_id"),
              selected.val(subject.kind).as("kind"),
              selected.val(email).as("recipient_email"),
              selected.val(outcome).as("outcome"),
              selected.val(at).as("created_at"),
              selected.val(at).as("updated_at"),
            ])
            .where("c.id", "=", subject.conversationId)
            .where("c.workspace_id", "=", subject.workspaceId))
          .onConflict((conflict) => conflict
            .columns(["request_id", "recipient_email"])
            .doUpdateSet({ outcome, updated_at: at })
            // A mail that went out stays recorded as sent.
            .where("notification_deliveries.outcome", "<>", "sent"))
          .execute();
      }
    });
  }

  async list(workspaceId: string, query: {
    agentId?: string;
    outcome?: RecipientDeliveryOutcome;
    after: NotificationDeliveryPosition | null;
    limit: number;
  }): Promise<NotificationDeliveryRecord[]> {
    const { agentId, outcome, after } = query;
    const rows = await this.db
      .selectFrom("notification_deliveries")
      .select(["id", "agent_id", "conversation_id", "kind", "recipient_email", "outcome", "created_at", "updated_at"])
      .where("workspace_id", "=", workspaceId)
      .$if(agentId !== undefined, (builder) => builder.where("agent_id", "=", agentId!))
      .$if(outcome !== undefined, (builder) => builder.where("outcome", "=", outcome!))
      .$if(after !== null, (builder) => builder.where((eb) => eb.or([
        eb("created_at", "<", after!.createdAt),
        eb.and([eb("created_at", "=", after!.createdAt), eb("id", "<", after!.id)]),
      ])))
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(query.limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      kind: row.kind as NotificationKind,
      recipientEmail: row.recipient_email,
      outcome: row.outcome as RecipientDeliveryOutcome,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }
}
