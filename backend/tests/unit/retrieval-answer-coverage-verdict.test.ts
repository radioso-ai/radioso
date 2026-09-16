import { describe, expect, it, vi } from "vitest";

import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
import type {
  AnswerCoverageAssessment,
  RetrievalCoverageVerdictSink,
} from "../../src/modules/chat/contracts/answerCoverage.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";

const context = (index: number) => ({
  documentId: `doc-${index}`,
  chunkId: `chunk-${index}`,
  title: `Guide ${index}`,
  content: `Workshop evidence ${index}`,
});

const groundedSession = (): PreparedSession => ({
  agent: { workspaceId: "workspace-1", chatModelOverride: null } as never,
  conversation: { id: "conversation-1", workspaceId: "workspace-1" } as never,
  history: [],
  userMessage: { id: "message-1", content: "Tell me about the workshop." } as never,
  effectiveQuery: "Tell me about the workshop.",
  turnRoute: "retrieval",
  pageContext: null,
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  directiveSteering: { rules: [], matches: [], omissions: [] },
  retrieval: {
    systemPrompt: "system",
    prompt: "prompt",
    responseIdentity: null,
    responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0 },
    diagnostics: {},
    contexts: [context(1)],
  } as unknown as RetrievalPipelineResult,
}) as unknown as PreparedSession;

const zeroContextSession = (): PreparedSession => {
  const session = groundedSession();
  (session.retrieval as { contexts: unknown[] }).contexts = [];
  // Let the deterministic assessment fall back to the turn's own query rather
  // than a fixed effectiveQuery, matching what each zero-context test asks.
  (session as { effectiveQuery: string }).effectiveQuery = "";
  return session;
};

const fakeSupport = (): ChatAnswerSupport => ({
  buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
  buildChatUsageContext: () => ({ surface: "assistant", operation: "answer" }),
  buildPromptWithContext: (prompt: string) => prompt,
  buildAnswerInstructionBlock: () => "",
} as unknown as ChatAnswerSupport);

const presenter = () => new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
  supportsGroundedAnswer: () => true,
});

const missingFallback: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "I can't help with that here.", declineReason: "content_gap" };
  },
};

/** A structured (head-first) envelope: coverage/requestFocus/outcome precede answer, as the real schema orders them. */
const structuredEnvelope = (input: {
  coverage: string;
  requestFocus: string;
  outcome: "answer" | "no_support" | "out_of_scope";
  answer: string;
  claims?: number[][];
}): string => JSON.stringify({
  coverage: input.coverage,
  requestFocus: input.requestFocus,
  outcome: input.outcome,
  answer: input.answer,
  v: 2,
  claims: input.claims ?? [],
  suggestions: [],
  grounding: "degraded",
});

const gatewayFor = (raw: string): ChatGateway => ({
  async answer() {
    return raw;
  },
  async *streamAnswer() {
    for (let offset = 0; offset < raw.length; offset += 6) {
      yield raw.slice(offset, offset + 6);
    }
  },
});

const buildComposer = (
  gateway: ChatGateway,
  fallback: FallbackReplyComposer = missingFallback,
  metrics?: { incrementCounter: (name: string, options: { help: string; labels?: Record<string, string> }) => void },
) => new RetrievalAnswerComposer(fakeSupport(), gateway, presenter(), fallback, metrics);

const fakeSink = (decision: "proceed" | "yield_turn") => {
  const calls: Array<{ assessment: AnswerCoverageAssessment }> = [];
  const sink: RetrievalCoverageVerdictSink = {
    async report(input) {
      calls.push(input);
      return { decision };
    },
  };
  return { sink, calls };
};

const drain = async (generator: AsyncGenerator<string, TurnStreamResult>) => {
  const chunks: string[] = [];
  let step = await generator.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await generator.next();
  }
  return { chunks, result: step.value };
};

