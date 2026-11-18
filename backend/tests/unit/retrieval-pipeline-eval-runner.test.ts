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

const pipelineResult = (contexts: unknown[] = []) => {
  const now = new Date().toISOString();
  return {
    rewrittenQuery: "how long do refunds take",
    contexts,
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

const buildRunner = (options: { reply?: string; contexts?: unknown[] } = {}) => {
  const captured: { prompt?: string; systemPrompt?: string; presentedCitationCount?: number } = {};
  const pipeline = { run: async () => pipelineResult(options.contexts) } as unknown as ConstructorParameters<
    typeof RetrievalPipelineEvalRunner
  >[0];
  const chatGateway = {
    answer: async (input: { prompt: string; systemPrompt: string }) => {
      captured.prompt = input.prompt;
      captured.systemPrompt = input.systemPrompt;
      return options.reply ?? "Refunds are processed within five business days.";
    },
  } as unknown as ChatGateway;
  const capabilityResolver = {
    resolve: async () => ({ provider: "openai", model: "gpt-5-mini" }),
  } as unknown as LlmCapabilityResolver;
  const retrievalDefaultsProvider: RetrievalDefaultsProvider = {
    getDefaults: (workspaceId: string) => defaultRetrievalSettings(workspaceId),
  };
  const answerPresentation: EvalAnswerPresentationPort = {
    present: ({ answer, citations }) => {
      captured.presentedCitationCount = citations.length;
      return { answer, citations: [], answerSegments: [{ text: answer }] };
    },
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
  it("injects the frozen conversation summary as untrusted conversation data", async () => {
    const { runner, captured } = buildRunner();

    await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "How long do refunds take?",
      history: [],
      conversationSummary: SUMMARY,
    });

    expect(captured.systemPrompt).not.toContain(SUMMARY);
    expect(captured.prompt).toContain(SUMMARY);
  });

  it("bounds recent history repeated alongside a frozen summary", async () => {
    const { runner, captured } = buildRunner();
    const unboundedTurn = `history-marker-${"x".repeat(250_000)}`;

    await runner.answer({
      workspaceId: "ws-1",
      runId: "run-1",
      query: "How long do refunds take?",
      history: [{
        id: "message-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        role: "user",
        content: unboundedTurn,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
      conversationSummary: SUMMARY,
    });

    expect(captured.prompt).toContain("history-marker-");
    expect(captured.prompt).not.toContain(unboundedTurn);
    expect(captured.prompt?.length).toBeLessThan(5_000);
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

// #1823: the replay presents a decline the way chat does, naming no Result.
describe("RetrievalPipelineEvalRunner declines", () => {
  const refundContext = {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Refund policy",
    content: "Refunds are processed within five business days.",
  };
  const envelope = (outcome: "answer" | "no_support") => JSON.stringify({
    coverage: outcome === "answer" ? "answered_sufficient_evidence" : "unanswered_insufficient_evidence",
    requestFocus: "the refund timeline",
    outcome,
    answer: "The closest we have is the refund policy[[1]].",
    v: 2,
    claims: [[1]],
    suggestions: [],
    grounding: "degraded",
  });
  const run = (reply: string) => {
    const built = buildRunner({ reply, contexts: [refundContext] });
    return built.runner
      .answer({ workspaceId: "ws-1", runId: "run-1", query: "How long do refunds take?", history: [] })
      .then((result) => ({ result, captured: built.captured }));
  };

  it("presents a committed decline that cites a Result without citations", async () => {
    const { result, captured } = await run(envelope("no_support"));

    expect(result.groundingSummary).toMatchObject({ verdict: "no_support", declineReason: "content_gap" });
    expect(captured.presentedCitationCount).toBe(0);
  });

  it("presents a cited answer with the Results it may cite", async () => {
    const { result, captured } = await run(envelope("answer"));

    expect(result.groundingSummary).toMatchObject({ verdict: "grounded" });
    expect(captured.presentedCitationCount).toBe(1);
  });
});
