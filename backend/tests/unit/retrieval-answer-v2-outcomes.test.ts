import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type {
  ComposedDecline,
  FallbackReplyComposer,
} from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { getGroundedMissFallback } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import {
  buildGroundedAnswerResponseFormat,
  SUGGESTIONS_SENTINEL,
} from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import { createDirectiveAdherenceSideChannel } from "../../src/shared/domain/directiveAdherence.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  DEGRADED_V2_VISIBLE,
  GROUNDED_V2_VISIBLE,
  NO_SUPPORT_V2_BODY,
  degradedV2Envelope,
  formatV2Envelope,
  groundedV2Envelope,
  noSupportV2Envelope,
  outOfScopeV2Envelope,
} from "../support/answerEnvelopeV2Fixtures.js";

const unsupportedAnswerEnvelope = (body: string): string =>
  formatV2Envelope(body, {
    v: 2,
    outcome: "answer",
    claims: [],
    suggestions: [],
    grounding: "degraded",
  });

const context = (index: number) => ({
  documentId: `doc-${index}`,
  chunkId: `chunk-${index}`,
  title: `Guide ${index}`,
  content: `Workshop evidence ${index}`,
});

const baseSession = (): PreparedSession => ({
  agent: { workspaceId: "workspace-1", chatModelOverride: null } as never,
  conversation: { id: "conversation-1", workspaceId: "workspace-1" } as never,
  history: [],
  userMessage: { id: "message-1", content: "Tell me about the workshop." } as never,
  turnRoute: "retrieval",
  pageContext: null,
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  directiveSteering: { rules: [], matches: [], omissions: [] },
  retrieval: {
    systemPrompt: "system",
    prompt: "prompt",
    responseIdentity: null,
    responseSettings: { suggestedQuestionsEnabled: true, suggestedQuestionsCount: 3 },
    diagnostics: {},
    contexts: [context(1), context(2), context(3)],
  } as unknown as RetrievalPipelineResult,
}) as unknown as PreparedSession;

const presenter = () => new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
  supportsGroundedAnswer: () => true,
});

const drain = async (generator: AsyncGenerator<string, TurnStreamResult>) => {
  const chunks: string[] = [];
  let step = await generator.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await generator.next();
  }
  return { chunks, result: step.value };
};

const buildComposer = (
  raw: string,
  decline: string | ComposedDecline = "FOCUSED GROUNDED MISS",
) => {
  const composedDecline: ComposedDecline = typeof decline === "string"
    ? { text: decline, declineReason: "content_gap" }
    : decline;
  let answerCalls = 0;
  let streamCalls = 0;
  let fallbackCalls = 0;
  let fallbackWorkspaceContext: unknown;
  const attemptKeys: string[] = [];
  const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];
  const responseFormats: unknown[] = [];
  let gateAbortObserved = false;
  const gateway: ChatGateway = {
    async answer(input) {
      answerCalls += 1;
      attemptKeys.push(input.usageContext.attemptKey);
      responseFormats.push(input.generation?.responseFormat);
      return raw;
    },
    async *streamAnswer(input) {
      streamCalls += 1;
      attemptKeys.push(input.usageContext.attemptKey);
      responseFormats.push(input.generation?.responseFormat);
      try {
        for (let offset = 0; offset < raw.length; offset += 7) {
          yield raw.slice(offset, offset + 7);
        }
      } finally {
        gateAbortObserved = input.signal?.aborted ?? false;
      }
    },
  };
  const fallback: FallbackReplyComposer = {
    async composeNoContext(input) {
      fallbackCalls += 1;
      fallbackWorkspaceContext = input.workspaceContext;
      attemptKeys.push(input.usageContext.attemptKey);
      return composedDecline;
    },
  };
  return {
    composer: new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter(), fallback, {
      incrementCounter(name, options) {
        metricWrites.push({ name, labels: options.labels });
      },
    }, { forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules) }),
    counts: () => ({ answerCalls, streamCalls, fallbackCalls }),
    fallbackWorkspaceContext: () => fallbackWorkspaceContext,
    attemptKeys,
    metricWrites,
    responseFormats: () => responseFormats,
    gateAbortObserved: () => gateAbortObserved,
  };
};