describe("RetrievalAnswerComposer coverage verdict sink — streaming", () => {
  it("reports the parsed head to the sink and streams normally on proceed", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: "The workshop runs in June[[1]].",
      claims: [[1]],
    });
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const { chunks, result } = await drain(
      composer.streamAnswer(groundedSession(), "Tell me about the workshop.", undefined, undefined, undefined, sink),
    );

    expect(calls).toEqual([{
      assessment: {
        availability: "assessed",
        coverage: "answered",
        reason: "sufficient_evidence",
        schemaVersion: 1,
        producer: "answer_head",
      },
    }]);
    expect(chunks.join("")).toContain("The workshop runs in June");
    expect(result.hasStreamedAnswer).toBe(true);
    expect(result.yielded).toBeFalsy();
    expect(result.traceMetrics?.coverageHeadMs).toBeGreaterThanOrEqual(0);
  });

  it("aborts the stream and releases no text when the sink yields the turn", async () => {
    const raw = structuredEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "the refund policy",
      outcome: "answer",
      answer: "Here is what I found[[1]].",
      claims: [[1]],
    });
    const { sink, calls } = fakeSink("yield_turn");
    const composer = buildComposer(gatewayFor(raw));

    const { chunks, result } = await drain(
      composer.streamAnswer(groundedSession(), "Refund policy?", undefined, undefined, undefined, sink),
    );

    expect(calls).toHaveLength(1);
    expect(chunks).toEqual([]);
    expect(result.hasStreamedAnswer).toBe(false);
    expect(result.streamedAnswer).toBe("");
    expect(result.finalPresentation.answer).toBe("");
    expect(result.yielded).toBe(true);
    expect(result.deliveryMode).toBe("yielded");
  });

  it("bypasses the citation gate and streams immediately when the head commits to no_support", async () => {
    const raw = structuredEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "the refund policy",
      outcome: "no_support",
      answer: "I don't have anything on that in your workspace.",
      claims: [],
    });
    const { sink } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const { chunks, result } = await drain(
      composer.streamAnswer(groundedSession(), "Refund policy?", undefined, undefined, undefined, sink),
    );

    // No sourced assertion ever appears, so the default citation gate would hold this
    // forever; the no_support commitment must still stream live (FR-027).
    expect(chunks.join("")).toContain("I don't have anything on that");
    expect(result.hasStreamedAnswer).toBe(true);
  });

  it("reports invalid availability for a legacy (non-JSON) stream and still delivers the answer", async () => {
    const raw = "This is a plain legacy answer[[1]].\n<<<RADIOSO_FOLLOWUPS_JSON>>>\n"
      + JSON.stringify({ v: 2, outcome: "answer", claims: [[1]], suggestions: [] });
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const { chunks, result } = await drain(
      composer.streamAnswer(groundedSession(), "Tell me about the workshop.", undefined, undefined, undefined, sink),
    );

    expect(calls).toEqual([{ assessment: { availability: "invalid", producer: "answer_head" } }]);
    expect(chunks.join("")).toContain("This is a plain legacy answer");
    expect(result.hasStreamedAnswer).toBe(true);
    expect(result.yielded).toBeFalsy();
  });

  it("reports a deterministic assessment for the zero-context branch before the existing fallback", async () => {
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor("unused"));

    await drain(composer.streamAnswer(zeroContextSession(), "What is the capital of Mars?", undefined, undefined, undefined, sink));

    expect(calls).toEqual([{
      assessment: {
        availability: "assessed",
        coverage: "unanswered",
        reason: "insufficient_evidence",
        unresolvedRequest: "What is the capital of Mars?",
        schemaVersion: 1,
        producer: "deterministic",
      },
    }]);
  });

  it("honours yield_turn on the zero-context branch before calling the existing fallback", async () => {
    const { sink } = fakeSink("yield_turn");
    let fallbackCalled = false;
    const trackedFallback: FallbackReplyComposer = {
      async composeNoContext() {
        fallbackCalled = true;
        return { text: "unused", declineReason: "content_gap" };
      },
    };
    const composer = buildComposer(gatewayFor("unused"), trackedFallback);

    const { chunks, result } = await drain(
      composer.streamAnswer(zeroContextSession(), "What is the capital of Mars?", undefined, undefined, undefined, sink),
    );

    expect(fallbackCalled).toBe(false);
    expect(chunks).toEqual([]);
    expect(result.yielded).toBe(true);
  });
});

