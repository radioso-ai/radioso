import { describe, expect, it, vi } from "vitest";

import { createEmailBacklogSampler } from "../../../src/app/composition/emailChannel/backlogSampler.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

const START = new Date("2026-10-03T12:00:00.000Z");
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

type Counts = { inboundPending: number; inboundProcessing: number; reviewsDue: number; sendsQueued: number };

const samplerWith = (countOverdue: () => Promise<Counts>) => {
  let now = START.getTime();
  const metrics = new MetricsRegistry();
  const logger = { warn: vi.fn() };
  const reader = { countOverdue: vi.fn(countOverdue) };
  metrics.registerCollector(createEmailBacklogSampler({ reader, metrics, logger, clock: () => new Date(now) }));
  return {
    metrics,
    logger,
    reader,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** The `radioso_email_backlog` series as `/metrics` renders them. */
const backlogSeries = (metrics: MetricsRegistry): string[] =>
  metrics.renderPrometheus().split("\n").filter((line) => line.startsWith("radioso_email_backlog{"));

// The API's scrape samples the work each stage has left waiting past its deadline into the
// `radioso_email_backlog` gauge (contracts/events.md, Metrics and Alerts). The counts are shared
// database state, so any scraped API instance reports them; a draining queue reads zero.
describe("email backlog sampler", () => {
  it("publishes the overdue work per table and state on a scrape, asking for rows past each stage's deadline", async () => {
    const { metrics, reader } = samplerWith(async () => ({ inboundPending: 3, inboundProcessing: 1, reviewsDue: 2, sendsQueued: 0 }));

    await metrics.collect();

    expect(reader.countOverdue).toHaveBeenCalledWith({
      inboundReceivedBefore: new Date(START.getTime() - 10 * MINUTE_MS),
      reviewDueBefore: new Date(START.getTime() - 5 * MINUTE_MS),
      sendQueuedBefore: new Date(START.getTime() - 10 * MINUTE_MS),
    });
    expect(backlogSeries(metrics)).toEqual([
      'radioso_email_backlog{state="pending",table="inbound_events"} 3',
      'radioso_email_backlog{state="processing",table="inbound_events"} 1',
      'radioso_email_backlog{state="due",table="reviews_due"} 2',
      'radioso_email_backlog{state="queued",table="send_intents"} 0',
    ]);
  });

  it("reads the database at most once every 30 seconds, however often it is scraped", async () => {
    const { metrics, reader, advance } = samplerWith(async () => ({ inboundPending: 0, inboundProcessing: 0, reviewsDue: 0, sendsQueued: 0 }));

    await metrics.collect();
    advance(29 * SECOND_MS);
    await metrics.collect();
    expect(reader.countOverdue).toHaveBeenCalledTimes(1);

    advance(1 * SECOND_MS);
    await metrics.collect();
    expect(reader.countOverdue).toHaveBeenCalledTimes(2);
  });

  it("shares one read between scrapes that arrive while it is in flight", async () => {
    let release: (counts: Counts) => void = () => undefined;
    const { metrics, reader } = samplerWith(() => new Promise<Counts>((resolve) => {
      release = resolve;
    }));

    const first = metrics.collect();
    const second = metrics.collect();
    release({ inboundPending: 1, inboundProcessing: 0, reviewsDue: 0, sendsQueued: 0 });
    await Promise.all([first, second]);

    expect(reader.countOverdue).toHaveBeenCalledTimes(1);
    expect(backlogSeries(metrics)).toContain('radioso_email_backlog{state="pending",table="inbound_events"} 1');
  });

  it("resets a stage to zero once its work drains, so the alert resolves", async () => {
    const counts = { inboundPending: 4, inboundProcessing: 0, reviewsDue: 0, sendsQueued: 0 };
    const { metrics, advance } = samplerWith(async () => ({ ...counts }));

    await metrics.collect();
    counts.inboundPending = 0;
    advance(30 * SECOND_MS);
    await metrics.collect();

    expect(backlogSeries(metrics)).toContain('radioso_email_backlog{state="pending",table="inbound_events"} 0');
  });

  it("keeps the last sample when a read fails, logs it by name only, and waits out the interval before retrying", async () => {
    let fail = false;
    const { metrics, reader, logger, advance } = samplerWith(async () => {
      if (fail) throw new TypeError("connection reset");
      return { inboundPending: 2, inboundProcessing: 0, reviewsDue: 0, sendsQueued: 0 };
    });

    await metrics.collect();
    fail = true;
    advance(30 * SECOND_MS);
    await expect(metrics.collect()).resolves.toBeUndefined();
    await metrics.collect();

    expect(reader.countOverdue).toHaveBeenCalledTimes(2);
    expect(backlogSeries(metrics)).toContain('radioso_email_backlog{state="pending",table="inbound_events"} 2');
    expect(logger.warn).toHaveBeenCalledWith({ errorName: "TypeError" }, "email_backlog_sample_failed");
  });

  it("publishes nothing until it is scraped", () => {
    const { metrics, reader } = samplerWith(async () => ({ inboundPending: 1, inboundProcessing: 0, reviewsDue: 0, sendsQueued: 0 }));

    expect(backlogSeries(metrics)).toEqual([]);
    expect(reader.countOverdue).not.toHaveBeenCalled();
  });
});