const capturedPageReadSession = (): PreparedSession => {
  const session = baseSession();
  const resolvedRequest = "Read the migration access code from this page.";
  session.pageContext = {
    pageUrl: "https://example.invalid/migrations/quartz",
    content: "The migration access code is QZ-7419.",
  };
  session.pageReadOutcome = {
    merged: {
      decision: { required: true, operation: "lookup", resolvedRequest },
      contributors: [{
        source: { kind: "planner" },
        operation: "lookup",
        resolvedRequest,
      }],
    },
    gate: { kind: "capture", operation: "lookup", resolvedRequest },
  };
  return session;
};

describe("retrieval answer decline classification", () => {
  const zeroContextSession = (): PreparedSession => {
    const session = baseSession();
    (session.retrieval as { contexts: unknown[] }).contexts = [];
    return session;
  };

  it("tags a zero-context out-of-scope decline with the out_of_scope outcome", async () => {
    const { composer } = buildComposer("unused", { text: "Not my remit.", declineReason: "out_of_scope" });

    const presented = await composer.composeAnswer(zeroContextSession(), "Capital of Mars?", undefined, undefined);

    expect(presented.answer).toBe("Not my remit.");
    expect(presented.skillOutcome).toBe("out_of_scope");
  });

  it("keeps a zero-context content-gap decline on the no_context outcome", async () => {
    const { composer } = buildComposer("unused", { text: "I can't confirm that.", declineReason: "content_gap" });

    const presented = await composer.composeAnswer(zeroContextSession(), "Refund policy?", undefined, undefined);

    expect(presented.skillOutcome).toBe("no_context");
  });

  it("keeps fallback-generation failures out of the grounding-gap outcome", async () => {
    const { composer } = buildComposer("unused", {
      text: "I can't respond right now.",
      declineReason: "generation_unavailable",
    });

    const presented = await composer.composeAnswer(zeroContextSession(), "Refund policy?", undefined, undefined);

    expect(presented.skillOutcome).toBe("unavailable");
    expect(presented.skillStatus).toBe("failed");
  });

  it("carries the classification through the zero-context streaming path", async () => {
    const { composer } = buildComposer("unused", { text: "Not my remit.", declineReason: "out_of_scope" });

    const { result } = await drain(
      composer.streamAnswer(zeroContextSession(), "Capital of Mars?", undefined, undefined),
    );

    expect(result.finalPresentation.skillOutcome).toBe("out_of_scope");
  });

  it("tags an out-of-scope envelope decline with the out_of_scope outcome", async () => {
    const { composer } = buildComposer(outOfScopeV2Envelope());

    const presented = await composer.composeAnswer(baseSession(), "Capital of Mars?", undefined, undefined);

    expect(presented.skillOutcome).toBe("out_of_scope");
    expect(presented.groundingSummary).toMatchObject({ verdict: "no_support", declineReason: "out_of_scope" });
  });

  it("labels the outcome counter with the decline reason", async () => {
    const { composer, metricWrites } = buildComposer(outOfScopeV2Envelope());

    await composer.composeAnswer(baseSession(), "Capital of Mars?", undefined, undefined);

    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "no_support", reason: "complete", stream: "false", decline: "out_of_scope" },
    }]);
  });

  it("carries the gate-bound focused decline classification into the outcome", async () => {
    const { composer } = buildComposer(
      "PRIVATE ".repeat(1_000),
      { text: "Not my remit.", declineReason: "out_of_scope" },
    );

    const { result } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));

    expect(result.finalPresentation.skillOutcome).toBe("out_of_scope");
  });
});

