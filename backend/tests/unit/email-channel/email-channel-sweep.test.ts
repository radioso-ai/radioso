import { describe, expect, it, vi } from "vitest";

import { EmailChannelSweep } from "../../../src/modules/emailChannel/public.js";
import type { EmailBacklogReader } from "../../../src/modules/emailChannel/maintenance/emailChannelSweep.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { InMemoryEmailInbound } from "../../support/inMemoryEmailChannel.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;

const noAbandonedAutoSends = () => ({
  queued: { listQueuedAutoBefore: vi.fn(async (): Promise<string[]> => []) },
  outbox: { liveIdempotencyKeys: vi.fn(async (): Promise<ReadonlySet<string>> => new Set<string>()) },
  dispatch: { returnAbandonedAuto: vi.fn(async () => true) },
});

const sweepWith = (backlog?: { reader: EmailBacklogReader; metrics: MetricsRegistry }) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const sweep = new EmailChannelSweep({
    inbound: new InMemoryEmailInbound(() => NOW),
    domains: { refreshDue: vi.fn(async () => 0), cleanupRemoved: vi.fn(async () => 0) },
    sends: { run: vi.fn(async () => ({ claimed: 0, reposted: 0, settled: 0, uncertain: 0, deferred: 0, skipped: 0, errored: 0 })) },
    clock: () => NOW,
    logger,
    config: { eventRetentionDays: 30 },
    abandonedAutoSends: noAbandonedAutoSends(),
    ...(backlog ? { backlog } : {}),
  });
  return { sweep, logger };
};

/** The `radioso_email_backlog` series as `/metrics` renders them. */
const backlogSeries = (metrics: MetricsRegistry): string[] =>
  metrics.renderPrometheus().split("\n").filter((line) => line.startsWith("radioso_email_backlog{"));

// The sweep samples the work each stage has left waiting past its deadline into the
// `radioso_email_backlog` gauge (contracts/events.md, Metrics and Alerts), which the documented
// inbound-backlog alert reads. A queue that is busy but draining stays at zero.
describe("EmailChannelSweep, backlog gauge", () => {
  it("publishes the overdue work per table and state, asking for rows past each stage's deadline", async () => {
    const metrics = new MetricsRegistry();
    const reader: EmailBacklogReader = {
      countOverdue: vi.fn(async () => ({ inboundPending: 3, inboundProcessing: 1, reviewsDue: 2, sendsQueued: 0 })),
    };
    const { sweep } = sweepWith({ reader, metrics });

    await sweep.run({ maxJobs: 10 });

    expect(reader.countOverdue).toHaveBeenCalledWith({
      inboundReceivedBefore: new Date(NOW.getTime() - 10 * MINUTE_MS),
      reviewDueBefore: new Date(NOW.getTime() - 5 * MINUTE_MS),
      sendQueuedBefore: new Date(NOW.getTime() - 10 * MINUTE_MS),
    });
    expect(backlogSeries(metrics)).toEqual([
      'radioso_email_backlog{state="pending",table="inbound_events"} 3',
      'radioso_email_backlog{state="processing",table="inbound_events"} 1',
      'radioso_email_backlog{state="due",table="reviews_due"} 2',
      'radioso_email_backlog{state="queued",table="send_intents"} 0',
    ]);
  });

  it("resets a stage to zero once its work drains, so the alert resolves", async () => {
    const metrics = new MetricsRegistry();
    const counts = { inboundPending: 4, inboundProcessing: 0, reviewsDue: 0, sendsQueued: 0 };
    const { sweep } = sweepWith({ reader: { countOverdue: async () => ({ ...counts }) }, metrics });

    await sweep.run({ maxJobs: 10 });
    counts.inboundPending = 0;
    await sweep.run({ maxJobs: 10 });

    expect(backlogSeries(metrics)).toContain('radioso_email_backlog{state="pending",table="inbound_events"} 0');
  });

  it("keeps the sweep's own work when sampling fails, and logs the failure by name only", async () => {
    const metrics = new MetricsRegistry();
    const { sweep, logger } = sweepWith({
      reader: { countOverdue: async () => { throw new TypeError("connection reset"); } },
      metrics,
    });

    const result = await sweep.run({ maxJobs: 10 });

    expect(result.recoveredLeases).toBe(0);
    expect(backlogSeries(metrics)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith({ errorName: "TypeError" }, "email_backlog_sample_failed");
  });

  it("samples nothing where no metrics are recorded", async () => {
    const { sweep, logger } = sweepWith();

    await expect(sweep.run({ maxJobs: 10 })).resolves.toMatchObject({ recoveredLeases: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
