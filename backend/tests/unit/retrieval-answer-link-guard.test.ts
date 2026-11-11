import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { ComposedDecline, FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import { formatV2Envelope } from "../support/answerEnvelopeV2Fixtures.js";

const COURSE_URL = "https://school.example/courses/breath";
const CONTACT_URL = "https://school.example/contact";

const groundedEnvelope = (body: string): string =>
  formatV2Envelope(body, {
    v: 2,
    coverage: "answered_sufficient_evidence",
    requestFocus: "the residential courses",
    outcome: "answer",
    claims: [[1], [2]],
    suggestions: [],
    grounding: "grounded",
  });

// The course page carries a Source URL; the silence course has a page with none.
const ANSWER_BODY =
  `Join [Il respiro consapevole](${COURSE_URL})[[1]] in November, or [Il silenzio del cuore](#)[[2]] in October.`;
const VISIBLE_ANSWER =
  `Join [Il respiro consapevole](${COURSE_URL}) in November, or Il silenzio del cuore in October.`;

const session = (): PreparedSession => ({
  agent: { workspaceId: "workspace-1", chatModelOverride: null } as never,
  conversation: { id: "conversation-1", workspaceId: "workspace-1" } as never,
  history: [],
  userMessage: { id: "message-1", content: "Which residential courses run this autumn?" } as never,
  turnRoute: "retrieval",
  pageContext: null,
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  directiveSteering: { rules: [], matches: [], omissions: [] },
  retrieval: {
    systemPrompt: `Speak for the school. Visitors with questions write through ${CONTACT_URL}.`,
    prompt: [
      `Result 1 (Il respiro consapevole): Source: ${COURSE_URL}`,
      "Three days of breath work in November.",
      "",
      "Result 2 (Il silenzio del cuore): A silent retreat in October.",
    ].join("\n"),
    responseIdentity: null,
    responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0 },
    diagnostics: {},
    contexts: [1, 2].map((index) => ({
      documentId: `doc-${index}`,
      chunkId: `chunk-${index}`,
      title: `Course ${index}`,
      content: `Course evidence ${index}`,
    })),
  } as unknown as RetrievalPipelineResult,
}) as unknown as PreparedSession;

const zeroContextSession = (): PreparedSession => {
  const zero = session();
  (zero.retrieval as { contexts: unknown[] }).contexts = [];
  return zero;
};

const buildComposer = (raw: string, decline: ComposedDecline = { text: "unused", declineReason: "content_gap" }) => {
  const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];
  const gateway: ChatGateway = {
    async answer() {
      return raw;
    },
    async *streamAnswer() {
      for (let offset = 0; offset < raw.length; offset += 5) {
        yield raw.slice(offset, offset + 5);
      }
    },
  };
  const fallback: FallbackReplyComposer = {
    async composeNoContext() {
      return decline;
    },
  };
  const presenter = new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
    supportsGroundedAnswer: () => true,
  });
  return {
    composer: new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter, fallback, {
      incrementCounter(name, options) {
        metricWrites.push({ name, labels: options.labels });
      },
    }),
    unwrappedLinkWrites: () => metricWrites.filter((write) => write.name === "chat_answer_links_unwrapped_total"),
  };
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

describe("retrieval answer links", () => {
  it("shows a link to an address the model was not given as plain text", async () => {
    const { composer, unwrappedLinkWrites } = buildComposer(groundedEnvelope(ANSWER_BODY));

    const presented = await composer.composeAnswer(session(), "Which courses?", undefined, undefined);

    expect(presented.answer).toBe(VISIBLE_ANSWER);
    expect(unwrappedLinkWrites()).toEqual([
      { name: "chat_answer_links_unwrapped_total", labels: { reason: "fragment", stream: "false" } },
    ]);
  });

  it("never streams a link the model was not given, and streams what the answer finally shows", async () => {
    const { composer, unwrappedLinkWrites } = buildComposer(groundedEnvelope(ANSWER_BODY));

    const { chunks, result } = await drain(composer.streamAnswer(session(), "Which courses?", undefined, undefined));

    expect(chunks.join("")).toBe(VISIBLE_ANSWER);
    expect(chunks.some((chunk) => chunk.includes("](#"))).toBe(false);
    expect(result.hasStreamedAnswer).toBe(true);
    expect(result.finalPresentation.answer).toBe(VISIBLE_ANSWER);
    expect(result.traceMetrics).toMatchObject({ unwrappedLinkCount: 1 });
    expect(unwrappedLinkWrites()).toEqual([
      { name: "chat_answer_links_unwrapped_total", labels: { reason: "fragment", stream: "true" } },
    ]);
  });

  it("records no link count when every link was given", async () => {
    const { composer, unwrappedLinkWrites } = buildComposer(
      groundedEnvelope(`Join [Il respiro consapevole](${COURSE_URL})[[1]], or ask us [here](${CONTACT_URL})[[?]].`),
    );

    const presented = await composer.composeAnswer(session(), "Which courses?", undefined, undefined);

    expect(presented.answer).toBe(`Join [Il respiro consapevole](${COURSE_URL}), or ask us [here](${CONTACT_URL}).`);
    expect(unwrappedLinkWrites()).toEqual([]);
  });

  it("keeps a link to the visitor's page and unwraps an invented one in a page answer", async () => {
    const pageSession = zeroContextSession();
    pageSession.resolvedContext.renderFragments = [{
      kind: "page_context",
      pageUrl: "https://school.example/autumn",
      content: "Il respiro consapevole runs in November.",
    }];
    const { composer } = buildComposer(groundedEnvelope(
      "[This page](https://school.example/autumn)[[?]] lists [Il respiro consapevole](https://school.example/breath)[[?]].",
    ));

    const { chunks, result } = await drain(composer.streamAnswer(pageSession, "What's on?", undefined, undefined));

    const visible = "[This page](https://school.example/autumn) lists Il respiro consapevole.";
    expect(chunks.join("")).toBe(visible);
    expect(result.finalPresentation.answer).toBe(visible);
  });

  it("guards a composed decline against the turn's prompt", async () => {
    const { composer } = buildComposer("unused", {
      text: `That course isn't on our calendar. Write to us through [our contact page](${CONTACT_URL}) or [Booking](Booking).`,
      declineReason: "content_gap",
    });

    const presented = await composer.composeAnswer(zeroContextSession(), "Silence course?", undefined, undefined);

    expect(presented.answer).toBe(
      `That course isn't on our calendar. Write to us through [our contact page](${CONTACT_URL}) or Booking.`,
    );
  });
});
