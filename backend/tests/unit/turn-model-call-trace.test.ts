import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import {
  MAX_MODEL_CALL_TRACE_RECORDS,
  captureModelCallTrace,
  createModelCallTraceCollector,
  runAsyncIterableWithModelCallTrace,
  runWithModelCallTrace,
} from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import {
  attachModelCallsToSpine,
} from "../../src/modules/chat/services/turnTraceModelCalls.js";

const at = (offsetMs: number): string => new Date(Date.parse("2026-07-18T10:00:00.000Z") + offsetMs).toISOString();

describe("model call trace capture", () => {
  it("keeps two interleaved collectors isolated and safely ignores calls outside a collector", async () => {
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete: vi.fn(async ({ prompt }) => ({
        text: prompt,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, quality: "actual" as const },
      })),
      stream: vi.fn(),
    });
    const first = createModelCallTraceCollector();
    const second = createModelCallTraceCollector();
    const call = (operation: string) => inference.complete({
      operation: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation,
        attemptKey: `private-${operation}`,
      },
      prompt: operation,
    });

    await Promise.all([
      runWithModelCallTrace(first, async () => {
        await Promise.resolve();
        await call("turn_interpretation");
      }),
      runWithModelCallTrace(second, async () => {
        await Promise.resolve();
        await call("response_language_detection");
      }),
    ]);
    await call("outside_collector");

    expect(first.calls.map((record) => record.operation)).toEqual(["turn_interpretation"]);
    expect(second.calls.map((record) => record.operation)).toEqual(["response_language_detection"]);
    expect(first.totalCallCount).toBe(1);
    expect(second.totalCallCount).toBe(1);
  });

  it("records streaming usage that resolves after the last visible chunk", async () => {
    let resolveUsage!: (usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      quality: "actual";
    }) => void;
    const usage = new Promise<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      quality: "actual";
    }>((resolve) => {
      resolveUsage = resolve;
    });
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-stream" },
      complete: vi.fn(),
      stream: vi.fn(() => ({
        textStream: (async function* () {
          yield "visible";
        })(),
        usage,
      })),
    });
    const collector = createModelCallTraceCollector();
    const result = await inference.stream({
      operation: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation: "direct_answer",
        attemptKey: "private-stream-attempt",
      },
      prompt: "private prompt",
    });
    const iterator = runAsyncIterableWithModelCallTrace(collector, () => result.textStream)[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: "visible" });
    const terminal = iterator.next();
    await Promise.resolve();
    expect(collector.calls).toHaveLength(0);
    resolveUsage({ inputTokens: 4, outputTokens: 2, totalTokens: 6, quality: "actual" });
    expect(await terminal).toEqual({ done: true, value: undefined });
    expect(collector.calls).toEqual([
      expect.objectContaining({
        id: "model_call_1",
        operation: "direct_answer",
        model: "gpt-stream",
        inputTokens: 4,
        outputTokens: 2,
      }),
    ]);
  });

  it("caps persisted records while retaining aggregate counts and timings", async () => {
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete: vi.fn(async () => ({
        text: "answer",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, quality: "actual" as const },
      })),
      stream: vi.fn(),
    });
    const collector = createModelCallTraceCollector();

    await runWithModelCallTrace(collector, async () => {
      for (let index = 0; index < MAX_MODEL_CALL_TRACE_RECORDS + 3; index += 1) {
        await inference.complete({
          operation: {
            workspaceId: "workspace-1",
            surface: "assistant",
            operation: "direct_answer",
            attemptKey: `private-attempt-${index}`,
          },
          prompt: "private prompt",
        });
      }
    });

    expect(collector.calls).toHaveLength(MAX_MODEL_CALL_TRACE_RECORDS);
    expect(collector.totalCallCount).toBe(MAX_MODEL_CALL_TRACE_RECORDS + 3);
    expect(collector.droppedCallCount).toBe(3);
    expect(collector.totalModelTimeMs).toBe(MAX_MODEL_CALL_TRACE_RECORDS + 3);
    expect(JSON.stringify(collector.calls)).not.toContain("private-attempt");
    now.mockRestore();
  });

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
      .mockReturnValueOnce(900)
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
      id: "model_call_1",
      operation: "turn_interpretation",
      model: "gpt-test",
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(1_075).toISOString(),
      durationMs: 75,
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
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
        id: "model_call_1",
        operation: "turn_interpretation",
        model: "gpt-route",
        startedAt: at(20),
        completedAt: at(70),
        durationMs: 50,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
      {
        id: "model_call_2",
        operation: "query_rewrite",
        model: "gpt-rewrite",
        startedAt: at(100),
        completedAt: at(150),
        durationMs: 50,
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
      },
      {
        id: "model_call_3",
        operation: "grounded",
        model: "gpt-answer",
        startedAt: at(230),
        completedAt: at(400),
        durationMs: 170,
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
      },
      {
        id: "model_call_4",
        operation: "grounded_unsupported",
        model: "gpt-answer",
        startedAt: at(405),
        completedAt: at(470),
        durationMs: 65,
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
      },
    ]);

    expect(result.stages.find((stage) => stage.kind === "turn_interpretation")).toMatchObject({
      inputs: { operation: "turn_interpretation", model: "gpt-route" },
      metrics: { llmCallCount: 1, latencyMs: 50, inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    const compose = result.stages.find((stage) => stage.kind === "compose");
    expect(compose).toMatchObject({
      outputs: { answerLength: 20, modelCallIds: ["model_call_3", "model_call_4"] },
      inputs: { model: "gpt-answer" },
      metrics: { llmCallCount: 2, latencyMs: 235, inputTokens: 120, outputTokens: 38, totalTokens: 158 },
    });
    expect(result.stages.find((stage) => stage.kind === "retrieval_fanout")).toMatchObject({
      outputs: { modelCallIds: ["model_call_2"] },
      metrics: { llmCallCount: 1, latencyMs: 50 },
    });
    const modelCalls = result.stages.find((stage) => stage.kind === "model_calls");
    expect(modelCalls?.outputs?.modelCalls).toEqual([
      expect.objectContaining({ id: "model_call_1", stageId: "turn_interpretation" }),
      expect.objectContaining({ id: "model_call_2", stageId: "retrieval_fanout" }),
      expect.objectContaining({ id: "model_call_3", stageId: "compose" }),
      expect.objectContaining({ id: "model_call_4", stageId: "compose" }),
    ]);
    expect(JSON.stringify(modelCalls)).not.toContain("attemptKey");
    expect(spine.stages.find((stage) => stage.kind === "compose")?.outputs?.modelCalls).toBeUndefined();
  });

  it("marks classification stages as planned when a fused planner call is present", () => {
    const spine: ConversationTrace = {
      traceId: "turn-planned",
      startedAt: at(0),
      completedAt: at(100),
      stages: [
        { id: "turn_interpretation", kind: "turn_interpretation", status: "applied" },
        { id: "directives", kind: "directive_match", status: "skipped" },
      ],
    };
    const result = attachModelCallsToSpine(spine, [{
      id: "model_call_1",
      operation: "turn_planning",
      model: "gpt-planner",
      startedAt: at(1),
      completedAt: at(50),
      durationMs: 49,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }]);
    expect(result.stages.find((stage) => stage.kind === "turn_interpretation")?.outputs).toMatchObject({
      source: "planned",
    });
    expect(result.stages.find((stage) => stage.kind === "directive_match")?.outputs).toMatchObject({
      source: "planned",
    });
  });

  it("marks classification stages as staged when no fused planner call is present", () => {
    const spine: ConversationTrace = {
      traceId: "turn-staged",
      startedAt: at(0),
      completedAt: at(100),
      stages: [{ id: "turn_interpretation", kind: "turn_interpretation", status: "applied" }],
    };
    const result = attachModelCallsToSpine(spine, [{
      id: "model_call_1",
      operation: "turn_interpretation",
      model: "gpt-route",
      startedAt: at(1),
      completedAt: at(50),
      durationMs: 49,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }]);
    expect(result.stages[0]?.outputs).toMatchObject({ source: "staged" });
  });

  it("marks classification stages as staged when a failed planner is followed by staged calls", () => {
    const spine: ConversationTrace = {
      traceId: "turn-planner-fallback",
      startedAt: at(0),
      completedAt: at(100),
      stages: [
        { id: "turn_interpretation", kind: "turn_interpretation", status: "applied" },
        { id: "directives", kind: "directive_match", status: "applied" },
      ],
    };
    const result = attachModelCallsToSpine(spine, [
      {
        id: "model_call_1",
        operation: "turn_planning",
        model: "gpt-planner",
        startedAt: at(1),
        completedAt: at(20),
        durationMs: 19,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      {
        id: "model_call_2",
        operation: "turn_interpretation",
        model: "gpt-route",
        startedAt: at(21),
        completedAt: at(40),
        durationMs: 19,
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      },
      {
        id: "model_call_3",
        operation: "response_language_detection",
        model: "gpt-language",
        startedAt: at(41),
        completedAt: at(50),
        durationMs: 9,
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
      },
      {
        id: "model_call_4",
        operation: "directive_match",
        model: "gpt-directive",
        startedAt: at(51),
        completedAt: at(70),
        durationMs: 19,
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      },
    ]);

    expect(result.stages.find((stage) => stage.kind === "turn_interpretation")?.outputs).toMatchObject({
      source: "staged",
    });
    expect(result.stages.find((stage) => stage.kind === "directive_match")?.outputs).toMatchObject({
      source: "staged",
    });
  });

  it("marks classification stages as staged when failed planning falls back to the legacy router", () => {
    const spine: ConversationTrace = {
      traceId: "turn-planner-router-fallback",
      startedAt: at(0),
      completedAt: at(100),
      stages: [{ id: "turn_interpretation", kind: "turn_interpretation", status: "applied" }],
    };
    const result = attachModelCallsToSpine(spine, [
      {
        id: "model_call_1",
        operation: "turn_planning",
        model: "gpt-planner",
        startedAt: at(1),
        completedAt: at(20),
        durationMs: 19,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      {
        id: "model_call_2",
        operation: "turn_router",
        model: "gpt-router",
        startedAt: at(21),
        completedAt: at(40),
        durationMs: 19,
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      },
    ]);

    expect(result.stages[0]?.outputs).toMatchObject({ source: "staged" });
  });
});
