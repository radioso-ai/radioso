import { WITHHELD_MESSAGE_TEXT, type MessageCopyWithholder, type WithheldMessages } from "../../../shared/domain/messageWithholding.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * Withholds the mail a withheld message came in as: the parsed body takes the redaction marker and
 * the raw copy goes, so opening it answers as one the retention window cleared. The delivery row
 * stays, since its message id and references are what match the thread's later replies, and so
 * does its subject, which names the thread every message of it shares.
 */
export class EmailMessageWithholder implements MessageCopyWithholder {
  readonly owner = "email-channel";

  constructor(private readonly db: Db) {}

  async withhold(messages: WithheldMessages): Promise<number> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set((eb) => ({
        body_text: eb.case().when("body_text", "is", null).then(null).else(WITHHELD_MESSAGE_TEXT).end(),
        raw_mime: null,
      }))
      .where("workspace_id", "=", messages.workspaceId)
      .where("conversation_id", "=", messages.conversationId)
      .where((eb) => anyOf(eb.ref("message_id"), messages.messageIds, "uuid[]"))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
