import { describe, expect, it, vi } from "vitest";

import { ChatTurnLeaseLostError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import {
  CrossInstanceConversationTurnRegistry,
  type ConversationTurnLeaseStore,
  type ConversationTurnNoticeSource,
} from "../../src/modules/chat/services/crossInstanceConversationTurnRegistry.js";

// The registry's behaviour against Postgres, across processes, is covered by
// tests/integration/conversation-turn-registry.integration.test.ts; these cover how it degrades
// when the lease store fails or answers late.

type NoticeHandlers = Parameters<ConversationTurnNoticeSource["subscribe"]>[0];

const leaseStore = (overrides: Partial<ConversationTurnLeaseStore> = {}): ConversationTurnLeaseStore => {
  let nextTurnId = 1;
  return {
    begin: vi.fn(async () => ({ turnId: String(nextTurnId++), remoteAhead: false, expiredAhead: false })),
    end: vi.fn(async () => undefined),
    renew: vi.fn(async () => []),
    pruneExpired: vi.fn(async () => undefined),
    aheadOf: vi.fn(async () => new Map()),
    successorsOf: vi.fn(async () => []),
    ...overrides,
  };
};

const listeningNotices = (): ConversationTurnNoticeSource => ({
  subscribe(handlers) {
    queueMicrotask(() => handlers.listening());
    return () => undefined;
  },
});

describe("CrossInstanceConversationTurnRegistry when the lease store fails", () => {
  it("fails the turn's wait when its lease cannot be recorded, and ends nothing on completion", async () => {
    const failure = new Error("connection refused");
    const leases = leaseStore({ begin: vi.fn(async () => Promise.reject(failure)) });
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases,
      notices: listeningNotices(),
    });

    const lease = registry.start("conversation-1");

    await expect(lease.waitForPredecessor()).rejects.toBe(failure);
    lease.complete();
    expect(leases.end).not.toHaveBeenCalled();
    registry.close();
  });

  it("retries recording a turn's end, then reports a safe warning once it gives up", async () => {
    const logger = { warn: vi.fn() };
    const end = vi.fn(async () => Promise.reject(new Error("timeout")));
    const leases = leaseStore({ end });
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases,
      notices: listeningNotices(),
      logger,
    });

    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();
    lease.complete();

    await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(3), { timeout: 3_000 });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      { event: "conversation_turn_lease_end_failed", errorType: "Error" },
      "Conversation turn coordination degraded",
    ));
    registry.close();
  });

  it("stops retrying once the turn's end lands", async () => {
    const end = vi.fn<ConversationTurnLeaseStore["end"]>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ end }),
      notices: listeningNotices(),
      logger,
    });

    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();
    lease.complete();

    await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(end).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    registry.close();
  });
});

describe("CrossInstanceConversationTurnRegistry catching up after its notice connection returns", () => {
  const controllableNotices = () => {
    let current: NoticeHandlers | undefined;
    const source: ConversationTurnNoticeSource = {
      subscribe(handlers) {
        current = handlers;
        queueMicrotask(() => handlers.listening());
        return () => undefined;
      },
    };
    return {
      source,
      reconnect() {
        current?.interrupted();
        current?.listening();
      },
    };
  };
  const successorOf = (turn: { turnId: string; conversationId: string }) => ({
    conversationId: turn.conversationId,
    turnId: String(Number(turn.turnId) + 1),
    supersedeAfterEmission: false,
    ownerInstanceId: "instance-2",
  });

  it("retries a failed catch-up until the lease store answers, then applies the newer turn it missed", async () => {
    const notices = controllableNotices();
    const successorsOf = vi.fn<ConversationTurnLeaseStore["successorsOf"]>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockImplementation(async (turns) => turns.map(successorOf));
    const turnCancelled = vi.fn();
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ successorsOf }),
      notices: notices.source,
      observer: { turnCancelled },
      timings: { catchUpRetryInitialMs: 10 },
    });
    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();
    lease.setStage("routing");

    notices.reconnect();

    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    expect(successorsOf).toHaveBeenCalledTimes(2);
    expect(turnCancelled).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      reason: "superseded",
      stage: "routing",
      scope: "cross_instance",
    });
    lease.complete();
    registry.close();
  });

  it("stops retrying once no turn of its own is left in flight", async () => {
    const notices = controllableNotices();
    const successorsOf = vi.fn<ConversationTurnLeaseStore["successorsOf"]>(async () => Promise.reject(new Error("down")));
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ successorsOf }),
      notices: notices.source,
      timings: { catchUpRetryInitialMs: 10 },
    });
    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();

    notices.reconnect();
    await vi.waitFor(() => expect(successorsOf.mock.calls.length).toBeGreaterThanOrEqual(2));
    lease.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const callsAfterCompletion = successorsOf.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(successorsOf.mock.calls.length).toBe(callsAfterCompletion);
    registry.close();
  });
});

