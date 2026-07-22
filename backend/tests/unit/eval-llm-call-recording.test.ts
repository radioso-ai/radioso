import { describe, expect, it, vi } from "vitest";

import { ChatGatewayLlmJudge } from "../../src/modules/eval/services/evalJudge.js";
import { RetrievalPipelineEvalRunner } from "../../src/modules/eval/services/retrievalPipelineEvalRunner.js";
import { AnswerPresentationService } from "../../src/modules/chat/services/answerPresentationService.js";
import { createRetrievalSkillSettingsResolver } from "../../src/app/composition/skillSettingsResolver.js";
import type { LlmCapabilityResolver } from "../../src/shared/infra/llm/capabilityResolver.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import type { AgentSnapshot } from "../../src/modules/agents/public.js";
import type { RetrievalDefaultsProvider, RetrievalPipelineRequest } from "../../src/modules/retrieval/public.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
import { formatV2Envelope } from "../support/answerEnvelopeV2Fixtures.js";

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

const buildCapturingPipeline = () => {
  const calls: RetrievalPipelineRequest[] = [];
  return {
    calls,
    pipeline: {
      async run(input: RetrievalPipelineRequest) {
        calls.push(input);
        return fixedPipelineResult;
      },
      async interpret() { return { request: {} as never, interpretation: { result: {} } }; },
      async runInterpreted() { return fixedPipelineResult; },
      async runWithoutRetrieval() { return fixedPipelineResult; },
    },
  };
};

const buildChatGateway = (answerText: string): { gateway: ChatGateway; calls: ChatGatewayInput[] } => {
  const calls: ChatGatewayInput[] = [];
  return {
    calls,
    gateway: {
      async answer(input) {
        calls.push(input);
        return answerText;
      },
      async *streamAnswer(input) {
        calls.push(input);
        yield answerText;
      },
    },
  };
};

const buildResolver = (): LlmCapabilityResolver => ({
  async resolve() {
    return { provider: "openai", model: "gpt-4o-mini", apiKey: "k", baseUrl: undefined } as any;
  },
});

const buildDefaultsProvider = (): RetrievalDefaultsProvider => ({
  getDefaults(workspaceId: string): RetrievalSettingsRecord {
    return {
      ...defaultRetrievalSettings(workspaceId),
      queryRewriteEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      vectorTopK: 20,
      similarityThreshold: 0.2,
      rerankTopK: 5,
    };
  },
});

const buildAnswerPresentation = () => {
  const answerPresentationService = new AnswerPresentationService();
  return {
    present: answerPresentationService.present.bind(answerPresentationService),
  };
};

const buildAgentSnapshot = (overrides: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  agentId: "agent-1",
  name: "Support Bot",
  customInstruction: "",
  greetingInstruction: "",
  assistantDefaultLocale: null,
  retrievalEnabled: true,
  suggestedQuestionsEnabled: true,
  citationDisplayEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  chatModelOverride: null,
  ...overrides,
});

