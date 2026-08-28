import { describe, expect, it } from "vitest";

import { buildTurnInterpretationPrompt } from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import { composeGroundedAnswerSystemPrompt } from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import { buildAssistantReplyPrompt } from "../../src/modules/chat/services/assistantReplyPromptBuilder.js";
import { CHAT_TURN_ROUTE } from "../../src/shared/domain/chatTurnRoute.js";

const SUMMARY = "The user is planning a June retreat and already paid the deposit.";
const SUMMARY_MARKER = "Conversation summary so far";

const emptyIntentSnapshot = { recentTurns: [], activeSubject: undefined, activeGoal: undefined };

describe("rolling conversation summary injection (#866)", () => {
  describe("turn interpretation prompt", () => {
    it("renders the summary section when a summary is present", () => {
      const prompt = buildTurnInterpretationPrompt({
        context: "USER: hello",
        conversationSummary: SUMMARY,
        query: "and then?",
      });
      expect(prompt).toContain(SUMMARY_MARKER);
      expect(prompt).toContain(SUMMARY);
    });

    it("renders no summary section when the summary is absent", () => {
      const prompt = buildTurnInterpretationPrompt({
        context: "USER: hello",
        query: "and then?",
      });
      expect(prompt).not.toContain(SUMMARY_MARKER);
    });
  });

  describe("grounded answer role separation", () => {
    const base = {
      baseSystemPrompt: "Base grounded instructions.",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      hasRetrievedContexts: true,
      conversationIntentSnapshot: emptyIntentSnapshot,
    };

    it("includes the summary as untrusted conversation data when present", () => {
      const { systemPrompt, conversationContextPrompt } = composeGroundedAnswerSystemPrompt({
        ...base,
        conversationSummary: SUMMARY,
      });
      expect(systemPrompt).not.toContain(SUMMARY);
      expect(conversationContextPrompt).toContain("Rolling conversation summary");
      expect(conversationContextPrompt).toContain(SUMMARY);
    });

    it("omits conversation context when the summary is absent", () => {
      const { systemPrompt, conversationContextPrompt } = composeGroundedAnswerSystemPrompt(base);
      expect(systemPrompt).not.toContain(SUMMARY_MARKER);
      expect(conversationContextPrompt).toBe("");
    });
  });

  describe("direct (non-retrieval) answer prompt", () => {
    const base = {
      route: CHAT_TURN_ROUTE.DIRECT,
      answerInstructionBlock: "Answer scope.",
      history: [],
      query: "thanks!",
    };

    it("includes the summary block when present", () => {
      const prompt = buildAssistantReplyPrompt({ ...base, conversationSummary: SUMMARY });
      expect(prompt).toContain(SUMMARY_MARKER);
      expect(prompt).toContain(SUMMARY);
    });

    it("omits the summary block when absent", () => {
      const prompt = buildAssistantReplyPrompt(base);
      expect(prompt).not.toContain(SUMMARY_MARKER);
    });
  });
});
