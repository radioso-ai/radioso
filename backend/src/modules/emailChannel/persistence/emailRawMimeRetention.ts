import type { ConversationDataRetentionRule } from "../../../shared/domain/conversationDataRetention.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { UNFINISHED_STATES } from "./emailInboundRepository.js";

/** Days the raw copy of an inbound email is kept; the parsed body and the delivery's facts stay. */
export const EMAIL_RAW_MIME_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Clears the raw MIME of deliveries received more than {@link EMAIL_RAW_MIME_RETENTION_DAYS} days
 * ago, keeping the row. The row is the thread's memory: its message id and references are what a
 * later reply is matched against, its event key is what refuses a provider's redelivery, and its body
 * is erased with its conversation. Only the raw copy, whose headers and attachments repeat what the
 * conversation holds, has no use once the mail is settled. An unfinished delivery keeps its copy,
 * since the step that advances it may still read it; opening a cleared one answers `raw_purged`.
 */
export class EmailRawMimeRetention implements ConversationDataRetentionRule {
  readonly table = "email_inbound_deliveries.raw_mime";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const receivedBefore = new Date(input.now.getTime() - EMAIL_RAW_MIME_RETENTION_DAYS * DAY_MS);
    const cleared = await this.db
      .updateTable("email_inbound_deliveries")
      .set({ raw_mime: null })
      .where("id", "in", (eb) => eb
        .selectFrom("email_inbound_deliveries")
        .select("id")
        .where("raw_mime", "is not", null)
        .where("created_at", "<", receivedBefore)
        .where("state", "not in", UNFINISHED_STATES)
        .limit(input.limit)
        .forUpdate()
        .skipLocked())
      .executeTakeFirst();
    return Number(cleared.numUpdatedRows);
  }
}
