import { afterEach, describe, expect, it, vi } from "vitest";

import { EmailChannelWorker } from "../../../src/modules/connectors/plugins/email/emailChannelWorker.js";
import { EmailChannelSweep, emailSendKey, type InboundEventRecord } from "../../../src/modules/emailChannel/public.js";
import { InMemoryEmailInbound } from "../../support/inMemoryEmailChannel.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-10-03T12:00:00.000Z");

/** The abandoned-send step with no queued sends to look at. */
const noAbandonedAutoSends = () => ({
  queued: { listQueuedAutoBefore: vi.fn(async (_input: { policyRefPrefix: string; before: Date; limit: number }): Promise<string[]> => []) },
  outbox: { liveIdempotencyKeys: vi.fn(async (_keys: readonly string[]): Promise<ReadonlySet<string>> => new Set<string>()) },
  dispatch: { returnAbandonedAuto: vi.fn(async (_heldReplyId: string) => true) },
});

const harness = (options: { enabled?: boolean } = {}) => {
  let now = START;
  const clock = () => now;
  const inbound = new InMemoryEmailInbound(clock);
  const process = vi.fn(async (_event: InboundEventRecord) => "processed" as const);
  const domains = { refreshDue: vi.fn(async () => 2), cleanupRemoved: vi.fn(async () => 1) };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const sends = { run: vi.fn(async (_request: { maxJobs: number }) => ({ claimed: 0, reposted: 0, settled: 0, uncertain: 0, deferred: 0, skipped: 0, errored: 0 })) };
  const abandonedAutoSends = noAbandonedAutoSends();
  const sweep = new EmailChannelSweep({ inbound, domains, sends, clock, logger, config: { eventRetentionDays: 30 }, abandonedAutoSends });
  const reviews = {
    runDue: vi.fn(async (_request: { maxJobs: number }) => ({
      claimed: 0, held: 0, queued_auto: 0, already_held: 0, no_draft: 0, human_owned: 0, not_runnable: 0, budget_exhausted: 0, retrying: 0, failed: 0, errored: 0,
    })),
  };
  const worker = new EmailChannelWorker({
    enabled: options.enabled ?? true,
    events: inbound,
    processor: { process },
    reviews,
    sweep,
    logger,
    leaseSeconds: 300,
    pollIntervalMs: 1_000,
    sweepIntervalMs: 60_000,
  });
  return {
    inbound,
    process,
    reviews,
    domains,
    sends,
    logger,
    abandonedAutoSends,
    sweep,
    worker,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("EmailChannelWorker", () => {
  it("drains on an interval once started, and stops", async () => {
    vi.useFakeTimers();
    const h = harness();
    const claim = vi.spyOn(h.inbound, "claimDueEvents");

    h.worker.start();
    h.worker.start();
    expect(h.worker.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(1);

    await h.worker.stop();
    expect(h.worker.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("sweeps on its own, slower interval", async () => {
    vi.useFakeTimers();
    const h = harness();

    h.worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.worker.stop();

    expect(h.domains.refreshDue).toHaveBeenCalledOnce();
  });

  it("claims only due work, bounded by maxJobs", async () => {
    const h = harness();
    const due = [h.inbound.seedEvent(), h.inbound.seedEvent(), h.inbound.seedEvent()];
    const later = h.inbound.seedEvent({ nextAttemptAt: new Date(START.getTime() + 60_000) });

    const result = await h.worker.drain({ maxJobs: 2, stage: "inbound" });

    expect(result).toMatchObject({ claimed: 2, processed: 2 });
    const processedIds = h.process.mock.calls.map(([event]) => event.id);
    expect(processedIds.every((id) => due.some((event) => event.id === id))).toBe(true);
    expect(processedIds).not.toContain(later.id);
    expect(h.inbound.events.get(later.id)?.state).toBe("pending");
  });

  it("drains inbound work for the inbound and all stages only", async () => {
    const h = harness();
    h.inbound.seedEvent();

    expect((await h.worker.drain({ maxJobs: 5, stage: "review" })).claimed).toBe(0);
    expect((await h.worker.drain({ maxJobs: 5, stage: "reconcile" })).claimed).toBe(0);
    expect((await h.worker.drain({ maxJobs: 5, stage: "all" })).claimed).toBe(1);
  });

  it("reconciles due sends for the reconcile and all stages only", async () => {
    const h = harness();
    h.sends.run.mockResolvedValue({ claimed: 2, reposted: 1, settled: 1, uncertain: 0, deferred: 0, skipped: 0, errored: 0 });

    expect(await h.worker.drain({ maxJobs: 4, stage: "reconcile" })).toMatchObject({ reconciled: 2, claimed: 0 });
    expect(await h.worker.drain({ maxJobs: 4, stage: "all" })).toMatchObject({ reconciled: 2 });
    expect(await h.worker.drain({ maxJobs: 4, stage: "inbound" })).toMatchObject({ reconciled: 0 });
    expect(await h.worker.drain({ maxJobs: 4, stage: "review" })).toMatchObject({ reconciled: 0 });
    expect(h.sends.run).toHaveBeenCalledTimes(2);
    expect(h.sends.run).toHaveBeenCalledWith({ maxJobs: 4 });
  });

  it("runs due reviews (stage 2) for the review and all stages only, after inbound work", async () => {
    const h = harness();
    h.inbound.seedEvent();
    const order: string[] = [];
    h.process.mockImplementation(async () => {
      order.push("inbound");
      return "processed";
    });
    h.reviews.runDue.mockImplementation(async () => {
      order.push("review");
      return { claimed: 2, held: 2, queued_auto: 0, already_held: 0, no_draft: 0, human_owned: 0, not_runnable: 0, budget_exhausted: 0, retrying: 0, failed: 0, errored: 0 };
    });

    expect(await h.worker.drain({ maxJobs: 3, stage: "review" })).toMatchObject({ reviewed: 2, claimed: 0 });
    expect(await h.worker.drain({ maxJobs: 3, stage: "inbound" })).toMatchObject({ reviewed: 0, claimed: 1 });
    h.inbound.seedEvent();
    expect(await h.worker.drain({ maxJobs: 3, stage: "all" })).toMatchObject({ reviewed: 2, claimed: 1 });
    expect(await h.worker.drain({ maxJobs: 3, stage: "reconcile" })).toMatchObject({ reviewed: 0 });
    expect(h.reviews.runDue).toHaveBeenCalledTimes(2);
    expect(h.reviews.runDue).toHaveBeenCalledWith({ maxJobs: 3 });
    expect(order).toEqual(["review", "inbound", "inbound", "review"]);
  });

  it("keeps draining when one event throws, and leaves that event to its lease", async () => {
    const h = harness();
    h.inbound.seedEvent();
    h.inbound.seedEvent();
    h.process.mockRejectedValueOnce(new Error("boom"));

    const result = await h.worker.drain({ maxJobs: 5, stage: "inbound" });

    expect(result).toMatchObject({ claimed: 2, processed: 1, errored: 1 });
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ eventId: expect.any(String), errorName: "Error" }), "email_inbound_event_errored");
  });

  it("does nothing while disabled", async () => {
    vi.useFakeTimers();
    const h = harness({ enabled: false });
    h.inbound.seedEvent();
    const claim = vi.spyOn(h.inbound, "claimDueEvents");

    h.worker.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.worker.running).toBe(false);
    expect(await h.worker.drain({ maxJobs: 5, stage: "all" })).toMatchObject({ claimed: 0 });
    expect(await h.worker.sweep({ maxJobs: 5 })).toBeNull();
    expect(claim).not.toHaveBeenCalled();
    expect(h.domains.refreshDue).not.toHaveBeenCalled();
  });

  it("drains after sweeping, so recovered and lost work runs at once", async () => {
    const h = harness();
    const stuck = h.inbound.seedEvent({ state: "processing", attempts: 1, leaseUntil: new Date(START.getTime() - 1) });

    const result = await h.worker.sweep({ maxJobs: 10 });

    expect(result).toMatchObject({ recoveredLeases: 1, drained: 1 });
    expect(h.process).toHaveBeenCalledWith(expect.objectContaining({ id: stuck.id, attempts: 2 }));
  });
});

describe("EmailChannelSweep", () => {
  it("returns events whose lease ran out to pending, due now", async () => {
    const h = harness();
    const stuck = h.inbound.seedEvent({ state: "processing", attempts: 1, leaseUntil: new Date(START.getTime() - 1) });
    const working = h.inbound.seedEvent({ state: "processing", attempts: 1, leaseUntil: new Date(START.getTime() + 60_000) });

    const result = await h.sweep.run({ maxJobs: 10 });

    expect(result.recoveredLeases).toBe(1);
    expect(h.inbound.events.get(stuck.id)).toMatchObject({ state: "pending", leaseUntil: null });
    expect(h.inbound.events.get(working.id)?.state).toBe("processing");
    expect(h.logger.warn).toHaveBeenCalledWith({ recoveredLeases: 1 }, "email_inbound_leases_recovered");
  });

  it("refreshes due domain readiness and cleans up removed domains", async () => {
    const h = harness();

    const result = await h.sweep.run({ maxJobs: 7 });

    expect(h.domains.refreshDue).toHaveBeenCalledWith(7);
    expect(h.domains.cleanupRemoved).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ refreshedDomains: 2, cleanedDomains: 1 });
  });

  it("claims and reconciles the sends due a re-POST or a lookup", async () => {
    const h = harness();
    h.sends.run.mockResolvedValueOnce({ claimed: 3, reposted: 1, settled: 1, uncertain: 1, deferred: 0, skipped: 0, errored: 0 });

    const result = await h.sweep.run({ maxJobs: 7 });

    expect(h.sends.run).toHaveBeenCalledWith({ maxJobs: 7 });
    expect(result.reconciledSends).toBe(3);
  });

  it("purges conversation-less deliveries and settled events past the retention window", async () => {
    const h = harness();
    const old = h.inbound.seedEvent({ state: "processed" });
    const { deliveryId: oldDelivery } = await h.inbound.insertDelivery({
      inboundEventId: old.id,
      workspaceId: null,
      mailboxId: null,
      routeRule: null,
      acceptedPolicyVersion: null,
      settled: { disposition: "drop", dispositionReason: "no_mailbox" },
    });
    const attachedEvent = h.inbound.seedEvent({ state: "processed" });
    const { deliveryId: attached } = await h.inbound.insertDelivery({
      inboundEventId: attachedEvent.id,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      mailboxId: "22222222-2222-4222-8222-222222222222",
      routeRule: "relay",
      acceptedPolicyVersion: 1,
    });
    h.inbound.deliveries.set(attached, { ...h.inbound.deliveries.get(attached)!, conversationId: "33333333-3333-4333-8333-333333333333" });

    h.advance(31 * DAY_MS);
    const result = await h.sweep.run({ maxJobs: 10 });

    expect(result).toMatchObject({ purgedDeliveries: 1, purgedEvents: 1 });
    expect(h.inbound.deliveries.has(oldDelivery)).toBe(false);
    expect(h.inbound.events.has(old.id)).toBe(false);
    expect(h.inbound.deliveries.has(attached)).toBe(true);
  });

  it("keeps recent unattached deliveries", async () => {
    const h = harness();
    const recent = h.inbound.seedEvent({ state: "processed" });
    await h.inbound.insertDelivery({
      inboundEventId: recent.id,
      workspaceId: null,
      mailboxId: null,
      routeRule: null,
      acceptedPolicyVersion: null,
      settled: { disposition: "drop", dispositionReason: "no_mailbox" },
    });

    h.advance(29 * DAY_MS);
    const result = await h.sweep.run({ maxJobs: 10 });

    expect(result).toMatchObject({ purgedDeliveries: 0, purgedEvents: 0 });
  });
});

