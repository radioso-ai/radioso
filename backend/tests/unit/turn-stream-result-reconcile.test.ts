import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { AssistantReplyComposer } from "../../src/modules/chat/services/assistantReplyComposer.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import { SOCIAL_REPLY_CONFIG } from "../../src/modules/chat/services/socialTurnSkill.js";
import type { TurnStreamResult } from "../../src/modules/chat/services/turnOutcome.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";

// These tests pin the structural split this slice introduces (#507): each turn
// skill owns its full post-stream reconcile, and `TurnStreamResult` carries the
// two roles the old `noContextPresentation` conflated — the final presentation
// override AND the question-suggestion source — independently.

const GROUNDED_MISS = "I couldn't find supporting material for that in your workspace documents.";

const fallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    return GROUNDED_MISS;
  },
};

const presenter = (): ChatAnswerPresenter =>
  new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
    supportsGroundedAnswer: () => true,
  });

const drain = async (
  generator: AsyncGenerator<string, TurnStreamResult>,
): Promise<{ chunks: string[]; result: TurnStreamResult }> => {
  const chunks: string[] = [];
  let step = await generator.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await generator.next();
  }
  return { chunks, result: step.value };
};

const baseSession = (
  retrieval: { contexts: unknown[] },
): PreparedSession =>
  ({
    agent: { workspaceId: "workspace-1", chatModelOverride: null } as never,
    conversation: { id: "conversation-1", workspaceId: "workspace-1" } as never,
    history: [],
    userMessage: { id: "message-1", content: "Tell me about the page." } as never,
    turnRoute: "retrieval",
    pageContext: null,
    directiveSteering: { rules: [], matches: [], omissions: [] },
    retrieval: {
      systemPrompt: "system",
      prompt: "prompt",
      responseIdentity: null,
      responseSettings: {
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
      },
      diagnostics: {},
      ...retrieval,
    } as unknown as RetrievalPipelineResult,
  }) as unknown as PreparedSession;

const groundedContext = {
  documentId: "doc-1",
  chunkId: "chunk-1",
  title: "Guide",
  content: "The page explains testing and parsing content for users.",
};

const plannedEnvelopeTail = JSON.stringify({
  grounding: "grounded",
  suggestions: [{ text: "Ask about returns", kind: "deeper", contextIndex: 1 }],
});

describe("retrieval streaming owns its grounded-miss reconcile", () => {
  it("returns the grounded-miss reply as finalPresentation and keeps assistant-sourced suggestions", async () => {
    // An uncited draft that the contexts do not support: the retrieval skill must
    // reconcile to a grounded miss itself, not leave it to the host.
    const chatGateway: ChatGateway = {
      async answer() {
        return "It also offers 24/7 phone support and a discount code.";
      },
      async *streamAnswer() {
        yield "It also offers 24/7 phone support and a discount code.";
        yield `\n${SUGGESTIONS_SENTINEL}\n${plannedEnvelopeTail}`;
      },
    };
    const composer = new RetrievalAnswerComposer(
      new ChatAnswerSupport(),
      chatGateway,
      presenter(),
      fallbackReplyComposer,
    );

    const { chunks, result } = await drain(
      composer.streamAnswer(baseSession({ contexts: [groundedContext] }), "What does the page do?", undefined, undefined),
    );

    // The unsupported draft never streamed (no citation anchor confirmed it).
    expect(chunks).toEqual([]);
    expect(result.hasStreamedAnswer).toBe(false);
    expect(result.streamedAnswer).toBe("");
    // The skill owns the reconcile: the final presentation is the grounded miss.
    expect(result.finalPresentation.answer).toBe(GROUNDED_MISS);
    expect(result.finalPresentation.citations ?? []).toEqual([]);
    // Suggestions still flow through the host's assistant-suggestion branch (the
    // planned envelope suggestions survive), NOT the presentation's own (empty) set.
    expect(result.suggestions.mode).toBe("assistant");
    if (result.suggestions.mode === "assistant") {
      expect(result.suggestions.planned).toHaveLength(1);
      expect(result.suggestions.planned[0]?.text).toBe("Ask about returns");
    }
  });

  it("returns the cited grounded presentation as finalPresentation with assistant-sourced suggestions", async () => {
    const chatGateway: ChatGateway = {
      async answer() {
        return "Testing and parsing content for users[[1]].";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. It is well supported.";
        yield `\n${SUGGESTIONS_SENTINEL}\n${plannedEnvelopeTail}`;
      },
    };
    const composer = new RetrievalAnswerComposer(
      new ChatAnswerSupport(),
      chatGateway,
      presenter(),
      fallbackReplyComposer,
    );

    const { chunks, result } = await drain(
      composer.streamAnswer(baseSession({ contexts: [groundedContext] }), "What does the page explain?", undefined, undefined),
    );

    // Cited prose streamed clean (no anchor tokens leaked).
    expect(chunks.join("")).not.toContain("[[");
    expect(result.hasStreamedAnswer).toBe(true);
    expect(result.finalPresentation.answer).not.toBe(GROUNDED_MISS);
    expect(result.finalPresentation.citations ?? []).toHaveLength(1);
    expect(result.suggestions.mode).toBe("assistant");
  });
});

describe("assistant-voice streaming carries its own suggestions", () => {
  it("returns its reply as finalPresentation and signals presentation-sourced suggestions", async () => {
    const chatGateway: ChatGateway = {
      async answer() {
        return "Hello! How can I help?";
      },
      async *streamAnswer() {
        yield "Hello! How can I help?";
      },
    };
    const composer = new AssistantReplyComposer(
      new ChatAnswerSupport(),
      chatGateway,
      presenter(),
      fallbackReplyComposer,
      SOCIAL_REPLY_CONFIG,
    );

    const { chunks, result } = await drain(
      composer.streamAnswer(
        baseSession({ contexts: [] }),
        "Hi there",
        undefined,
        undefined,
      ),
    );

    expect(chunks).toEqual(["Hello! How can I help?"]);
    expect(result.hasStreamedAnswer).toBe(true);
    expect(result.streamedAnswer).toBe("Hello! How can I help?");
    expect(result.finalPresentation.answer).toBe("Hello! How can I help?");
    expect(result.finalPresentation.skillName).toBe(SOCIAL_REPLY_CONFIG.skillName);
    // Assistant-voice replies settle their own suggestions onto the presentation;
    // the host must not re-expand planned suggestions for them.
    expect(result.suggestions.mode).toBe("presentation");
  });
});
