import type { EmailBacklogRepository } from "../../../modules/emailChannel/public.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsCollector, MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

/** The longest a scrape may report a sample for: scrapes inside it reuse the last read. */
const SAMPLE_INTERVAL_MS = 30 * 1000;

/**
 * How long each stage's work may wait before it counts toward the gauge: the deadlines the alerts
 * in contracts/events.md name. Work younger than its deadline is in flight, not stuck.
 */
const OVERDUE_AFTER_MS = {
  inboundReceived: 10 * 60 * 1000,
  reviewDue: 5 * 60 * 1000,
  sendQueued: 10 * 60 * 1000,
} as const;

const BACKLOG_GAUGE_HELP = "Email channel work waiting past its stage's deadline, by table and state.";

/**
 * The `email_backlog` gauge, sampled when the API's metrics endpoint is scraped. The counts are
 * shared database state, so the API reports them although the worker does the work, and every
 * instance reports the same deployment-wide value. Every series is written each time, so a
 * drained stage reads zero.
 */
export const createEmailBacklogSampler = (deps: {
  reader: Pick<EmailBacklogRepository, "countOverdue">;
  metrics: Pick<MetricsRegistry, "setGauge">;
  logger: Pick<AppLogger, "warn">;
  clock: () => Date;
}): MetricsCollector => {
  let lastReadAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  const sample = async (now: number): Promise<void> => {
    let counts: Awaited<ReturnType<EmailBacklogRepository["countOverdue"]>>;
    try {
      counts = await deps.reader.countOverdue({
        inboundReceivedBefore: new Date(now - OVERDUE_AFTER_MS.inboundReceived),
        reviewDueBefore: new Date(now - OVERDUE_AFTER_MS.reviewDue),
        sendQueuedBefore: new Date(now - OVERDUE_AFTER_MS.sendQueued),
      });
    } catch (error) {
      // The gauge keeps its last sample; the first scrape after the interval reads again.
      deps.logger.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "email_backlog_sample_failed");
      return;
    }
    const series: ReadonlyArray<readonly [table: string, state: string, value: number]> = [
      ["inbound_events", "pending", counts.inboundPending],
      ["inbound_events", "processing", counts.inboundProcessing],
      ["reviews_due", "due", counts.reviewsDue],
      ["send_intents", "queued", counts.sendsQueued],
    ];
    for (const [table, state, value] of series) {
      deps.metrics.setGauge("email_backlog", { help: BACKLOG_GAUGE_HELP, labels: { table, state }, value });
    }
  };

  return () => {
    if (inFlight) return inFlight;
    const now = deps.clock().getTime();
    if (lastReadAt !== null && now - lastReadAt < SAMPLE_INTERVAL_MS) return Promise.resolve();
    lastReadAt = now;
    inFlight = sample(now).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
};