describe("EmailChannelSweep, where the deployment does not run auto (plan, Rollout and Rollback)", () => {
  const QUEUED = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];

  const rollbackHarness = () => {
    const h = harness();
    const queued = { listQueuedAutoBefore: vi.fn(async (_input: { policyRefPrefix: string; before: Date; limit: number }) => QUEUED) };
    const dispatch = {
      materializeAuto: vi.fn(async (heldReplyId: string) => (heldReplyId === QUEUED[1]
        ? { ok: false as const, reason: "not_queued" as const }
        : { ok: false as const, reason: "returned_to_pending" as const })),
    };
    const sweep = new EmailChannelSweep({
      inbound: h.inbound,
      domains: h.domains,
      sends: h.sends,
      clock: () => START,
      logger: h.logger,
      config: { eventRetentionDays: 30 },
      abandonedAutoSends: noAbandonedAutoSends(),
      queuedAutoRollback: { queued, dispatch },
    });
    return { ...h, sweep, queued, dispatch };
  };

  it("returns automatic sends still queued past the action lease to a teammate, through dispatch's authorization", async () => {
    const h = rollbackHarness();

    const result = await h.sweep.run({ maxJobs: 10 });

    expect(h.queued.listQueuedAutoBefore).toHaveBeenCalledWith({
      policyRefPrefix: "email_mailbox:",
      before: new Date(START.getTime() - 5 * 60 * 1000),
      limit: 10,
    });
    expect(h.dispatch.materializeAuto.mock.calls.map(([id]) => id)).toEqual(QUEUED);
    // One was settled by its own dispatch meanwhile; the others went back to pending.
    expect(result.returnedQueuedAutoSends).toBe(2);
    expect(h.logger.warn).toHaveBeenCalledWith({ returnedQueuedAutoSends: 2 }, "email_queued_auto_sends_returned");
  });

  it("returns nothing where the deployment runs auto, since no rollback step is composed", async () => {
    const h = harness();

    expect((await h.sweep.run({ maxJobs: 10 })).returnedQueuedAutoSends).toBe(0);
  });
});

