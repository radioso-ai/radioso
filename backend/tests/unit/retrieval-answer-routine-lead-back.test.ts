import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer, FallbackReplyInput } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";

/**
 * A routine that yielded the turn stays parked on a step, and the answer to the visitor's
 * digression closes by pointing back to it (#1377) — unless the turn hands the visitor to a
 * person, which on an agent set to hand retrieval misses over is a `no_support` decline.
 */
const pendingStep = {
  stepId: "ask_email",
  instruction: "Ask for a work email to send the calendar invite to: [email]",
  missingSlotKeys: ["email"],
};

const LEAD_BACK = "Which work email should I send the invite to?";
const DECLINE = "I can't confirm parking from what I have.";
const COMPOSED_DECLINE = "Our team will pick this up with you.";

// The provider's JSON envelope, head first, as the model returns it.
const envelope = (outcome: "answer" | "no_support", body: string): string =>
  JSON.stringify({
    coverage: outcome === "answer" ? "answered_sufficient_evidence" : "unanswered_insufficient_evidence",
    requestFocus: "parking at the office",
    outcome,
    answer: body,
    v: 2,
    claims: outcome === "answer" ? [[1]] : [],
    suggestions: [],
    grounding: "degraded",
  });

const session = (input: { handoffOnRetrievalMiss: boolean; yielded?: boolean; contexts?: number }): PreparedSession => ({
  agent: { workspaceId: "workspace-1", chatModelOverride: null, handoffOnRetrievalMiss: input.handoffOnRetrievalMiss },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  history: [],
  userMessage: { id: "message-1", content: "Is there parking?" },
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
    contexts: Array.from({ length: input.contexts ?? 1 }, (_, index) => ({
      documentId: `doc-${index}`,
      chunkId: `chunk-${index}`,
      title: "Office",
      content: "The office is on the third floor.",
    })),
  } as unknown as RetrievalPipelineResult,
  ...(input.yielded === false ? {} : { routineYield: { sessionId: "conversation-1", inputEventId: "message-1", routineId: "book-demo", pendingStep } }),
}) as unknown as PreparedSession;

const harness = (raw: string) => {
  const answerInputs: ChatGatewayInput[] = [];
  const declineInputs: FallbackReplyInput[] = [];
  const gateway: ChatGateway = {
    async answer(input) {
      answerInputs.push(input);
      return raw;
    },
    async *streamAnswer(input) {
      answerInputs.push(input);
      for (let offset = 0; offset < raw.length; offset += 7) {
        yield raw.slice(offset, offset + 7);
      }
    },
  };
  const fallback: FallbackReplyComposer = {
    async composeNoContext(input) {
      declineInputs.push(input);
      return { text: COMPOSED_DECLINE, declineReason: "content_gap" };
    },
  };
  const presenter = new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
    supportsGroundedAnswer: () => true,
  });
  return {
    composer: new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter, fallback),
    answerInputs,
    declineInputs,
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

describe("RetrievalAnswerComposer lead-back to a parked routine (#1377)", () => {
  it("closes the grounded answer's prompt with the pending step only when a routine yielded", async () => {
    const parked = harness(envelope("answer", `There is free parking[[1]]. ${LEAD_BACK}`));
    await parked.composer.composeAnswer(session({ handoffOnRetrievalMiss: false }), "Is there parking?", undefined, undefined);
    const unparked = harness(envelope("answer", "There is free parking[[1]]."));
    await unparked.composer.composeAnswer(
      session({ handoffOnRetrievalMiss: false, yielded: false }),
      "Is there parking?",
      undefined,
      undefined,
    );

    expect(parked.answerInputs[0]?.systemPrompt).toContain(`- ${pendingStep.instruction}`);
    expect(unparked.answerInputs[0]?.systemPrompt).not.toContain(pendingStep.instruction);
  });

  it("keeps a declining draft's lead-back when the decline does not hand the visitor over", async () => {
    const { composer, declineInputs } = harness(envelope("no_support", `${DECLINE} ${LEAD_BACK}`));

    const presented = await composer.composeAnswer(
      session({ handoffOnRetrievalMiss: false }),
      "Is there parking?",
      undefined,
      undefined,
    );

    expect(presented.answer).toBe(`${DECLINE} ${LEAD_BACK}`);
    expect(declineInputs).toEqual([]);
  });

  it("replaces a draft that declines into a hand-off with a composed decline that carries no lead-back", async () => {
    const { composer, declineInputs } = harness(envelope("no_support", `${DECLINE} ${LEAD_BACK}`));

    const presented = await composer.composeAnswer(
      session({ handoffOnRetrievalMiss: true }),
      "Is there parking?",
      undefined,
      undefined,
    );

    expect(presented.answer).toBe(COMPOSED_DECLINE);
    expect(presented.skillOutcome).toBe("no_context");
    expect(declineInputs).toHaveLength(1);
    expect(declineInputs[0]?.pendingRoutineStep).toBeUndefined();
  });

  it("streams none of a draft that declines into a hand-off, and commits the composed decline", async () => {
    const { composer, declineInputs } = harness(envelope("no_support", `${DECLINE} ${LEAD_BACK}`));

    const { chunks, result } = await drain(
      composer.streamAnswer(session({ handoffOnRetrievalMiss: true }), "Is there parking?", undefined, undefined),
    );

    expect(chunks.join("")).not.toContain(LEAD_BACK);
    expect(chunks.join("")).not.toContain(DECLINE);
    expect(result.hasStreamedAnswer).toBe(false);
    expect(result.finalPresentation.answer).toBe(COMPOSED_DECLINE);
    expect(result.finalPresentation.skillOutcome).toBe("no_context");
    expect(declineInputs[0]?.pendingRoutineStep).toBeUndefined();
  });

  it("keeps a hand-off agent's grounded answer and its lead-back", async () => {
    const { composer, declineInputs } = harness(envelope("answer", `There is free parking[[1]]. ${LEAD_BACK}`));

    const { result } = await drain(
      composer.streamAnswer(session({ handoffOnRetrievalMiss: true }), "Is there parking?", undefined, undefined),
    );

    expect(result.finalPresentation.answer).toContain(LEAD_BACK);
    expect(declineInputs).toEqual([]);
  });

  it.each([false, true])(
    "gives a composed decline the lead-back only when it does not hand the visitor over (hand-off agent: %s)",
    async (handoffOnRetrievalMiss) => {
      // No retrieved context and no page to answer from: the turn declines through the
      // composed decline.
      const { composer, declineInputs } = harness("");

      await composer.composeAnswer(
        session({ handoffOnRetrievalMiss, contexts: 0 }),
        "Is there parking?",
        undefined,
        undefined,
      );

      expect(declineInputs).toHaveLength(1);
      expect(declineInputs[0]?.pendingRoutineStep).toEqual(handoffOnRetrievalMiss ? undefined : pendingStep);
    },
  );
});
