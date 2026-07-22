import { describe, expect, it, vi } from "vitest";

import { CHAT_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import { observeFirstAnswerChunkLatency } from "../../src/modules/chat/services/streamPerformanceMetrics.js";

const labels = { route: "retrieval", delivery_mode: "committed" } as const;

describe("observeFirstAnswerChunkLatency", () => {
  it("records the time-to-first-token histogram with the given route and delivery labels", () => {
    const observeHistogram = vi.fn();
    const incrementCounter = vi.fn();

    observeFirstAnswerChunkLatency({ observeHistogram, incrementCounter }, 120, labels);

    expect(observeHistogram).toHaveBeenCalledTimes(1);
    expect(observeHistogram).toHaveBeenCalledWith(
      "chat_stream_first_answer_chunk_latency_ms",
      expect.objectContaining({ labels, value: 120 }),
    );
  });

  it("does not flag a turn inside the perceived-performance budget", () => {
    const observeHistogram = vi.fn();
    const incrementCounter = vi.fn();
    const withinBudget = CHAT_BEHAVIOR.perceivedPerformance.firstTokenTargetMs - 1;

    observeFirstAnswerChunkLatency({ observeHistogram, incrementCounter }, withinBudget, labels);

    expect(incrementCounter).not.toHaveBeenCalled();
  });

  it("flags a turn that exceeds the perceived-performance budget, labeled by route", () => {
    const observeHistogram = vi.fn();
    const incrementCounter = vi.fn();
    const overBudget = CHAT_BEHAVIOR.perceivedPerformance.firstTokenTargetMs + 1;

    observeFirstAnswerChunkLatency({ observeHistogram, incrementCounter }, overBudget, labels);

    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(incrementCounter).toHaveBeenCalledWith(
      "chat_stream_ttft_budget_exceeded_total",
      expect.objectContaining({ labels }),
    );
  });

  it("tolerates a missing metrics sink", () => {
    expect(() =>
      observeFirstAnswerChunkLatency(null, CHAT_BEHAVIOR.perceivedPerformance.firstTokenTargetMs + 1, labels),
    ).not.toThrow();
  });
});
