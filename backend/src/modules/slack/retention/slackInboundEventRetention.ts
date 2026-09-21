import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * How long a Slack inbound event id is kept. The row exists only to deduplicate Slack's
 * redelivery of the same `event_id` (Slack retries for minutes, not days) and to mark stale
 * in-flight events failed; it carries no message text. Subscribing to channel traffic
 * writes one row per message in every joined channel, so without a sweep the ledger is an
 * indefinite archive of activity timestamps.
 */
export const SLACK_INBOUND_EVENT_RETENTION_DAYS = 7;

/** Narrow port for the retention sweep alone; it is not part of the connector's persistence surface. */
interface SlackInboundEventRetentionPort {
  /** Deletes at most `limit` inbound events received before `cutoff`, oldest first; returns how many went. */
  deleteBefore(input: { cutoff: Date; limit: number }): Promise<number>;
}

export class PostgresSlackInboundEventRetention implements SlackInboundEventRetentionPort {
  constructor(private readonly db: Db) {}

  async deleteBefore(input: { cutoff: Date; limit: number }): Promise<number> {
    const result = await this.db
      .deleteFrom("slack_inbound_events")
      .where("event_id", "in", (eb) =>
        eb
          .selectFrom("slack_inbound_events")
          .select("event_id")
          .where("received_at", "<", input.cutoff)
          .orderBy("received_at")
          .limit(input.limit))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