describe("CrossInstanceConversationTurnRegistry losing a lease", () => {
  it("aborts a turn whose lease the store no longer renews, and stops renewing it", async () => {
    const renew = vi.fn<ConversationTurnLeaseStore["renew"]>(async ({ turnIds }) => turnIds);
    const turnCancelled = vi.fn();
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ renew }),
      notices: listeningNotices(),
      observer: { turnCancelled },
      timings: { heartbeatIntervalMs: 20 },
    });
    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();
    lease.setStage("rendering");

    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));

    expect(() => lease.throwIfCancelled()).toThrowError(ChatTurnLeaseLostError);
    expect(turnCancelled).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      reason: "lease_lost",
      stage: "rendering",
      scope: "local",
    });
    const renewalsAtAbort = renew.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renew.mock.calls.length).toBe(renewalsAtAbort);
    lease.complete();
    registry.close();
  });

  it("sends one renewal at a time while the store is slow to answer", async () => {
    let answer!: (lost: string[]) => void;
    const renew = vi.fn<ConversationTurnLeaseStore["renew"]>(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ renew }),
      notices: listeningNotices(),
      timings: { heartbeatIntervalMs: 10 },
    });
    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();

    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(renew).toHaveBeenCalledOnce();

    answer([]);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
    lease.complete();
    registry.close();
  });
});

describe("CrossInstanceConversationTurnRegistry watching its own leases", () => {
  it("aborts a turn whose renewals hang, once its lease would have expired", async () => {
    const turnCancelled = vi.fn();
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ renew: vi.fn(() => new Promise<string[]>(() => undefined)) }),
      notices: listeningNotices(),
      observer: { turnCancelled },
      timings: { leaseTtlMs: 200, heartbeatIntervalMs: 50 },
    });
    const startedAt = performance.now();
    const lease = registry.start("conversation-1");
    let abortedAt = Number.POSITIVE_INFINITY;
    lease.signal.addEventListener("abort", () => {
      abortedAt = performance.now();
    });
    await lease.waitForPredecessor();
    lease.setStage("rendering");

    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));

    // Before the lease would expire in the store, measured from when its grant was requested.
    expect(abortedAt - startedAt).toBeLessThan(200);
    expect(() => lease.throwIfCancelled()).toThrowError(ChatTurnLeaseLostError);
    expect(turnCancelled).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      reason: "lease_lost",
      stage: "rendering",
      scope: "local",
    });
    lease.complete();
    registry.close();
  });

  it("refuses the commit latch once the lease would have expired, even before its timer has run", async () => {
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore({ renew: vi.fn(() => new Promise<string[]>(() => undefined)) }),
      notices: listeningNotices(),
      timings: { leaseTtlMs: 100, heartbeatIntervalMs: 1_000 },
    });
    const lease = registry.start("conversation-1", { supersedeAfterEmission: true });
    await lease.waitForPredecessor();
    lease.beginEmission();

    // A blocked event loop: no timer runs until this returns.
    const blockedUntil = performance.now() + 150;
    while (performance.now() < blockedUntil) {
      // Spin.
    }

    expect(() => lease.beginCommit()).toThrowError(ChatTurnLeaseLostError);
    lease.complete();
    registry.close();
  });

  it("keeps a turn whose renewals succeed", async () => {
    const registry = new CrossInstanceConversationTurnRegistry({
      instanceId: "instance-1",
      leases: leaseStore(),
      notices: listeningNotices(),
      timings: { leaseTtlMs: 200, heartbeatIntervalMs: 40 },
    });
    const lease = registry.start("conversation-1");
    await lease.waitForPredecessor();

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(lease.signal.aborted).toBe(false);
    expect(() => lease.beginCommit()).not.toThrow();
    lease.complete();
    registry.close();
  });
});
