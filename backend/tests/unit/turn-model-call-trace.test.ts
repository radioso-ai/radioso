import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import {
  captureModelCallTrace,
} from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import {
  attachModelCallsToSpine,
} from "../../src/modules/chat/services/turnTraceModelCalls.js";

const at = (offsetMs: number): string => new Date(Date.parse("2026-07-18T10:00:00.000Z") + offsetMs).toISOString();

describe("model call trace capture", () => {
  it("excludes durable usage-recording latency from provider call duration", async () => {
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete: vi.fn(async () => {
        clock = 1_075;
        return {
          text: "answer",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, quality: "actual" as const },
        };
      }),
      stream: vi.fn(),
    }, {
      recordEmbedding: vi.fn(),
      recordModelCall: vi.fn(async () => {
        clock = 1_300;
      }),
    });

    const captured = await captureModelCallTrace(() => inference.complete({
      operation: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation: "direct_answer",
        attemptKey: "answer-1",
      },
      prompt: "private",
    }));

    expect(captured.calls[0]?.durationMs).toBe(75);
    expect(captured.calls[0]?.completedAt).toBe(new Date(1_075).toISOString());
    now.mockRestore();
  });

  it("captures sanitized provider timing and token usage from the inference seam", async () => {
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_075);
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete: vi.fn(async () => ({
        text: "private completion",
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19, quality: "actual" as const },
      })),
      stream: vi.fn(),
    });

    const captured = await captureModelCallTrace(() => inference.complete({
      operation: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation: "turn_interpretation",
        attemptKey: "message-1",
      },
      prompt: "private prompt",
    }));

    expect(captured.result.text).toBe("private completion");
    expect(captured.calls).toEqual([{
      operation: "turn_interpretation",
      attemptKey: "message-1",
      provider: "openai",
      model: "gpt-test",
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(1_075).toISOString(),
      durationMs: 75,
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
      status: "succeeded",
    }]);
    expect(JSON.stringify(captured.calls)).not.toContain("private prompt");
    expect(JSON.stringify(captured.calls)).not.toContain("private completion");
    now.mockRestore();
  });
});

describe("attachModelCallsToSpine", () => {
  it("attaches calls to their enclosing host stage and aggregates numeric metrics", () => {
    const spine: ConversationTrace = {
      traceId: "turn-1",
      startedAt: at(0),
      completedAt: at(500),
      stages: [
        {
          id: "turn_interpretation",
          kind: "turn_interpretation",
          status: "applied",
          startedAt: at(10),
          completedAt: at(80),
        },
        {
          id: "retrieval_fanout",
          kind: "retrieval_fanout",
          status: "applied",
          startedAt: at(80),
          completedAt: at(200),
        },
        {
          id: "compose",
          kind: "compose",
          status: "applied",
          startedAt: at(220),
          completedAt: at(480),
          outputs: { answerLength: 20 },
        },
      ],
    };
    const result = attachModelCallsToSpine(spine, [
      {
        operation: "turn_interpretation",
        attemptKey: "route",
        provider: "openai",
        model: "gpt-route",
        startedAt: at(20),
        completedAt: at(70),
        durationMs: 50,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        status: "succeeded",
      },
      {
        operation: "query_rewrite",
        attemptKey: "rewrite",
        provider: "openai",
        model: "gpt-rewrite",
        startedAt: at(100),
        completedAt: at(150),
        durationMs: 50,
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
        status: "succeeded",
      },
      {
        operation: "grounded",
        attemptKey: "answer-1",
        provider: "openai",
        model: "gpt-answer",
        startedAt: at(230),
        completedAt: at(400),
        durationMs: 170,
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
        status: "succeeded",
      },
      {
        operation: "grounded_unsupported",
        attemptKey: "answer-2",
        provider: "openai",
        model: "gpt-answer",
        startedAt: at(405),
        completedAt: at(470),
        durationMs: 65,
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        status: "succeeded",
      },
    ]);

    expect(result.stages.find((stage) => stage.kind === "turn_interpretation")).toMatchObject({
      inputs: { operation: "turn_interpretation", model: "gpt-route" },
      metrics: { llmCallCount: 1, latencyMs: 50, inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    const compose = result.stages.find((stage) => stage.kind === "compose");
    expect(compose).toMatchObject({
      outputs: { answerLength: 20, modelCalls: expect.any(Array) },
      inputs: { model: "gpt-answer" },
      metrics: { llmCallCount: 2, latencyMs: 235, inputTokens: 120, outputTokens: 38, totalTokens: 158 },
    });
    expect((compose?.outputs?.modelCalls as unknown[])).toHaveLength(2);
    // Retrieval owns these calls in its typed leaf; do not duplicate them on the root spine.
    expect(result.stages.find((stage) => stage.kind === "retrieval_fanout")?.outputs?.modelCalls).toBeUndefined();
    expect(spine.stages.find((stage) => stage.kind === "compose")?.outputs?.modelCalls).toBeUndefined();
  });
});