describe("unsupported-answer delivery guard", () => {
  const SQRT_ANSWER = "The numerical value of sqrt(5) is approximately 2.2360679.";
  const OVERLAPPING_ANSWER = "Workshop evidence 1 describes the schedule.";

  it("declines an outcome=answer reply without a sourced assertion", async () => {
    const { composer, counts } = buildComposer(unsupportedAnswerEnvelope(SQRT_ANSWER), {
      text: "That's outside what I can help with here.",
      declineReason: "out_of_scope",
    });

    const presented = await composer.composeAnswer(baseSession(), "sqrt(5)", undefined, undefined);

    expect(presented.answer).toBe("That's outside what I can help with here.");
    expect(presented.answer).not.toContain("2.2360679");
    expect(presented.skillOutcome).toBe("out_of_scope");
    expect(counts().fallbackCalls).toBe(1);
  });

  it("does not treat lexical overlap as grounding evidence", async () => {
    const { composer, counts } = buildComposer(unsupportedAnswerEnvelope(OVERLAPPING_ANSWER));

    const presented = await composer.composeAnswer(baseSession(), "What is the schedule?", undefined, undefined);

    expect(presented.answer).toBe("FOCUSED GROUNDED MISS");
    expect(presented.skillOutcome).toBe("no_context");
    expect(counts().fallbackCalls).toBe(1);
  });

  it("declines an unsupported answer without releasing held stream content", async () => {
    const { composer, counts } = buildComposer(unsupportedAnswerEnvelope(SQRT_ANSWER), {
      text: "That's outside what I can help with here.",
      declineReason: "out_of_scope",
    });

    const { chunks, result } = await drain(
      composer.streamAnswer(baseSession(), "sqrt(5)", undefined, undefined),
    );

    expect(chunks).toEqual([]);
    expect(result.hasStreamedAnswer).toBe(false);
    expect(result.finalPresentation.answer).toBe("That's outside what I can help with here.");
    expect(result.finalPresentation.skillOutcome).toBe("out_of_scope");
    expect(counts().fallbackCalls).toBe(1);
  });

  it("keeps captured page-read output when unrelated retrieval contexts are present", async () => {
    const pageAnswer = "The migration access code is QZ-7419.";
    const { composer, counts } = buildComposer(unsupportedAnswerEnvelope(pageAnswer));

    const presented = await composer.composeAnswer(
      capturedPageReadSession(),
      "What is the migration access code?",
      undefined,
      undefined,
    );

    expect(presented.answer).toBe(pageAnswer);
    expect(presented.skillOutcome).toBe("grounded_degraded");
    expect(counts().fallbackCalls).toBe(0);
  });

  it("keeps captured page-read output on the committed streaming path", async () => {
    const pageAnswer = "The migration access code is QZ-7419.";
    const { composer, counts } = buildComposer(unsupportedAnswerEnvelope(pageAnswer));

    const { chunks, result } = await drain(
      composer.streamAnswer(
        capturedPageReadSession(),
        "What is the migration access code?",
        undefined,
        undefined,
      ),
    );

    expect(chunks).toEqual([]);
    expect(result.hasStreamedAnswer).toBe(false);
    expect(result.finalPresentation.answer).toBe(pageAnswer);
    expect(result.finalPresentation.skillOutcome).toBe("grounded_degraded");
    expect(counts().fallbackCalls).toBe(0);
  });
});