describe("EmailChannelSweep, automatic sends whose outbox action gave up before they were materialized (research B9)", () => {
  const QUEUED = ["bbbbbbbb-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002", "bbbbbbbb-0000-4000-8000-000000000003"];

  const abandonedHarness = () => {
    const h = harness();
    const abandoned = noAbandonedAutoSends();
    abandoned.queued.listQueuedAutoBefore.mockResolvedValue(QUEUED);
    // The first is still being dispatched; the third went back to a teammate meanwhile.
    abandoned.outbox.liveIdempotencyKeys.mockResolvedValue(new Set([emailSendKey.heldReply(QUEUED[0])]));
    abandoned.dispatch.returnAbandonedAuto.mockImplementation(async (heldReplyId: string) => heldReplyId !== QUEUED[2]);
    const sweep = new EmailChannelSweep({
      inbound: h.inbound,
      domains: h.domains,
      sends: h.sends,
      clock: () => START,
      logger: h.logger,
      config: { eventRetentionDays: 30 },
      abandonedAutoSends: abandoned,
    });
    return { ...h, sweep, abandoned };
  };

  it("returns queued sends past the action lease with no live outbox action to a teammate, and leaves live ones to their dispatch", async () => {
    const h = abandonedHarness();

    const result = await h.sweep.run({ maxJobs: 10 });

    expect(h.abandoned.queued.listQueuedAutoBefore).toHaveBeenCalledWith({
      policyRefPrefix: "email_mailbox:",
      before: new Date(START.getTime() - 5 * 60 * 1000),
      limit: 10,
    });
    expect(h.abandoned.outbox.liveIdempotencyKeys).toHaveBeenCalledWith(QUEUED.map((id) => emailSendKey.heldReply(id)));
    expect(h.abandoned.dispatch.returnAbandonedAuto.mock.calls.map(([id]) => id)).toEqual([QUEUED[1], QUEUED[2]]);
    expect(result.returnedAbandonedAutoSends).toBe(1);
    expect(h.logger.warn).toHaveBeenCalledWith({ returnedAbandonedAutoSends: 1 }, "email_abandoned_auto_sends_returned");
  });

  it("keeps sweeping when one return fails, and looks no further when nothing is queued", async () => {
    const h = abandonedHarness();
    h.abandoned.dispatch.returnAbandonedAuto.mockRejectedValueOnce(new Error("connection reset"));

    expect((await h.sweep.run({ maxJobs: 10 })).returnedAbandonedAutoSends).toBe(0);
    expect(h.abandoned.dispatch.returnAbandonedAuto).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).toHaveBeenCalledWith({ heldReplyId: QUEUED[1], errorName: "Error" }, "email_abandoned_auto_send_return_failed");

    const idle = harness();
    expect((await idle.sweep.run({ maxJobs: 10 })).returnedAbandonedAutoSends).toBe(0);
    expect(idle.abandonedAutoSends.outbox.liveIdempotencyKeys).not.toHaveBeenCalled();
  });
});