describe("RetrievalAnswerComposer coverage verdict sink — non-streaming", () => {
  it("reports the head from the completed envelope and presents it on proceed", async () => {
    const raw = structuredEnvelope({
      coverage: "partial_insufficient_evidence",
      requestFocus: "the accommodation fee",
      outcome: "answer",
      answer: "The workshop runs in June[[1]].",
      claims: [[1]],
    });
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const presented = await composer.composeAnswer(groundedSession(), "Tell me about the workshop.", undefined, undefined, sink);

    expect(calls).toEqual([{
      assessment: {
        availability: "assessed",
        coverage: "partial",
        reason: "insufficient_evidence",
        unresolvedRequest: "the accommodation fee",
        schemaVersion: 1,
        producer: "answer_head",
      },
    }]);
    expect(presented.answer).toContain("The workshop runs in June");
    expect(presented.yielded).toBeFalsy();
  });

  it("discards the envelope and reports a yielded presentation when the sink yields the turn", async () => {
    const raw = structuredEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "the refund policy",
      outcome: "answer",
      answer: "Here is what I found[[1]].",
      claims: [[1]],
    });
    const { sink } = fakeSink("yield_turn");
    const composer = buildComposer(gatewayFor(raw));

    const presented = await composer.composeAnswer(groundedSession(), "Refund policy?", undefined, undefined, sink);

    expect(presented.answer).toBe("");
    expect(presented.yielded).toBe(true);
  });

  it("reports a deterministic assessment for the zero-context branch before the existing fallback", async () => {
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor("unused"));

    await composer.composeAnswer(zeroContextSession(), "What is the capital of Mars?", undefined, undefined, sink);

    expect(calls).toEqual([{
      assessment: {
        availability: "assessed",
        coverage: "unanswered",
        reason: "insufficient_evidence",
        unresolvedRequest: "What is the capital of Mars?",
        schemaVersion: 1,
        producer: "deterministic",
      },
    }]);
  });
});

describe("RetrievalAnswerComposer coverage head metrics", () => {
  it("counts a parsed head and a proceed decision on the non-streaming grounded path", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: "The workshop runs in June[[1]].",
      claims: [[1]],
    });
    const { sink } = fakeSink("proceed");
    const metrics = { incrementCounter: vi.fn() };
    const composer = buildComposer(gatewayFor(raw), missingFallback, metrics);

    await composer.composeAnswer(groundedSession(), "Tell me about the workshop.", undefined, undefined, sink);

    expect(metrics.incrementCounter).toHaveBeenCalledWith("chat_answer_coverage_head_parse_total", expect.objectContaining({
      labels: { outcome: "parsed" },
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("chat_answer_coverage_head_decision_total", expect.objectContaining({
      labels: { decision: "proceed" },
    }));
  });

  it("counts an invalid head and a yield_turn decision when the sink yields", async () => {
    const { sink } = fakeSink("yield_turn");
    const metrics = { incrementCounter: vi.fn() };
    // Legacy (non-JSON) text never carries a head, so it parses as invalid.
    const composer = buildComposer(gatewayFor("Free-text legacy answer."), missingFallback, metrics);

    await composer.composeAnswer(groundedSession(), "Tell me about the workshop.", undefined, undefined, sink);

    expect(metrics.incrementCounter).toHaveBeenCalledWith("chat_answer_coverage_head_parse_total", expect.objectContaining({
      labels: { outcome: "invalid" },
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("chat_answer_coverage_head_decision_total", expect.objectContaining({
      labels: { decision: "yield_turn" },
    }));
  });

  it("counts a deterministic outcome for the zero-context branch", async () => {
    const { sink } = fakeSink("proceed");
    const metrics = { incrementCounter: vi.fn() };
    const composer = buildComposer(gatewayFor("unused"), missingFallback, metrics);

    await composer.composeAnswer(zeroContextSession(), "What is the capital of Mars?", undefined, undefined, sink);

    expect(metrics.incrementCounter).toHaveBeenCalledWith("chat_answer_coverage_head_parse_total", expect.objectContaining({
      labels: { outcome: "deterministic" },
    }));
  });

  it("records nothing when no coverage verdict sink is wired", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: "The workshop runs in June[[1]].",
      claims: [[1]],
    });
    const metrics = { incrementCounter: vi.fn() };
    const composer = buildComposer(gatewayFor(raw), missingFallback, metrics);

    await composer.composeAnswer(groundedSession(), "Tell me about the workshop.", undefined, undefined, undefined);

    const coverageHeadCalls = metrics.incrementCounter.mock.calls.filter(([name]) => name.startsWith("chat_answer_coverage_head_"));
    expect(coverageHeadCalls).toEqual([]);
  });
});
