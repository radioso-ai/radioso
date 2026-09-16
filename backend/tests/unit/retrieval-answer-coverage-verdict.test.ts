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
import { REQUEST_FOCUS_MAX_LENGTH } from "../../src/modules/answerCoverage/public.js";

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

/** Captures the `steering` a decline prompt actually rendered with, for F2's known-verdict filtering. */
const capturingFallback = () => {
  const steeringCalls: Array<import("../../src/shared/domain/steeringRule.js").SteeringRule[]> = [];
  const fallback: FallbackReplyComposer = {
    async composeNoContext(input) {
      steeringCalls.push(input.steering ?? []);
      return { text: "I can't help with that here.", declineReason: "content_gap" };
    },
  };
  return { fallback, steeringCalls };
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

/**
 * A key-order violation (#1260 review round 5, F10a): `answer` opens before the head fields,
 * as if a provider ignored the schema's declared property order. The head
 * reader must treat this as `invalid`, never as a failed turn (FR-004).
 */
const answerFirstEnvelope = (input: {
  coverage: string;
  requestFocus: string;
  outcome: "answer" | "no_support" | "out_of_scope";
  answer: string;
  claims?: number[][];
}): string => JSON.stringify({
  answer: input.answer,
  coverage: input.coverage,
  requestFocus: input.requestFocus,
  outcome: input.outcome,
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

/** Yields the whole envelope as one chunk, so the head-completing chunk also carries the full body. */
const singleChunkGatewayFor = (raw: string): ChatGateway => ({
  async answer() {
    return raw;
  },
  async *streamAnswer() {
    yield raw;
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

  it("reports invalid availability once when answer opens before the head fields in a valid-JSON envelope (#1260 review round 5, F10a)", async () => {
    const raw = answerFirstEnvelope({
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

    expect(calls).toEqual([{ assessment: { availability: "invalid", producer: "answer_head" } }]);
    expect(chunks.join("")).toContain("The workshop runs in June");
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

describe("RetrievalAnswerComposer coverage verdict sink — page-read capture path (#1260 F10b)", () => {
  /** Mirrors `capturedPageReadSession` in retrieval-answer-v2-outcomes.test.ts. */
  const capturedPageReadSession = (): PreparedSession => {
    const session = groundedSession();
    const resolvedRequest = "Read the migration access code from this page.";
    session.pageContext = {
      pageUrl: "https://example.invalid/migrations/quartz",
      content: "The migration access code is QZ-7419.",
    };
    session.pageReadOutcome = {
      merged: {
        decision: { required: true, operation: "lookup", resolvedRequest },
        contributors: [{ source: { kind: "planner" }, operation: "lookup", resolvedRequest }],
      },
      gate: { kind: "capture", operation: "lookup", resolvedRequest },
    };
    return session;
  };

  it("reports the head exactly once, parsed before any release, on the committed capture path", async () => {
    const pageAnswer = "The migration access code is QZ-7419.";
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the migration access code",
      outcome: "answer",
      answer: pageAnswer,
      claims: [],
    });
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const { chunks, result } = await drain(
      composer.streamAnswer(
        capturedPageReadSession(),
        "What is the migration access code?",
        undefined,
        undefined,
        undefined,
        sink,
      ),
    );

    // The capture path skips the citation gate but not the head (spec edge case):
    // nothing streams live either way, so this only proves the report happened
    // exactly once and the delivered text is the head-gated body, not raw chunks
    // released before the head resolved.
    expect(calls).toHaveLength(1);
    expect(calls[0].assessment).toMatchObject({ availability: "assessed", coverage: "answered" });
    expect(chunks).toEqual([]);
    expect(result.hasStreamedAnswer).toBe(false);
    expect(result.finalPresentation.answer).toBe(pageAnswer);
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

describe("RetrievalAnswerComposer decline prompts render coverage rules against the known verdict (#1260 review F2)", () => {
  const withDirectiveSteering = (session: PreparedSession): PreparedSession => {
    session.directiveSteering = {
      rules: [
        { action: "Be warm.", source: "directive", lifespan: "response" },
        {
          action: "Offer the form.",
          source: "directive",
          lifespan: "response",
          coverageCriteria: { coverage: ["unanswered"] },
        },
        {
          action: "Never applies to an unanswered verdict.",
          source: "directive",
          lifespan: "response",
          coverageCriteria: { coverage: ["answered"] },
        },
      ],
      matches: [],
      omissions: [],
    };
    return session;
  };

  it("renders a matching coverage directive unconditionally in the streaming zero-evidence decline prompt", async () => {
    const { sink } = fakeSink("proceed");
    const { fallback, steeringCalls } = capturingFallback();
    const composer = buildComposer(gatewayFor("unused"), fallback);

    await drain(composer.streamAnswer(
      withDirectiveSteering(zeroContextSession()),
      "What is the capital of Mars?",
      undefined,
      undefined,
      undefined,
      sink,
    ));

    expect(steeringCalls).toEqual([[
      { action: "Be warm.", source: "directive", lifespan: "response" },
      { action: "Offer the form.", source: "directive", lifespan: "response" },
    ]]);
  });

  it("renders a matching coverage directive unconditionally in the non-streaming zero-evidence decline prompt", async () => {
    const { sink } = fakeSink("proceed");
    const { fallback, steeringCalls } = capturingFallback();
    const composer = buildComposer(gatewayFor("unused"), fallback);

    await composer.composeAnswer(
      withDirectiveSteering(zeroContextSession()),
      "What is the capital of Mars?",
      undefined,
      undefined,
      sink,
    );

    expect(steeringCalls).toEqual([[
      { action: "Be warm.", source: "directive", lifespan: "response" },
      { action: "Offer the form.", source: "directive", lifespan: "response" },
    ]]);
  });

  it("renders nothing for the zero-evidence decline when only an answered-gated directive is present", async () => {
    const { sink } = fakeSink("proceed");
    const { fallback, steeringCalls } = capturingFallback();
    const composer = buildComposer(gatewayFor("unused"), fallback);
    const session = zeroContextSession();
    session.directiveSteering = {
      rules: [{
        action: "Never applies to an unanswered verdict.",
        source: "directive",
        lifespan: "response",
        coverageCriteria: { coverage: ["answered"] },
      }],
      matches: [],
      omissions: [],
    };

    await composer.composeAnswer(session, "What is the capital of Mars?", undefined, undefined, sink);

    expect(steeringCalls).toEqual([[]]);
  });

  it("renders a matching coverage directive unconditionally in the unsupported-draft decline prompt", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: "An uncited draft with no sourced assertion at all.",
      claims: [],
    });
    const { sink } = fakeSink("proceed");
    const { fallback, steeringCalls } = capturingFallback();
    const composer = buildComposer(gatewayFor(raw), fallback);
    const session = withDirectiveSteering(groundedSession());
    session.directiveSteering!.rules[1] = {
      action: "Offer the form.",
      source: "directive",
      lifespan: "response",
      coverageCriteria: { coverage: ["answered"] },
    };
    session.directiveSteering!.rules[2] = {
      action: "Never applies to an answered verdict.",
      source: "directive",
      lifespan: "response",
      coverageCriteria: { coverage: ["unanswered"] },
    };

    const presented = await composer.composeAnswer(session, "Tell me about the workshop.", undefined, undefined, sink);

    expect(presented.grounding).toBe("no_support");
    expect(steeringCalls).toEqual([[
      { action: "Be warm.", source: "directive", lifespan: "response" },
      { action: "Offer the form.", source: "directive", lifespan: "response" },
    ]]);
  });
});

describe("RetrievalAnswerComposer deterministic zero-evidence requestFocus bound (#1260 review F7)", () => {
  it("does not leak conversation history into the deterministic zero-evidence unresolvedRequest (non-streaming)", async () => {
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor("unused"));
    const session = zeroContextSession();
    session.history = [
      { role: "user", content: "What is your refund window?" },
      { role: "assistant", content: "Thirty days from purchase." },
    ] as never;

    await composer.composeAnswer(session, "What is the capital of Mars?", undefined, undefined, sink);

    const assessment = calls[0]?.assessment as Extract<AnswerCoverageAssessment, { availability: "assessed" }>;
    expect(assessment.unresolvedRequest).toBe("What is the capital of Mars?");
    expect(assessment.unresolvedRequest).not.toContain("refund window");
    expect(assessment.unresolvedRequest).not.toContain("user:");
  });

  it("bounds the deterministic zero-evidence unresolvedRequest to REQUEST_FOCUS_MAX_LENGTH (streaming)", async () => {
    const { sink, calls } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor("unused"));
    const session = zeroContextSession();
    const longQuery = "x".repeat(REQUEST_FOCUS_MAX_LENGTH + 200);

    await drain(composer.streamAnswer(session, longQuery, undefined, undefined, undefined, sink));

    const assessment = calls[0]?.assessment as Extract<AnswerCoverageAssessment, { availability: "assessed" }>;
    expect(assessment.unresolvedRequest?.length).toBeLessThanOrEqual(REQUEST_FOCUS_MAX_LENGTH);
  });
});

describe("RetrievalAnswerComposer aborts while a coverage report is pending (#1260 review F10a)", () => {
  it("releases no answer text and never reports twice when the client aborts while report() is pending", async () => {
    // The whole envelope arrives in one chunk, so the same iteration that completes
    // the head also has the full decline body ready to release. `report()`'s own
    // promise represents the host's routine-activation work; the client aborts
    // while that is still pending, before the sink resolves.
    const raw = structuredEnvelope({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "the refund policy",
      outcome: "no_support",
      answer: "I can't confirm that one, but I can help with our workshop schedule.",
      claims: [],
    });
    const controller = new AbortController();
    const calls: Array<{ assessment: AnswerCoverageAssessment }> = [];
    const sink: RetrievalCoverageVerdictSink = {
      async report(input) {
        calls.push(input);
        controller.abort(new Error("client_disconnected"));
        return { decision: "proceed" };
      },
    };
    const composer = buildComposer(singleChunkGatewayFor(raw));

    const generator = composer.streamAnswer(
      groundedSession(),
      "Refund policy?",
      undefined,
      undefined,
      controller.signal,
      sink,
    );
    const releasedChunks: string[] = [];
    let thrown: unknown;
    try {
      let step = await generator.next();
      while (!step.done) {
        releasedChunks.push(step.value);
        step = await generator.next();
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(releasedChunks).toEqual([]);
    expect(calls).toHaveLength(1);
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

describe("RetrievalAnswerComposer citation hold setting (FR-025..028)", () => {
  const withCitationHold = (enabled: boolean): PreparedSession => {
    const session = groundedSession();
    const retrieval = session.retrieval as unknown as { responseSettings: Record<string, unknown> };
    retrieval.responseSettings = { ...retrieval.responseSettings, citationHoldEnabled: enabled };
    return session;
  };

  const lateCitationAnswer = "This grounded answer keeps going for quite a while before it finally reaches "
    + "its one supporting citation near the very end of the response[[1]].";

  it("holds text until the first citation appears and reports the wait when the hold is on (default, unchanged)", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: lateCitationAnswer,
      claims: [[1]],
    });
    const { sink } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const { chunks, result } = await drain(
      composer.streamAnswer(withCitationHold(true), "Tell me about the workshop.", undefined, undefined, undefined, sink),
    );

    expect(chunks.join("")).toContain("its one supporting citation");
    expect(result.traceMetrics?.groundingGateWaitMs).toEqual(expect.any(Number));
  });

  it("releases text immediately after the head and reports no gate wait when the hold is off", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: lateCitationAnswer,
      claims: [[1]],
    });
    const { sink } = fakeSink("proceed");
    const composerOn = buildComposer(gatewayFor(raw));
    const composerOff = buildComposer(gatewayFor(raw));

    const { chunks: heldChunks } = await drain(
      composerOn.streamAnswer(withCitationHold(true), "Tell me about the workshop.", undefined, undefined, undefined, sink),
    );
    const { chunks: releasedChunks, result } = await drain(
      composerOff.streamAnswer(withCitationHold(false), "Tell me about the workshop.", undefined, undefined, undefined, sink),
    );

    // Holding collapses everything up to the citation into one release; turning the
    // hold off streams every parsed piece of `answer` text as it arrives instead, so
    // the very first chunk lands well before the citation and there are more of them.
    expect(releasedChunks.length).toBeGreaterThan(heldChunks.length);
    expect(releasedChunks[0]).not.toContain("[[1]]");
    expect(releasedChunks.join("")).toContain("its one supporting citation");
    expect(result.traceMetrics?.groundingGateWaitMs).toBeUndefined();
  });

  it("delivers a zero-claim answer as degraded with no decline swap when the hold is off", async () => {
    const raw = structuredEnvelope({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
      answer: "Here is a plain answer with no citation at all.",
      claims: [],
    });
    const { sink } = fakeSink("proceed");
    const composer = buildComposer(gatewayFor(raw));

    const { result } = await drain(
      composer.streamAnswer(withCitationHold(false), "Tell me about the workshop.", undefined, undefined, undefined, sink),
    );

    expect(result.hasStreamedAnswer).toBe(true);
    expect(result.finalPresentation.answer).toContain("Here is a plain answer");
    expect(result.finalPresentation.grounding).toBe("degraded");
  });

  it.each([true, false])(
    "never holds a no_support decline regardless of the setting (citationHoldEnabled=%s)",
    async (citationHoldEnabled) => {
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
        composer.streamAnswer(withCitationHold(citationHoldEnabled), "Refund policy?", undefined, undefined, undefined, sink),
      );

      expect(chunks.join("")).toContain("I don't have anything on that");
      expect(result.hasStreamedAnswer).toBe(true);
    },
  );
});
