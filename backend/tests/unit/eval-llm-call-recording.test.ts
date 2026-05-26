import { describe, expect, it } from "vitest";

import { ChatGatewayLlmJudge } from "../../src/modules/eval/services/evalJudge.js";
import { EvalUsageMeter } from "../../src/modules/eval/services/evalUsageMeter.js";
import { RetrievalPipelineEvalRunner } from "../../src/modules/eval/services/retrievalPipelineEvalRunner.js";
import type { LlmCapabilityResolver } from "../../src/shared/infra/llm/capabilityResolver.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";

const fixedPipelineResult = {
  rewrittenQuery: "q",
  contexts: [],
  systemPrompt: "you are a helpful assistant",
  prompt: "user asks: anything",
  citations: [],
  responseIdentity: null,
  responseSettings: {
    citationDisplayEnabled: true,
    suggestedQuestionsEnabled: false,
    suggestedQuestionsCount: 0,
  },
  diagnostics: {} as never,
  trace: {} as never,
};

const buildPipeline = () => ({
  async run() { return fixedPipelineResult; },
  async interpret() { return { request: {} as never, interpretation: { result: {} } }; },
  async runInterpreted() { return fixedPipelineResult; },
  async runWithoutRetrieval() { return fixedPipelineResult; },
});

const buildChatGateway = (answerText: string): ChatGateway => ({
  async answer() { return answerText; },
  async *streamAnswer() { yield answerText; },
});

const buildResolver = (): LlmCapabilityResolver => ({
  async resolve() {
    return { provider: "openai", model: "gpt-4o-mini", apiKey: "k", baseUrl: undefined } as any;
  },
});

const buildRecorder = () => {
  const events: ModelUsageEvent[] = [];
  const recorder: UsageEventRecorder = {
    async recordEmbedding() {},
    async recordModelCall(event) { events.push(event); },
  };
  return { recorder, events };
};

describe("eval LLM-call usage recording end-to-end", () => {
  it("records one usage event per full_assistant answer", async () => {
    const { recorder, events } = buildRecorder();
    const meter = new EvalUsageMeter(recorder, buildResolver());
    const runner = new RetrievalPipelineEvalRunner(
      buildPipeline() as never,
      buildChatGateway("the answer"),
      meter,
      buildResolver(),
    );

    const result = await runner.answer({
      workspaceId: "ws-1",
      accountId: "acc-1",
      runId: "run-1",
      query: "anything",
      history: [],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.surface).toBe("eval");
    expect(events[0]!.operation).toBe("full_assistant_answer");
    expect(events[0]!.status).toBe("succeeded");
    expect(events[0]!.workspaceId).toBe("ws-1");
    expect(events[0]!.accountId).toBe("acc-1");
    expect(events[0]!.provider).toBe("openai");
    expect(events[0]!.model).toBe("gpt-4o-mini");
    expect(result.resolvedModel).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("still records usage when the chat gateway throws", async () => {
    const { recorder, events } = buildRecorder();
    const meter = new EvalUsageMeter(recorder, buildResolver());
    const failingGateway: ChatGateway = {
      async answer() { throw new Error("rate limited"); },
      async *streamAnswer() {},
    };
    const runner = new RetrievalPipelineEvalRunner(
      buildPipeline() as never,
      failingGateway,
      meter,
      buildResolver(),
    );

    await expect(
      runner.answer({
        workspaceId: "ws-1",
        runId: "run-1",
        query: "anything",
        history: [],
      }),
    ).rejects.toThrow(/rate limited/);

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("failed");
    expect(events[0]!.errorCode).toContain("rate limited");
  });

  it("records one usage event per llm_judge call", async () => {
    const { recorder, events } = buildRecorder();
    const meter = new EvalUsageMeter(recorder, buildResolver());
    const judge = new ChatGatewayLlmJudge(
      buildChatGateway('{"verdict":"pass","reason":"ok"}'),
      meter,
    );

    const verdict = await judge.judge({
      workspaceId: "ws-1",
      accountId: "acc-1",
      runId: "run-1",
      assertionIndex: 2,
      assertion: { type: "llm_judge", expectedAnswer: "Refund window is 30 days." },
      observedAnswer: "Refunds are within 30 days.",
      question: "Refund policy?",
    });

    expect(verdict.status).toBe("pass");
    expect(events).toHaveLength(1);
    expect(events[0]!.operation).toBe("llm_judge");
    expect(events[0]!.idempotencyKey).toBe("eval:run:run-1:llm_judge:assertion-2");
  });
});
