import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { ConversationDataEraser, ConversationErasureScope } from "../../../shared/domain/conversationDataErasure.js";

/** Events no worker holds or will claim again. */
const SETTLED_EVENT_STATES = ["processed", "ignored", "failed"] as const;

/**
 * Erases the inbound mail a conversation received: its deliveries (sender, subject, body, raw
 * MIME), including one still reserved for the conversation by `planned_conversation_id` before
 * ingest attached it, and then each settled provider event left with no delivery, whose envelope
 * names the sender too. An event a worker still holds stays until the retention sweep takes it.
 *
 * A workspace's deliveries cascade with it, but its events carry no workspace and would outlive it,
 * so the workspace scope removes the deliveries itself to find them.
 */
export class EmailInboundEraser implements ConversationDataEraser {
  readonly owner = "email-channel";

  constructor(private readonly db: Db) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "conversations" && scope.conversationIds.length === 0) {
      return 0;
    }
    const deliveries = await this.db
      .deleteFrom("email_inbound_deliveries")
      .where("workspace_id", "=", scope.workspaceId)
      .$if(scope.kind === "conversations", (qb) => qb.where((eb) => {
        const conversationIds = scope.kind === "conversations" ? scope.conversationIds : [];
        return eb.or([
          anyOf(eb.ref("conversation_id"), conversationIds, "uuid[]"),
          anyOf(eb.ref("planned_conversation_id"), conversationIds, "uuid[]"),
        ]);
      }))
      .returning("inbound_event_id")
      .execute();
    if (deliveries.length === 0) {
      return 0;
    }
    const eventIds = [...new Set(deliveries.map((delivery) => delivery.inbound_event_id))];
    const events = await this.db
      .deleteFrom("email_inbound_events")
      .where((eb) => anyOf(eb.ref("id"), eventIds, "uuid[]"))
      .where("state", "in", [...SETTLED_EVENT_STATES])
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom("email_inbound_deliveries as d").select("d.id").whereRef("d.inbound_event_id", "=", "email_inbound_events.id"))),
      )
      .executeTakeFirst();
    return deliveries.length + Number(events.numDeletedRows);
  }
}
