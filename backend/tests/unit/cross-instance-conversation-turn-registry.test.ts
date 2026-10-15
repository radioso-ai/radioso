import { describe, expect, it, vi } from "vitest";

import {
  CrossInstanceConversationTurnRegistry,
  type ConversationTurnLeaseStore,
  type ConversationTurnNoticeSource,
} from "../../src/modules/chat/services/crossInstanceConversationTurnRegistry.js";

// The registry's behaviour against Postgres, across processes, is covered by
// tests/integration/conversation-turn-registry.integration.test.ts; these cover how it degrades
// when the lease store fails.

const leaseStore = (overrides: Partial<ConversationTurnLeaseStore> = {}): ConversationTurnLeaseStore => {
  let nextTurnId = 1;
  return {
    begin: vi.fn(async () => ({ turnId: String(nextTurnId++), predecessorTurnId: null, predecessorExpired: false })),
    end: vi.fn(async () => undefined),
    renew: vi.fn(async () => []),
    leaseStates: vi.fn(async () => new Map()),
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
