import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { getGroundedMissFallback } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  DEGRADED_V2_VISIBLE,
  GROUNDED_V2_VISIBLE,
  NO_SUPPORT_V2_BODY,
  degradedV2Envelope,
  groundedV2Envelope,
  noSupportV2Envelope,
} from "../support/answerEnvelopeV2Fixtures.js";

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

const buildComposer = (raw: string, decline = "FOCUSED GROUNDED MISS") => {
  let answerCalls = 0;
  let streamCalls = 0;
  let fallbackCalls = 0;
  const attemptKeys: string[] = [];
  const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];
  let gateAbortObserved = false;
  const gateway: ChatGateway = {
    async answer(input) {
      answerCalls += 1;
      attemptKeys.push(input.usageContext.attemptKey);
      return raw;
    },
    async *streamAnswer(input) {
      streamCalls += 1;
      attemptKeys.push(input.usageContext.attemptKey);
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
      attemptKeys.push(input.usageContext.attemptKey);
      return decline;
    },
  };
  return {
    composer: new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter(), fallback, {
      incrementCounter(name, options) {
        metricWrites.push({ name, labels: options.labels });
      },
    }),
    counts: () => ({ answerCalls, streamCalls, fallbackCalls }),
    attemptKeys,
    metricWrites,
    gateAbortObserved: () => gateAbortObserved,
  };
};

describe("retrieval answer envelope v2", () => {
  const cases = [
    { name: "grounded", raw: groundedV2Envelope(), answer: GROUNDED_V2_VISIBLE, verdict: "grounded", outcome: "grounded", citations: 3, suppressed: false },
    { name: "partial", raw: degradedV2Envelope(), answer: DEGRADED_V2_VISIBLE, verdict: "degraded", outcome: "grounded_degraded", citations: 1, suppressed: false },
    { name: "no support", raw: noSupportV2Envelope(), answer: NO_SUPPORT_V2_BODY, verdict: "no_support", outcome: "no_context", citations: 0, suppressed: false },
    { name: "malformed", raw: `Visible malformed answer.\n${SUGGESTIONS_SENTINEL}\n{bad`, answer: "FOCUSED GROUNDED MISS", verdict: "degraded", outcome: "no_context", citations: 0, suppressed: true },
    { name: "anchor free", raw: `Visible anchor-free answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ v: 2, outcome: "answer", claims: [[1]], suggestions: [], grounding: "degraded" })}`, answer: "FOCUSED GROUNDED MISS", verdict: "degraded", outcome: "no_context", citations: 0, suppressed: true },
  ] as const;

  for (const testCase of cases) {
    it(`uses the expected non-streaming generations for ${testCase.name}`, async () => {
      const { composer, counts, attemptKeys } = buildComposer(testCase.raw);
      const presented = await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

      expect(presented.answer).toBe(testCase.answer);
      expect(presented.grounding).toBe(testCase.verdict);
      expect(presented.skillOutcome).toBe(testCase.outcome);
      expect(presented.citations ?? []).toHaveLength(testCase.citations);
      expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: testCase.suppressed ? 1 : 0 });
      expect(attemptKeys).toEqual(testCase.suppressed
        ? ["grounded", "grounded_suppressed_decline"]
        : ["grounded"]);
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
      expect(counts()).toEqual({ answerCalls: 0, streamCalls: 1, fallbackCalls: testCase.suppressed ? 1 : 0 });
      expect(attemptKeys).toEqual(testCase.suppressed
        ? ["stream_grounded", "grounded_suppressed_decline"]
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
    const { composer, counts, metricWrites, gateAbortObserved } = buildComposer(privateDraft);

    const { chunks, result } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));

    expect(chunks).toEqual([]);
    expect(result.finalPresentation.answer).toBe("FOCUSED GROUNDED MISS");
    expect(result.deliveryMode).toBe("bounded_decline");
    expect(result.traceMetrics).toMatchObject({ groundingGateWaitMs: expect.any(Number) });
    expect(JSON.stringify(result)).not.toContain("PRIVATE DOCUMENT DRAFT");
    expect(gateAbortObserved()).toBe(true);
    expect(counts()).toEqual({ answerCalls: 0, streamCalls: 1, fallbackCalls: 1 });
    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "no_support", reason: "gate_bound", stream: "true" },
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
      { async composeNoContext() { return "must not run"; } },
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
        return "DECLINE";
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
      labels: { protocol: "v2", verdict: "degraded", reason: "unsourced", stream: "false" },
    }]);
    expect(JSON.stringify(metricWrites)).not.toContain("workshop");
  });

  it("records anchor_free while suppressing the unsupported presentation", async () => {
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
    expect(presented.groundingSummary).toMatchObject({ verdict: "degraded", sourcedClaimCount: 0 });
    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "degraded", reason: "anchor_free", stream: "false" },
    }]);
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 1 });
  });

  it("presents the static asset only when the focused decline composer returns its failure fallback", async () => {
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
    expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 1 });
    expect(attemptKeys).toEqual(["grounded", "grounded_suppressed_decline"]);
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
});
