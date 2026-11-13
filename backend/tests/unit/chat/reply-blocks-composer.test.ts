import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../../src/modules/chat/contracts/chatGateway.js";
import type { RetrievalCoverageVerdictSink } from "../../../src/modules/chat/contracts/answerCoverage.js";
import type { ReplyImageUrls } from "../../../src/modules/chat/contracts/replyBlocks.js";
import { AssistantSuggestionExpansionService } from "../../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../../src/modules/chat/services/fallbackReplyComposer.js";
import { ReplyBlockTurnFactory } from "../../../src/modules/chat/services/replyBlocks/replyBlockTurn.js";
import { RetrievalAnswerComposer } from "../../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../../src/modules/chat/services/turnOutcome.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";
import { createDirectiveAdherenceSideChannel } from "../../../src/shared/domain/directiveAdherence.js";
import type { EvidenceItemImages, RetrievalPipelineResult } from "../../../src/modules/retrieval/public.js";

const context = (index: number) => ({
  documentId: `doc-${index}`,
  chunkId: `chunk-${index}`,
  title: `Field Guide ${index}`,
  content: `Trail notes ${index}`,
  metadata: { sourceUrl: `https://shop.example/books/guide-${index}` },
});

const session = (): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", chatModelOverride: null, replyCardsEnabled: true } as never,
  conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "website_embed" } as never,
  history: [],
  userMessage: { id: "message-1", content: "Which hiking guides do you have?" } as never,
  effectiveQuery: "Which hiking guides do you have?",
  turnRoute: "retrieval",
  pageContext: null,
  replyBlocks: { item_list: { layouts: ["carousel", "grid"] } },
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  directiveSteering: { rules: [], matches: [], omissions: [] },
  retrieval: {
    systemPrompt: "system",
    prompt: "Result 1 (Field Guide 1): Trail notes 1\n\nResult 2 (Field Guide 2): Trail notes 2",
    responseIdentity: null,
    responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0, citationHoldEnabled: true },
    diagnostics: {},
    contexts: [context(1), context(2)],
  } as unknown as RetrievalPipelineResult,
}) as unknown as PreparedSession;

const evidence: EvidenceItemImages[] = [1, 2].map((index) => ({
  resultNumber: index,
  documentId: `doc-${index}`,
  documentTitle: `Field Guide ${index}`,
  sourceUrl: `https://shop.example/books/guide-${index}`,
  images: [{ imageId: `cover-${index}`, role: "primary", alt: "", caption: null, width: 1280, height: 960, sha256: `sha-${index}` }],
}));

// In schema order: `present` is a head field, written before `answer`.
const envelope = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  coverage: "answered_sufficient_evidence",
  requestFocus: "hiking guides",
  outcome: "answer",
  adherencePlan: [],
  present: { images: ["m2", "m1"], caption: "Two hiking guides" },
  answer: "We carry two hiking guides[[1]][[2]].",
  v: 2,
  claims: [[1], [2]],
  suggestions: [],
  grounding: "degraded",
  adherence: [],
  ...overrides,
});

const urls: ReplyImageUrls = {
  forImage: (imageId) => ({ src: `https://app.example/i/${imageId}/640`, srcSet: `https://app.example/i/${imageId}/320 320w` }),
};

const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];

const buildComposer = (raw: string, evidenceImages: EvidenceItemImages[] = evidence) => {
  const inputs: ChatGatewayInput[] = [];
  const gateway: ChatGateway = {
    async answer(input) {
      inputs.push(input);
      return raw;
    },
    async *streamAnswer(input) {
      inputs.push(input);
      for (let offset = 0; offset < raw.length; offset += 11) {
        yield raw.slice(offset, offset + 11);
      }
    },
  };
  const fallback: FallbackReplyComposer = {
    async composeNoContext() {
      return { text: "FOCUSED DECLINE", declineReason: "content_gap" };
    },
  };
  const composer = new RetrievalAnswerComposer(
    new ChatAnswerSupport(),
    gateway,
    new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, { supportsGroundedAnswer: () => true }),
    fallback,
    null,
    { forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules) },
    new ReplyBlockTurnFactory({
      evidenceImages: { attach: async () => evidenceImages },
      imageUrls: urls,
      metrics: { incrementCounter: (name, options) => metricWrites.push({ name, labels: options.labels }) },
    }),
  );
  return { composer, inputs };
};

