import type { ChannelPersonKey, ConversationChannelPersonKeys } from "../../../../shared/domain/channelPersonKey.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";

/**
 * What the WhatsApp channel lets other modules read by a number (#1884), through ports they own: the
 * number a conversation is with. A number is stored the way Meta reports it as `wa_id`, digits with
 * the country code first. The number is never logged.
 */

const whatsAppPersonKey = (number: string): ChannelPersonKey => ({ kind: "whatsapp_contact", id: number });

/** The WhatsApp number each conversation is with, recorded when the channel answers on it. */
export class WhatsAppConversationPersonKeys implements ConversationChannelPersonKeys {
  constructor(private readonly db: Db) {}

  async personKeyOf(input: { workspaceId: string; conversationId: string }): Promise<ChannelPersonKey | null> {
    const row = await this.db
      .selectFrom("connector_whatsapp_conversations")
      .select("wa_id")
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirst();
    return row ? whatsAppPersonKey(row.wa_id) : null;
  }
}
