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
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

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
  const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];
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
    composer: new RetrievalAnswerComposer(new ChatAnswerSupport(), gateway, presenter, fallback, {
      incrementCounter(name, options) {
        metricWrites.push({ name, labels: options.labels });
      },
    }),
    answerInputs,
    declineInputs,
    metricWrites,
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

const HANDOFF_FRAGMENT = loadPromptTemplate("chat/routine-lead-back-decline-handoff.md");

const groundedSystemPrompt = async (turnSession: PreparedSession): Promise<string> => {
  const { composer, answerInputs } = harness(envelope("answer", "There is free parking[[1]]."));
  await composer.composeAnswer(turnSession, "Is there parking?", undefined, undefined);
  return answerInputs[0]?.systemPrompt ?? "";
};

describe("RetrievalAnswerComposer lead-back to a parked routine (#1377)", () => {
  it("closes the grounded answer's prompt with the pending step only when a routine yielded", async () => {
    expect(await groundedSystemPrompt(session({ handoffOnRetrievalMiss: false }))).toContain(
      `- ${pendingStep.instruction}`,
    );
    expect(await groundedSystemPrompt(session({ handoffOnRetrievalMiss: false, yielded: false }))).not.toContain(
      pendingStep.instruction,
    );
  });

  it("tells the grounded answer to leave the lead-back out of a no_support decline only on a hand-off agent", async () => {
    expect(await groundedSystemPrompt(session({ handoffOnRetrievalMiss: true }))).toContain(HANDOFF_FRAGMENT);
    expect(await groundedSystemPrompt(session({ handoffOnRetrievalMiss: false }))).not.toContain(HANDOFF_FRAGMENT);
  });

  it("leaves a turn no routine yielded exactly as it was, hand-off agent or not", async () => {
    const handoff = await groundedSystemPrompt(session({ handoffOnRetrievalMiss: true, yielded: false }));
    const plain = await groundedSystemPrompt(session({ handoffOnRetrievalMiss: false, yielded: false }));

    expect(handoff).toBe(plain);
    expect(handoff).not.toContain(HANDOFF_FRAGMENT);
  });

  it.each([false, true])(
    "keeps a hand-off agent's declining draft and records its grounding outcome as usual (stream: %s)",
    async (stream) => {
      const draft = `${DECLINE} ${LEAD_BACK}`;
      const { composer, declineInputs, metricWrites } = harness(envelope("no_support", draft));
      const turnSession = session({ handoffOnRetrievalMiss: true });

      const answer = stream
        ? (await drain(composer.streamAnswer(turnSession, "Is there parking?", undefined, undefined))).result
          .finalPresentation.answer
        : (await composer.composeAnswer(turnSession, "Is there parking?", undefined, undefined)).answer;

      // The draft is the answer: the prompt, not the host, keeps a hand-off decline free of a lead-back.
      expect(answer).toBe(draft);
      expect(declineInputs).toEqual([]);
      expect(metricWrites).toContainEqual({
        name: "chat_grounding_assertion_outcomes_total",
        labels: expect.objectContaining({ verdict: "no_support", stream: String(stream) }),
      });
    },
  );

  it.each([false, true])(
    "gives a composed decline the lead-back only when it does not hand the visitor over (hand-off agent: %s)",
    async (handoffOnRetrievalMiss) => {
      // No retrieved context and no page to answer from: the turn declines through the
      // composed decline.
      const { composer, declineInputs } = harness("");

      const presented = await composer.composeAnswer(
        session({ handoffOnRetrievalMiss, contexts: 0 }),
        "Is there parking?",
        undefined,
        undefined,
      );

      expect(presented.answer).toBe(COMPOSED_DECLINE);
      expect(declineInputs).toHaveLength(1);
      expect(declineInputs[0]?.pendingRoutineStep).toEqual(handoffOnRetrievalMiss ? undefined : pendingStep);
    },
  );
});

