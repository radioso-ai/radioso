import { describe, expect, it } from "vitest";

import {
  RetrievalPipelineEvalRunner,
  type EvalAnswerPresentationPort,
} from "../../src/modules/eval/services/retrievalPipelineEvalRunner.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import type { LlmCapabilityResolver } from "../../src/shared/infra/llm/capabilityResolver.js";
import type { RetrievalDefaultsProvider } from "../../src/modules/retrieval/public.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";

const SUMMARY = "The user already returned the item and is asking about the refund timeline.";

const pipelineResult = () => {
  const now = new Date().toISOString();
  return {
    rewrittenQuery: "how long do refunds take",
    contexts: [],
    systemPrompt: "BASE GROUNDED SYSTEM PROMPT",
    prompt: "GROUNDED PROMPT",
    citations: [],
    responseIdentity: null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      responseLanguagePolicy: "match_user_question" as const,
    },
    diagnostics: {},
    trace: { traceId: "t", startedAt: now, completedAt: now, totalDurationMs: 0, stages: [], links: [] },
  };
};

const buildRunner = () => {
  const captured: { systemPrompt?: string } = {};
  const pipeline = { run: async () => pipelineResult() } as unknown as ConstructorParameters<
    typeof RetrievalPipelineEvalRunner
  >[0];
  const chatGateway = {
    answer: async (input: { systemPrompt: string }) => {
      captured.systemPrompt = input.systemPrompt;
      return "Refunds are processed within five business days.";
    },
  } as unknown as ChatGateway;
  const capabilityResolver = {
    resolve: async () => ({ provider: "openai", model: "gpt-5-mini" }),
  } as unknown as LlmCapabilityResolver;
  const retrievalDefaultsProvider: RetrievalDefaultsProvider = {
    getDefaults: (workspaceId: string) => defaultRetrievalSettings(workspaceId),
  };
  const answerPresentation: EvalAnswerPresentationPort = {
    present: ({ answer }) => ({ answer, citations: [], answerSegments: [{ text: answer }] }),
  };
  const runner = new RetrievalPipelineEvalRunner(
    pipeline,
    chatGateway,
    capabilityResolver,
    retrievalDefaultsProvider,
    answerPresentation,
  );
  return { runner, captured };
};

describe("RetrievalPipelineEvalRunner conversation summary (#866)", () => {
  it("injects the frozen conversation summary into the composed grounded system prompt", async () => {
    const { runner, captured } = buildRunner();

    await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "How long do refunds take?",
      history: [],
      conversationSummary: SUMMARY,
    });

    expect(captured.systemPrompt).toContain(SUMMARY);
  });

  it("adds no summary section when the run carries none", async () => {
    const { runner, captured } = buildRunner();

    await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "How long do refunds take?",
      history: [],
    });

    expect(captured.systemPrompt).not.toContain(SUMMARY);
  });

  it("surfaces the frozen summary as a conversation_summary activity-trace stage", async () => {
    const { runner } = buildRunner();

    const result = await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "How long do refunds take?",
      history: [],
      conversationSummary: SUMMARY,
    });

    const stage = result.activityTrace.stages.find((s) => s.kind === "conversation_summary");
    expect(stage?.outputs?.summary).toBe(SUMMARY);
  });

  it("marks the conversation_summary stage skipped when the run carries no summary", async () => {
    const { runner } = buildRunner();

    const result = await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "How long do refunds take?",
      history: [],
    });

    const stage = result.activityTrace.stages.find((s) => s.kind === "conversation_summary");
    expect(stage?.status).toBe("skipped");
    expect(stage?.outputs?.summary).toBeUndefined();
  });
});