describe("eval LLM-call usage recording end-to-end", () => {
  it("replays per-agent retrieval skill settings and records the same resolved settings", async () => {
    const agentRule = {
      id: "audience-rule",
      field: "audience",
      valueType: "string",
      operator: "equals",
      value: "partner",
      conditions: [
        {
          id: "audience-condition",
          field: "audience",
          valueType: "string",
          operator: "equals",
          value: "partner",
        },
      ],
      effect: "filter",
      enabled: true,
      triggerMode: "match_turn",
      triggerInstruction: "Use for partner-specific questions",
    } as const;
    const agent = buildAgentSnapshot({
      skillSettings: {
        "retrieval.answer": {
          retrievalStrategy: "reasoning",
          suggestedQuestionsEnabled: false,
          suggestedQuestionsCount: 4,
          vectorTopK: 7,
          metadataRules: [agentRule],
        },
      },
    });
    const pipeline = buildCapturingPipeline();
    const legacyWorkspaceSettings = {
      getForWorkspace: vi.fn(async () => {
        throw new Error("workspace retrieval settings should not be consulted");
      }),
    };
    const runner = new RetrievalPipelineEvalRunner(
      pipeline.pipeline,
      buildChatGateway("unused").gateway,
      buildResolver(),
      buildDefaultsProvider(),
      buildAnswerPresentation(),
      createRetrievalSkillSettingsResolver(),
    );

    const result = await runner.retrieve({
      workspaceId: "ws-1",
      query: "partner policy",
      history: [],
      context: { agent },
    });

    expect(pipeline.calls[0]?.agentSkillSettings).toBe(agent.skillSettings);
    expect(pipeline.calls[0]?.responseBehavior).not.toHaveProperty("suggestedQuestionsEnabled");
    expect(pipeline.calls[0]?.responseBehavior).not.toHaveProperty("suggestedQuestionsCount");
    expect(result.resolvedSettings).toMatchObject({
      retrievalStrategy: "reasoning",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 4,
      vectorTopK: 7,
      metadataRules: [expect.objectContaining({ id: "audience-rule", triggerMode: "match_turn" })],
    });
    expect(legacyWorkspaceSettings.getForWorkspace).not.toHaveBeenCalled();
  });

  it("records system defaults, agent overrides, then per-eval overrides in order", async () => {
    const runner = new RetrievalPipelineEvalRunner(
      buildPipeline() as never,
      buildChatGateway("unused").gateway,
      buildResolver(),
      buildDefaultsProvider(),
      buildAnswerPresentation(),
      createRetrievalSkillSettingsResolver(),
    );

    const result = await runner.retrieve({
      workspaceId: "ws-1",
      query: "partner policy",
      history: [],
      context: {
        agent: buildAgentSnapshot({
          skillSettings: {
            "retrieval.answer": {
              vectorTopK: 7,
              suggestedQuestionsEnabled: false,
            },
          },
        }),
      },
      retrievalSettingsOverride: {
        vectorTopK: 11,
      },
    });

    expect(result.resolvedSettings).toMatchObject({
      queryRewriteEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 3,
      vectorTopK: 11,
    });
  });

  it("threads eval usage context through the full_assistant answer gateway call", async () => {
    const chat = buildChatGateway("the answer");
    const runner = new RetrievalPipelineEvalRunner(
      buildPipeline() as never,
      chat.gateway,
      buildResolver(),
      buildDefaultsProvider(),
      buildAnswerPresentation(),
    );

    const result = await runner.answer({
      workspaceId: "ws-1",
      accountId: "acc-1",
      runId: "run-1",
      query: "anything",
      history: [],
    });

    expect(chat.calls[0]!.usageContext).toEqual({
      accountId: "acc-1",
      workspaceId: "ws-1",
      requestId: "run-1",
      surface: "eval",
      operation: "full_assistant",
      attemptKey: "answer",
    });
    expect(result.resolvedModel).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("normalizes generated citation anchors into eval answer artifacts", async () => {
    const context = {
      chunkId: "chunk-1",
      documentId: "doc-1",
      title: "Source guide",
      content: "Refunds are available within 30 days.",
      similarity: 0.9,
      metadata: { sourceUrl: "https://example.com/refunds" },
      retrievalSources: ["semantic_original"],
      retrievalText: "Refunds are available within 30 days.",
      semanticScore: 0.9,
      lexicalScore: 0,
      relevanceScore: 0.9,
      rerankPosition: 0,
      promptPosition: 0,
      estimatedTokenCost: 12,
    };
    const pipelineResult = {
      ...fixedPipelineResult,
      contexts: [context],
    };
    const chat = buildChatGateway(formatV2Envelope("Refunds are available within 30 days[[1]].", {
      v: 2,
      outcome: "answer",
      claims: [[1]],
      suggestions: [],
      grounding: "degraded",
    }));
    const runner = new RetrievalPipelineEvalRunner(
      {
        async run() { return pipelineResult as never; },
        async interpret() { return { request: {} as never, interpretation: { result: {} } }; },
        async runInterpreted() { return pipelineResult as never; },
        async runWithoutRetrieval() { return pipelineResult as never; },
      },
      chat.gateway,
      buildResolver(),
      buildDefaultsProvider(),
      buildAnswerPresentation(),
    );

    const result = await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "refunds?",
      history: [],
    });

    expect(result.answer).toBe("Refunds are available within 30 days.");
    expect(result.citations).toEqual([
      {
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "Source guide",
        sourceUrl: "https://example.com/refunds",
      },
    ]);
    expect(result.answerSegments).toEqual([
      { text: "Refunds are available within 30 days", citationIndices: [0] },
      { text: "." },
    ]);
    expect(result.groundingSummary).toMatchObject({ verdict: "grounded", parseStatus: "valid_v2" });
    expect(chat.calls[0]!.systemPrompt).toContain("Return exactly the JSON object required by the provider response schema");
    expect(chat.calls[0]!.generation?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "grounded_answer_envelope",
      strict: true,
    });
    expect(chat.calls[0]!.systemPrompt).not.toContain("Suggestion quality");
  });

  it("propagates chat gateway failures after passing eval usage context", async () => {
    const calls: ChatGatewayInput[] = [];
    const failingGateway: ChatGateway = {
      async answer(input) {
        calls.push(input);
        throw new Error("rate limited");
      },
      async *streamAnswer() {},
    };
    const runner = new RetrievalPipelineEvalRunner(
      buildPipeline() as never,
      failingGateway,
      buildResolver(),
      buildDefaultsProvider(),
      buildAnswerPresentation(),
    );

    await expect(
      runner.answer({
        workspaceId: "ws-1",
        runId: "run-1",
        query: "anything",
        history: [],
      }),
    ).rejects.toThrow(/rate limited/);

    expect(calls[0]!.usageContext.operation).toBe("full_assistant");
  });

  it("treats a blank generated envelope body as a generation failure", async () => {
    const runner = new RetrievalPipelineEvalRunner(
      buildPipeline() as never,
      buildChatGateway("   ").gateway,
      buildResolver(),
      buildDefaultsProvider(),
      buildAnswerPresentation(),
    );

    await expect(runner.answer({
      workspaceId: "ws-1",
      runId: "run-blank",
      query: "anything",
      history: [],
    })).rejects.toMatchObject({ name: "BlankChatAnswerError" });
  });

  it("threads eval usage context through the llm_judge gateway call", async () => {
    const chat = buildChatGateway('{"verdict":"pass","reason":"ok"}');
    const judge = new ChatGatewayLlmJudge(chat.gateway);

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
    expect(chat.calls[0]!.usageContext).toEqual({
      accountId: "acc-1",
      workspaceId: "ws-1",
      requestId: "run-1",
      surface: "eval",
      operation: "llm_judge",
      attemptKey: "assertion-2",
    });
  });
});