describe("retrieval answer envelope v2", () => {
  it("keeps provider-enforced suggestions out of visible answer text", async () => {
    const raw = JSON.stringify({
      answer: "The workshop begins in June[[1]].",
      v: 2,
      outcome: "answer",
      claims: [[1]],
      suggestions: [
        { text: "How does registration work?", kind: "deeper", contextIndex: 1 },
      ],
      grounding: "degraded",
    });
    const { composer, responseFormats } = buildComposer(raw);

    const presented = await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

    expect(presented.answer).toBe("The workshop begins in June.");
    expect(presented.answer).not.toContain("How does registration work?");
    expect(presented.suggestions).toMatchObject([
      { text: "How does registration work?", kind: "deeper" },
    ]);
    expect(responseFormats()).toEqual([buildGroundedAnswerResponseFormat()]);
  });

  it("streams only a structured answer and returns its suggestions separately", async () => {
    const raw = JSON.stringify({
      answer: "The workshop begins in June[[1]].",
      v: 2,
      outcome: "answer",
      claims: [[1]],
      suggestions: [
        { text: "How does registration work?", kind: "deeper", contextIndex: 1 },
      ],
      grounding: "degraded",
    });
    const { composer, responseFormats } = buildComposer(raw);

    const { chunks, result } = await drain(
      composer.streamAnswer(baseSession(), "Question?", undefined, undefined),
    );

    expect(chunks.join("")).toBe("The workshop begins in June.");
    expect(chunks.join("")).not.toContain("How does registration work?");
    expect(result.suggestions).toEqual({
      mode: "assistant",
      planned: [{ text: "How does registration work?", kind: "deeper", contextIndex: 1 }],
    });
    expect(responseFormats()).toEqual([buildGroundedAnswerResponseFormat()]);
  });

  it("resolves rule-keyed adherence into directive trace metadata", async () => {
    const session = baseSession();
    session.directiveSteering = {
      rules: [{
        id: "d1",
        directiveName: "Be concise",
        action: "Keep the response concise.",
        source: "directive",
        lifespan: "response",
      }],
      matches: [],
      omissions: [],
    };
    const { composer, responseFormats } = buildComposer(JSON.stringify({
      answer: "The workshop begins in June[[1]].",
      v: 2,
      outcome: "answer",
      claims: [[1]],
      suggestions: [],
      grounding: "degraded",
      adherence: [{ rule: "d1", satisfied: true, note: "kept the answer concise" }],
    }));

    const presented = await composer.composeAnswer(session, "Question?", undefined, undefined);

    expect(presented.metadata?.directiveAdherence).toEqual([
      { directive: "Be concise", ruleId: "d1", satisfied: true, note: "kept the answer concise" },
    ]);
    expect(responseFormats()).toEqual([
      buildGroundedAnswerResponseFormat(
        createDirectiveAdherenceSideChannel(session.directiveSteering?.rules ?? []).schemaExtension(),
      ),
    ]);
  });

  it("lets retrieval evidence answer even when turn planning marks the request outside scope", async () => {
    const session = baseSession();
    session.agent.chatModelOverride = { provider: "openai", model: "gpt-5-nano" };
    session.turnFraming = { outsideScopeRequest: "Calculate sqrt(5).", isIdentityQuestion: false };
    const { composer, counts, fallbackWorkspaceContext } = buildComposer(groundedV2Envelope());

    const presented = await composer.composeAnswer(session, "sqrt(5)", undefined, undefined);

    expect(presented.answer).toBe(GROUNDED_V2_VISIBLE);
    expect(presented.skillOutcome).toBe("grounded");
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 0 });
    expect(fallbackWorkspaceContext()).toBeUndefined();
  });

  const cases = [
    { name: "grounded", raw: groundedV2Envelope(), answer: GROUNDED_V2_VISIBLE, verdict: "grounded", outcome: "grounded", citations: 3 },
    { name: "partial", raw: degradedV2Envelope(), answer: DEGRADED_V2_VISIBLE, verdict: "degraded", outcome: "grounded_degraded", citations: 1 },
    { name: "no support", raw: noSupportV2Envelope(), answer: NO_SUPPORT_V2_BODY, verdict: "no_support", outcome: "no_context", citations: 0 },
    { name: "malformed", raw: `Visible malformed answer.\n${SUGGESTIONS_SENTINEL}\n{bad`, answer: "Visible malformed answer.", verdict: "degraded", outcome: "grounded_degraded", citations: 0 },
    { name: "anchor free", raw: `Visible anchor-free answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ v: 2, outcome: "answer", claims: [[1]], suggestions: [], grounding: "degraded" })}`, answer: "FOCUSED GROUNDED MISS", verdict: "no_support", outcome: "no_context", citations: 0 },
  ] as const;

  for (const testCase of cases) {
    it(`uses the expected non-streaming generations for ${testCase.name}`, async () => {
      const { composer, counts, attemptKeys } = buildComposer(testCase.raw);
      const presented = await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

      expect(presented.answer).toBe(testCase.answer);
      expect(presented.grounding).toBe(testCase.verdict);
      expect(presented.skillOutcome).toBe(testCase.outcome);
      expect(presented.citations ?? []).toHaveLength(testCase.citations);
      const suppressed = testCase.name === "anchor free";
      expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: suppressed ? 1 : 0 });
      expect(attemptKeys).toEqual(suppressed ? ["grounded", "unsupported_answer"] : ["grounded"]);
      expect(attemptKeys).not.toContain("grounded_unsupported");
    });

    it(`uses the expected streaming generations for ${testCase.name}`, async () => {
      const { composer, counts, attemptKeys } = buildComposer(testCase.raw);
      const { chunks, result } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));

      expect(result.finalPresentation.answer).toBe(testCase.answer);
      expect(result.finalPresentation.grounding).toBe(testCase.verdict);
      expect(result.finalPresentation.skillOutcome).toBe(testCase.outcome);
      expect(result.finalPresentation.citations ?? []).toHaveLength(testCase.citations);
      expect(chunks.join("")).not.toContain("RADIOSO_FOLLOWUPS_JSON");
      expect(chunks.join("")).not.toContain("[[");
      const suppressed = testCase.name === "anchor free";
      expect(counts()).toEqual({ answerCalls: 0, streamCalls: 1, fallbackCalls: suppressed ? 1 : 0 });
      expect(attemptKeys).toEqual(suppressed
        ? ["stream_grounded", "stream_unsupported_answer"]
        : ["stream_grounded"]);
      expect(attemptKeys).not.toContain("stream_grounded_unsupported");
    });
  }

  it("opens the stream gate only for a complete in-range sourced assertion", async () => {
    for (const marker of ["[[?]]", "[[0]]", "[[999]]", "[[bad]]"]) {
      const raw = `Held${marker}.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ v: 2, outcome: "answer", claims: [[]], suggestions: [] })}`;
      const { composer } = buildComposer(raw);
      const { chunks } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));
      expect(chunks, marker).toEqual([]);
    }

    const { composer } = buildComposer(groundedV2Envelope());
    const { chunks } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("admits an assertion completed exactly at the 4,096-code-point boundary", async () => {
    const assertion = "claim[[1]]";
    const body = `${"x".repeat(RETRIEVAL_BEHAVIOR.groundingStreamGateMaxRetainedCodePoints - assertion.length)}${assertion}`;
    const raw = `${body}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({
      v: 2,
      outcome: "answer",
      claims: [[1]],
      suggestions: [],
      grounding: "grounded",
    })}`;
    const { composer, gateAbortObserved } = buildComposer(raw);

    const { chunks, result } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));

    expect(chunks.join("").length).toBeGreaterThan(4_000);
    expect(result.finalPresentation.answer).toContain("claim");
    expect(gateAbortObserved()).toBe(false);
  });

  it("abandons an anchor-free candidate at the cap, aborts upstream, and returns only a focused decline", async () => {
    const privateDraft = "PRIVATE DOCUMENT DRAFT ".repeat(300);
    const { composer, counts, metricWrites, gateAbortObserved, fallbackWorkspaceContext } = buildComposer(privateDraft);
    const session = baseSession();
    session.agent.chatModelOverride = { provider: "openai", model: "agent-override" };

    const { chunks, result } = await drain(composer.streamAnswer(session, "Question?", undefined, undefined));

    expect(chunks).toEqual([]);
    expect(result.finalPresentation.answer).toBe("FOCUSED GROUNDED MISS");
    expect(result.deliveryMode).toBe("bounded_decline");
    expect(result.traceMetrics).toMatchObject({ groundingGateWaitMs: expect.any(Number) });
    expect(JSON.stringify(result)).not.toContain("PRIVATE DOCUMENT DRAFT");
    expect(gateAbortObserved()).toBe(true);
    expect(counts()).toEqual({ answerCalls: 0, streamCalls: 1, fallbackCalls: 1 });
    expect(fallbackWorkspaceContext()).toEqual({ workspaceId: "workspace-1" });
    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "no_support", reason: "gate_bound", stream: "true", decline: "content_gap" },
    }]);
  });

  it("aborts upstream and exposes no prefix when superseded while the gate is held", async () => {
    const controller = new AbortController();
    const superseded = new Error("superseded_while_grounding_held");
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let providerAbortObserved = false;
    const gateway: ChatGateway = {
      async answer() { return "unused"; },
      async *streamAnswer(input) {
        providerStarted();
        try {
          yield "PRIVATE UNSUPPORTED PREFIX";
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
          });
        } finally {
          providerAbortObserved = input.signal?.aborted ?? false;
        }
      },
    };
    const composer = new RetrievalAnswerComposer(
      new ChatAnswerSupport(),
      gateway,
      presenter(),
      { async composeNoContext() { return { text: "must not run", declineReason: "content_gap" as const }; } },
    );
    const pending = drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined, controller.signal));

    await started;
    controller.abort(superseded);

    await expect(pending).rejects.toBe(superseded);
    expect(providerAbortObserved).toBe(true);
  });

  it("lets supersession win between a cap trip and the focused decline", async () => {
    const controller = new AbortController();
    const superseded = new Error("superseded_before_decline");
    let declineStarted!: () => void;
    let releaseDecline!: () => void;
    const started = new Promise<void>((resolve) => { declineStarted = resolve; });
    const blockedDecline = new Promise<void>((resolve) => { releaseDecline = resolve; });
    const gateway: ChatGateway = {
      async answer() { return "unused"; },
      async *streamAnswer() { yield "PRIVATE ".repeat(1_000); },
    };
    const fallback: FallbackReplyComposer = {
      async composeNoContext(input) {
        declineStarted();
        expect(input.signal).toBe(controller.signal);
        await blockedDecline;
        return { text: "DECLINE", declineReason: "content_gap" as const };
      },
    };
    const composer = new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter(), fallback);
    const pending = drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined, controller.signal));

    await started;
    controller.abort(superseded);
    releaseDecline();

    await expect(pending).rejects.toBe(superseded);
  });

  it("emits one bounded, content-free outcome counter", async () => {
    const { composer, metricWrites } = buildComposer(degradedV2Envelope());
    await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "degraded", reason: "unsourced", stream: "false", decline: "none" },
    }]);
    expect(JSON.stringify(metricWrites)).not.toContain("workshop");
  });

  it("records unsupported_answer while suppressing the anchor-free presentation", async () => {
    const raw = `Unsupported draft.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({
      v: 2,
      outcome: "answer",
      claims: [],
      suggestions: [],
      grounding: "degraded",
    })}`;
    const { composer, counts, metricWrites } = buildComposer(raw);

    const presented = await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

    expect(presented.answer).toBe("FOCUSED GROUNDED MISS");
    expect(presented.skillOutcome).toBe("no_context");
    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "no_support", reason: "unsupported_answer", stream: "false", decline: "content_gap" },
    }]);
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 1 });
  });

  it("uses the grounded-miss static asset when focused decline composition returns it", async () => {
    const raw = `Unsupported draft.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({
      v: 2,
      outcome: "answer",
      claims: [],
      suggestions: [],
      grounding: "degraded",
    })}`;
    const { composer, counts, attemptKeys } = buildComposer(raw, getGroundedMissFallback());

    const presented = await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

    expect(presented.answer).toBe(getGroundedMissFallback());
    expect(presented.skillOutcome).toBe("no_context");
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 1 });
    expect(attemptKeys).toEqual(["grounded", "unsupported_answer"]);
  });

  it("does not start a second semantic call after a blank page-context generation", async () => {
    const session = baseSession();
    session.resolvedContext.renderFragments = [{
      kind: "page_context",
      pageUrl: "https://example.test/workshop",
      content: "Workshop page",
    }];
    const { composer, counts } = buildComposer("   ");

    await expect(composer.composeAnswer(session, "Question?", undefined, undefined)).rejects.toMatchObject({
      name: "BlankChatAnswerError",
    });
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 0 });
  });

  it("does not label a successful page-context answer as a grounding gap when workspace retrieval is empty", async () => {
    const session = baseSession();
    (session.retrieval as { contexts: unknown[] }).contexts = [];
    session.resolvedContext.renderFragments = [{
      kind: "page_context",
      pageUrl: "https://example.test/workshop",
      content: "The workshop begins in June.",
    }];
    const { composer, counts } = buildComposer(degradedV2Envelope());

    const presented = await composer.composeAnswer(session, "When does the workshop begin?", undefined, undefined);

    expect(presented.answer).toBe(DEGRADED_V2_VISIBLE);
    expect(presented.skillOutcome).toBe("grounded_degraded");
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 0 });
  });
});
