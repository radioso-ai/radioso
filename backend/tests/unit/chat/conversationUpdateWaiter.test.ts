import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConversationUpdateWaiter } from "../../../src/modules/chat/services/conversationUpdateWaiter.js";
import { InMemoryPublicConversationEventBus } from "../../../src/modules/chat/services/publicConversationEventBus.js";

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

  it("wakes on the poll tick with no bus event at all, which is the multi-instance case", async () => {
    // The bus is per-process: an operator reply handled by another instance never
    // reaches this listener, so the tick — not the subscription — is what makes the
    // wait correct.
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
