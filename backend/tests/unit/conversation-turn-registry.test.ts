import { describe, expect, it, vi } from "vitest";

import {
  InMemoryConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
} from "../../src/modules/chat/services/conversationTurnRegistry.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { describeConversationTurnRegistryContract } from "../support/conversationTurnRegistryContract.js";

describeConversationTurnRegistryContract("InMemoryConversationTurnRegistry", async (observer) => ({
  registry: new InMemoryConversationTurnRegistry(observer),
  settle: async () => undefined,
  close: async () => undefined,
}));

describe("InMemoryConversationTurnRegistry", () => {
  it("cancels its predecessor inside start, before any I/O", () => {
    const cancelled = vi.fn();
    const registry = new InMemoryConversationTurnRegistry({ turnCancelled: cancelled });
    const first = registry.start("conversation-1");

    registry.start("conversation-1");

    expect(first.signal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("LoggingConversationTurnInterruptionObserver", () => {
  it("records a safe structured log and a bounded cancellation counter", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const metrics = new MetricsRegistry();
    const observer = new LoggingConversationTurnInterruptionObserver(logger, metrics);

    observer.turnCancelled({
      conversationId: "conversation-1",
      reason: "superseded",
      stage: "routing",
      scope: "cross_instance",
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        conversationId: "conversation-1",
        event: "chat_turn_cancelled",
        reason: "superseded",
        stage: "routing",
        scope: "cross_instance",
      },
      "Chat turn cancelled",
    );
    expect(metrics.renderPrometheus()).toContain(
      'radioso_chat_turn_cancellations_total{reason="superseded",scope="cross_instance",stage="routing"} 1',
    );
    expect(metrics.renderPrometheus()).toContain(
      "# HELP radioso_chat_turn_cancellations_total Total assistant chat turns cancelled before completion.",
    );
    expect(metrics.renderPrometheus()).not.toContain("conversation-1");
  });

  it("warns and counts a turn that took over from a predecessor whose lease expired", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const metrics = new MetricsRegistry();
    const observer = new LoggingConversationTurnInterruptionObserver(logger, metrics);

    observer.predecessorLeaseExpired({ conversationId: "conversation-1" });

    expect(logger.warn).toHaveBeenCalledWith(
      { conversationId: "conversation-1", event: "chat_turn_lease_expiry_takeover" },
      "Chat turn stopped waiting for a predecessor whose lease expired",
    );
    expect(metrics.renderPrometheus()).toContain("radioso_chat_turn_lease_expiry_takeovers_total 1");
    expect(metrics.renderPrometheus()).not.toContain("conversation-1");
  });
});
