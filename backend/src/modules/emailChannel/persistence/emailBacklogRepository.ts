import type { Db } from "../../../shared/infra/kysely/types.js";

/** The channel's work, across every workspace, still waiting past its stage's deadline. */
interface EmailBacklogCounts {
  /** Inbound events received before the cutoff and not yet processed, by state. */
  inboundPending: number;
  inboundProcessing: number;
  /** Threads whose review fell due before the cutoff and has not run. */
  reviewsDue: number;
  /** Send intents created before the cutoff that the provider has not accepted. */
  sendsQueued: number;
}

/**
 * Counts the channel's overdue work across every workspace for the backlog gauge. Each count
 * reads only rows in a waiting state, which the drains' partial indexes already cover.
 */
export class EmailBacklogRepository {
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
