import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
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

const buildComposer = (raw: string) => {
  let answerCalls = 0;
  let streamCalls = 0;
  let fallbackCalls = 0;
  const attemptKeys: string[] = [];
  const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];
  const gateway: ChatGateway = {
    async answer(input) {
      answerCalls += 1;
      attemptKeys.push(input.usageContext.attemptKey);
      return raw;
    },
    async *streamAnswer(input) {
      streamCalls += 1;
      attemptKeys.push(input.usageContext.attemptKey);
      for (let offset = 0; offset < raw.length; offset += 7) {
        yield raw.slice(offset, offset + 7);
      }
    },
  };
  const fallback: FallbackReplyComposer = {
    async composeNoContext() {
      fallbackCalls += 1;
      return "STATIC FALLBACK";
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
  };
};

describe("retrieval answer envelope v2", () => {
  const cases = [
    { name: "grounded", raw: groundedV2Envelope(), answer: GROUNDED_V2_VISIBLE, verdict: "grounded", outcome: "grounded", citations: 3 },
    { name: "partial", raw: degradedV2Envelope(), answer: DEGRADED_V2_VISIBLE, verdict: "degraded", outcome: "grounded_degraded", citations: 1 },
    { name: "no support", raw: noSupportV2Envelope(), answer: NO_SUPPORT_V2_BODY, verdict: "no_support", outcome: "no_context", citations: 0 },
    { name: "malformed", raw: `Visible malformed answer.\n${SUGGESTIONS_SENTINEL}\n{bad`, answer: "Visible malformed answer.", verdict: "degraded", outcome: "grounded_degraded", citations: 0 },
    { name: "anchor free", raw: `Visible anchor-free answer.\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ v: 2, outcome: "answer", claims: [[1]], suggestions: [], grounding: "degraded" })}`, answer: "Visible anchor-free answer.", verdict: "degraded", outcome: "grounded_degraded", citations: 0 },
  ] as const;

  for (const testCase of cases) {
    it(`uses one non-streaming generation and no fallback for ${testCase.name}`, async () => {
      const { composer, counts, attemptKeys } = buildComposer(testCase.raw);
      const presented = await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

      expect(presented.answer).toBe(testCase.answer);
      expect(presented.grounding).toBe(testCase.verdict);
      expect(presented.skillOutcome).toBe(testCase.outcome);
      expect(presented.citations ?? []).toHaveLength(testCase.citations);
      expect(counts()).toEqual({ answerCalls: 1, streamCalls: 0, fallbackCalls: 0 });
      expect(attemptKeys).toEqual(["grounded"]);
      expect(attemptKeys).not.toContain("grounded_unsupported");
    });

    it(`uses one streaming generation and no fallback for ${testCase.name}`, async () => {
      const { composer, counts, attemptKeys } = buildComposer(testCase.raw);
      const { chunks, result } = await drain(composer.streamAnswer(baseSession(), "Question?", undefined, undefined));

      expect(result.finalPresentation.answer).toBe(testCase.answer);
      expect(result.finalPresentation.grounding).toBe(testCase.verdict);
      expect(result.finalPresentation.skillOutcome).toBe(testCase.outcome);
      expect(result.finalPresentation.citations ?? []).toHaveLength(testCase.citations);
      expect(chunks.join("")).not.toContain("RADIOSO_FOLLOWUPS_JSON");
      expect(chunks.join("")).not.toContain("[[");
      expect(counts()).toEqual({ answerCalls: 0, streamCalls: 1, fallbackCalls: 0 });
      expect(attemptKeys).toEqual(["stream_grounded"]);
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

  it("emits one bounded, content-free outcome counter", async () => {
    const { composer, metricWrites } = buildComposer(degradedV2Envelope());
    await composer.composeAnswer(baseSession(), "Question?", undefined, undefined);

    expect(metricWrites).toEqual([{
      name: "chat_grounding_assertion_outcomes_total",
      labels: { protocol: "v2", verdict: "degraded", reason: "unsourced", stream: "false" },
    }]);
    expect(JSON.stringify(metricWrites)).not.toContain("workshop");
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