const drain = async (generator: AsyncGenerator<string, TurnStreamResult>): Promise<TurnStreamResult> => {
  let step = await generator.next();
  while (!step.done) {
    step = await generator.next();
  }
  return step.value;
};

const yieldingSink: RetrievalCoverageVerdictSink = { report: async () => ({ decision: "yield_turn" }) };

const expectedStored = {
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "none",
  caption: "Two hiking guides",
  items: [2, 1].map((index) => ({
    key: `cover-${index}`,
    title: `Field Guide ${index}`,
    image: { imageId: `cover-${index}`, width: 1280, height: 960, alt: "" },
    actions: [{ type: "open", url: `https://shop.example/books/guide-${index}` }],
    document: { id: `doc-${index}`, title: `Field Guide ${index}` },
  })),
};

describe("reply blocks on the grounded answer", () => {
  it("offers the present head and returns the block the model picked, without streaming", async () => {
    const { composer, inputs } = buildComposer(envelope());

    const presented = await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);

    expect(presented.answer).toBe("We carry two hiking guides.");
    expect(presented.replyBlocks?.stored).toEqual([expectedStored]);
    expect(presented.replyBlocks?.presented[0]?.items[0]?.image).toEqual({
      src: "https://app.example/i/cover-2/640",
      srcSet: "https://app.example/i/cover-2/320 320w",
      width: 1280,
      height: 960,
      alt: "",
    });
    const [input] = inputs;
    const schema = input?.generation?.responseFormat?.schema as { properties: Record<string, unknown>; required: string[] };
    const head = ["coverage", "requestFocus", "outcome", "adherencePlan", "present", "answer"];
    expect(Object.keys(schema.properties).slice(0, head.length)).toEqual(head);
    expect(schema.required.slice(0, head.length)).toEqual(head);
    expect(input?.prompt).toContain("Result images");
    expect(input?.prompt).toContain("Result 1: [m1] main picture");
    expect(input?.systemPrompt).toContain("`present`");
    expect(input?.systemPrompt).toContain("A main picture is the Result's own picture");
  });

  it("returns the same block when streaming", async () => {
    const { composer } = buildComposer(envelope());

    const result = await drain(composer.streamAnswer(session(), "Which hiking guides do you have?", "en", undefined));

    expect(result.finalPresentation.answer).toBe("We carry two hiking guides.");
    expect(result.finalPresentation.replyBlocks?.stored).toEqual([expectedStored]);
  });

  it("counts the block it emits by layout and channel", async () => {
    metricWrites.length = 0;
    const { composer } = buildComposer(envelope({ present: { images: ["m1", "m9"], caption: "One guide" } }));

    await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);

    expect(metricWrites).toContainEqual({ name: "reply_blocks_emitted_total", labels: { layout: "carousel", channel: "website_embed", source: "evidence" } });
    expect(metricWrites).toContainEqual({ name: "reply_block_items_dropped_total", labels: { reason: "unknown_handle" } });
  });

  it("returns no block when the model picks none", async () => {
    const { composer } = buildComposer(envelope({ present: { images: [], caption: "None" } }));

    const presented = await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);

    expect(presented.replyBlocks).toBeUndefined();
  });

  it("returns no block on a blank decline", async () => {
    const raw = envelope({ outcome: "no_support", coverage: "unanswered_insufficient_evidence", answer: "", claims: [] });
    const { composer } = buildComposer(raw);

    const composed = await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);
    const streamed = await drain(composer.streamAnswer(session(), "Which hiking guides do you have?", "en", undefined));

    expect(composed.answer).toBe("FOCUSED DECLINE");
    expect(composed.replyBlocks).toBeUndefined();
    expect(streamed.finalPresentation.replyBlocks).toBeUndefined();
  });

  it("returns no block on an inline decline, even when the model picked pictures", async () => {
    for (const outcome of ["no_support", "out_of_scope"]) {
      const raw = envelope({
        coverage: outcome === "no_support" ? "unanswered_insufficient_evidence" : "unanswered_intentional_scope_boundary",
        outcome,
        answer: "I can't confirm that one, but I can help with our hiking guides.",
        claims: [],
      });
      const { composer } = buildComposer(raw);

      const composed = await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);
      const streamed = await drain(composer.streamAnswer(session(), "Which hiking guides do you have?", "en", undefined));

      expect(composed.answer).toBe("I can't confirm that one, but I can help with our hiking guides.");
      expect(composed.replyBlocks).toBeUndefined();
      expect(streamed.finalPresentation.answer).toBe("I can't confirm that one, but I can help with our hiking guides.");
      expect(streamed.finalPresentation.replyBlocks).toBeUndefined();
    }
  });

  it("returns no block when an unsupported draft is replaced by a decline", async () => {
    const raw = envelope({ answer: "We carry two hiking guides.", claims: [] });
    const { composer } = buildComposer(raw);

    const composed = await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);

    expect(composed.answer).toBe("FOCUSED DECLINE");
    expect(composed.replyBlocks).toBeUndefined();
  });

  it("returns no block on a yielded turn", async () => {
    const { composer } = buildComposer(envelope());

    const composed = await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined, yieldingSink);
    const streamed = await drain(composer.streamAnswer(session(), "Which hiking guides do you have?", "en", undefined, undefined, yieldingSink));

    expect(composed.yielded).toBe(true);
    expect(composed.replyBlocks).toBeUndefined();
    expect(streamed.finalPresentation.replyBlocks).toBeUndefined();
  });

  it("returns no block when the streamed draft hits the grounding gate's bound", async () => {
    const unanchored = "x".repeat(RETRIEVAL_BEHAVIOR.groundingStreamGateMaxRetainedCodePoints + 200);
    const { composer } = buildComposer(envelope({ answer: unanchored, claims: [] }));

    const streamed = await drain(composer.streamAnswer(session(), "Which hiking guides do you have?", "en", undefined));

    expect(streamed.deliveryMode).toBe("bounded_decline");
    expect(streamed.finalPresentation.replyBlocks).toBeUndefined();
  });

  it("keeps the reusable prompt prefix identical whether or not the present head is offered", async () => {
    const offered = buildComposer(envelope());
    const notOffered = buildComposer(envelope(), []);

    await offered.composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);
    await notOffered.composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);

    const [withPresent] = offered.inputs;
    const [withoutPresent] = notOffered.inputs;
    const pictures = "A main picture is the Result's own picture";
    expect(withPresent?.systemPrompt).toContain(pictures);
    expect(withoutPresent?.systemPrompt).not.toContain(pictures);
    expect(withPresent?.reusableInputBoundary?.stableSystemPrefix).toBeTruthy();
    expect(withPresent?.reusableInputBoundary?.stableSystemPrefix).toBe(withoutPresent?.reusableInputBoundary?.stableSystemPrefix);
    expect(withPresent?.reusableInputBoundary?.stableSystemPrefix).not.toContain(pictures);
    expect(withPresent?.reusableInputBoundary?.dynamicSystemSuffix).toContain(pictures);
    for (const input of [withPresent, withoutPresent]) {
      expect(input?.systemPrompt).toBe(`${input?.reusableInputBoundary?.stableSystemPrefix}${input?.reusableInputBoundary?.dynamicSystemSuffix}`);
    }
  });

  it("offers nothing on a turn whose evidence is empty", async () => {
    const { composer, inputs } = buildComposer(envelope());
    const empty = session();
    empty.retrieval = { ...empty.retrieval, contexts: [] };

    await composer.composeAnswer(empty, "Which hiking guides do you have?", "en", undefined);

    for (const input of inputs) {
      expect(input.prompt).not.toContain("Result images");
      expect(JSON.stringify(input.generation?.responseFormat)).not.toContain("\"present\"");
    }
  });
});
