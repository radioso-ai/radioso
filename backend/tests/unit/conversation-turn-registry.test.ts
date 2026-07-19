import { describe, expect, it, vi } from "vitest";

import {
  ChatTurnSupersededError,
  InMemoryConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
} from "../../src/modules/chat/services/conversationTurnRegistry.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("InMemoryConversationTurnRegistry", () => {
  it("cancels an unlatched predecessor and holds its successor until cleanup completes", async () => {
    const cancelled = vi.fn();
    const registry = new InMemoryConversationTurnRegistry({ turnCancelled: cancelled });
    const first = registry.start("conversation-1");
    first.setStage("rendering");

    const second = registry.start("conversation-1");
    let successorReady = false;
    void second.waitForPredecessor().then(() => {
      successorReady = true;
    });

    expect(first.signal.aborted).toBe(true);
    expect(() => first.throwIfCancelled()).toThrowError(ChatTurnSupersededError);
    expect(successorReady).toBe(false);
    expect(cancelled).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      reason: "superseded",
      stage: "rendering",
    });

    first.complete();
    await second.waitForPredecessor();
    expect(successorReady).toBe(true);
  });

  it("does not cancel a predecessor after its emission latch is set", async () => {
    const cancelled = vi.fn();
    const registry = new InMemoryConversationTurnRegistry({ turnCancelled: cancelled });
    const first = registry.start("conversation-1");

    first.beginEmission();
    const second = registry.start("conversation-1");

    expect(first.signal.aborted).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();

    const waiting = deferred();
    void second.waitForPredecessor().then(waiting.resolve);
    await Promise.resolve();
    let ready = false;
    void waiting.promise.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    first.complete();
    await waiting.promise;
    expect(ready).toBe(true);
  });

  it("keeps newer registry ownership when an older turn completes", () => {
    const registry = new InMemoryConversationTurnRegistry();
    const first = registry.start("conversation-1");
    const second = registry.start("conversation-1");

    first.complete();
    const third = registry.start("conversation-1");

    expect(second.signal.aborted).toBe(true);
    expect(third.signal.aborted).toBe(false);
  });

  it("atomically refuses to latch a turn that was already cancelled", () => {
    const registry = new InMemoryConversationTurnRegistry();
    const first = registry.start("conversation-1");
    first.setStage("preparing");
    registry.start("conversation-1");

    expect(() => first.beginEmission()).toThrowError(
      expect.objectContaining({
        code: "chat_turn_superseded",
        details: {
          conversationId: "conversation-1",
          reason: "superseded",
          stage: "preparing",
        },
      }),
    );
  });

  it("records a safe structured log and a bounded cancellation counter", () => {
    const logger = { info: vi.fn() };
    const metrics = new MetricsRegistry();
    const observer = new LoggingConversationTurnInterruptionObserver(logger, metrics);

    observer.turnCancelled({
      conversationId: "conversation-1",
      reason: "superseded",
      stage: "routing",
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        conversationId: "conversation-1",
        event: "chat_turn_cancelled",
        reason: "superseded",
        stage: "routing",
      },
      "Chat turn cancelled",
    );
    expect(metrics.renderPrometheus()).toContain(
      'radioso_chat_turn_cancellations_total{reason="superseded",stage="routing"} 1',
    );
    expect(metrics.renderPrometheus()).not.toContain("conversation-1");
  });
});
