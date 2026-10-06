import type { Db } from "../../../shared/infra/kysely/types.js";
import type { EmailBacklogCounts, EmailBacklogReader } from "../maintenance/emailChannelSweep.js";

/**
 * Counts the channel's overdue work across every workspace for the sweep's backlog gauge. Each
 * count reads only rows in a waiting state, which the drains' partial indexes already cover.
 */
export class EmailBacklogRepository implements EmailBacklogReader {
  constructor(private readonly db: Db) {}

  async countOverdue(input: { inboundReceivedBefore: Date; reviewDueBefore: Date; sendQueuedBefore: Date }): Promise<EmailBacklogCounts> {
    const [inbound, reviews, sends] = await Promise.all([
      this.db
        .selectFrom("email_inbound_events")
        .select((eb) => [
          eb.fn.countAll<string>().filterWhere("state", "=", "pending").as("pending"),
          eb.fn.countAll<string>().filterWhere("state", "=", "processing").as("processing"),
        ])
        .where("state", "in", ["pending", "processing"])
        .where("received_at", "<", input.inboundReceivedBefore)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom("email_thread_links")
        .select((eb) => eb.fn.countAll<string>().as("due"))
        .where("review_due_at", "<", input.reviewDueBefore)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom("email_send_intents")
        .select((eb) => eb.fn.countAll<string>().as("queued"))
        .where("state", "=", "queued")
        .where("created_at", "<", input.sendQueuedBefore)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      inboundPending: Number(inbound.pending),
      inboundProcessing: Number(inbound.processing),
      reviewsDue: Number(reviews.due),
      sendsQueued: Number(sends.queued),
    };
  }
}
