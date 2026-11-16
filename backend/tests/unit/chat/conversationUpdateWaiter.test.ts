import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresPublicConversationEventRelay } from "../../../src/modules/chat/infra/postgresPublicConversationEventRelay.js";
import { createConversationUpdateWaiter } from "../../../src/modules/chat/services/conversationUpdateWaiter.js";
import { CrossInstancePublicConversationEventBus } from "../../../src/modules/chat/services/crossInstancePublicConversationEventBus.js";
import { InMemoryPublicConversationEventBus } from "../../../src/modules/chat/services/publicConversationEventBus.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";
import { PostgresNotificationListener } from "../../../src/shared/infra/postgresNotificationListener.js";
import { fakeNotificationClients } from "../../support/fakeNotificationClient.js";

const messageCreated = (conversationId: string) => ({
  type: "message.created" as const,
  conversationId,
  workspaceId: "workspace-1",
  messageId: "message-1",
  createdAt: "2026-09-22T10:00:00.000Z",
});

describe("conversation update waiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes on a bus event without waiting for the next poll tick", async () => {
    const bus = new InMemoryPublicConversationEventBus();
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 2_000 });
    const controller = new AbortController();

    const pending = waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5);
    bus.publish(messageCreated("c-1"));

    await expect(pending).resolves.toBe("woken");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes the caller to re-query when the bus may have missed events", async () => {
    const unsubscribe = vi.fn();
    let reportMissed: (() => void) | undefined;
    const bus = {
      subscribe: vi.fn((_conversationId: string, _listener: unknown, onEventsMissed?: () => void) => {
        reportMissed = onEventsMissed;
        return unsubscribe;
      }),
    };
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 2_000 });
    const controller = new AbortController();

    const pending = waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5);
    reportMissed?.();

    await expect(pending).resolves.toBe("woken");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes on the poll tick with no bus event at all", async () => {
    // The tick is the backstop for an event the bus never delivers, such as one sent while this
    // instance's listener was reconnecting and before it reported the gap.
    const bus = new InMemoryPublicConversationEventBus();
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 2_000, jitter: () => 0 });
    const controller = new AbortController();

    const pending = waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toBe("woken");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves at the deadline when nothing happens", async () => {
    const bus = new InMemoryPublicConversationEventBus();
    // A poll interval past the deadline leaves the deadline as the only timer that fires.
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 60_000 });
    const controller = new AbortController();

    const pending = waiter.wait({ conversationId: "c-1", timeoutMs: 1_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("deadline");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears every timer and unsubscribes when the caller aborts", async () => {
    const unsubscribe = vi.fn();
    const bus = { subscribe: vi.fn().mockReturnValue(unsubscribe) };
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 2_000 });
    const controller = new AbortController();

    const pending = waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal: controller.signal });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.abort();

    await expect(pending).resolves.toBe("deadline");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately on a signal that is already aborted", async () => {
    const unsubscribe = vi.fn();
    const bus = { subscribe: vi.fn().mockReturnValue(unsubscribe) };
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 2_000 });

    await expect(waiter.wait({
      conversationId: "c-1",
      timeoutMs: 25_000,
      signal: AbortSignal.abort(),
    })).resolves.toBe("deadline");
    expect(bus.subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an event for another conversation", async () => {
    const bus = new InMemoryPublicConversationEventBus();
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 2_000, jitter: () => 0 });
    const controller = new AbortController();

    const pending = waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal: controller.signal });
    bus.publish(messageCreated("c-2"));
    await vi.advanceTimersByTimeAsync(1_500);
    const settled = await Promise.race([pending, Promise.resolve("pending" as const)]);

    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe("woken");
  });
});

describe("conversation update waiter over the cross-instance bus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The converse route reads, waits, and reads again on every wake. A wait that wakes at once with
  // nothing new turns that loop into a spin of database reads for the whole call.
  it("parks a caller whose instance already listens until something happens, instead of waking it at once", async () => {
    const transport = fakeNotificationClients();
    const listener = new PostgresNotificationListener({
      connectionString: "postgresql://listener.example/radioso",
      idleCloseMs: 0,
      createClient: transport.createClient,
    });
    const bus = new CrossInstancePublicConversationEventBus({
      instanceId: "instance-a",
      relay: new PostgresPublicConversationEventRelay({} as Db, listener),
    });
    // A poll tick past every deadline here, so only the bus can wake the caller.
    const waiter = createConversationUpdateWaiter({ bus, pollIntervalMs: 600_000 });
    const signal = new AbortController().signal;
    try {
      // The first wait opens the listener. Whatever another instance sent before its LISTEN took
      // effect went unheard, so the caller re-reads once.
      const first = waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal });
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toBe("woken");

      // The caller read and waits again on a session that already listens: nothing is missed, so
      // it stays parked.
      let outcome: string | null = null;
      void waiter.wait({ conversationId: "c-1", timeoutMs: 25_000, signal }).then((settled) => {
        outcome = settled;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toBeNull();

      // Another instance's event wakes it.
      transport.latest().notify("radioso_public_conversation_events", JSON.stringify({
        origin: "instance-b",
        ...messageCreated("c-1"),
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("woken");
      expect(transport.clients).toHaveLength(1);
    } finally {
      await listener.close();
    }
  });
});
