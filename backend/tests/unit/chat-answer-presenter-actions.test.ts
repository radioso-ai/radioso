import { describe, expect, it, vi } from "vitest";

import { ChatAnswerPresenter, type ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatActionSuggestionRegistry } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionRegistry.js";
import { ChatActionSuggestionService } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionService.js";
import type { ChatActionSuggestionProvider } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionProvider.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";

const stubExpansionService = {
  async apply() {
    return { suggestions: [] as ChatSuggestion[] };
  },
} as unknown as AssistantSuggestionExpansionService;

const buildSession = (): PreparedSession => {
  const conversation: ConversationRecord = {
    id: "conv-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    agentName: "Agent",
    sourceChannel: "website_embed",
    sourceOrigin: "https://example.com",
    anonymousSessionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const userMessage: MessageRecord = {
    id: "msg-user-1",
    conversationId: conversation.id,
    workspaceId: conversation.workspaceId,
    role: "user",
    content: "What is X?",
    createdAt: new Date(),
  } as MessageRecord;
  const agent = { id: "agent-1" } as AgentRecord;
  return {
    agent,
    conversation,
    history: [],
    retrieval: {} as PreparedSession["retrieval"],
    turnRoute: "retrieval" as PreparedSession["turnRoute"],
    userMessage,
  };
};

const basePresentation: ChatPresentedAnswer = {
  answer: "I cannot answer.",
  citations: [],
  skillName: "retrieval.answer",
  skillOutcome: "no_context",
  skillStatus: "completed",
  answerOutcome: "no_context_refusal",
};

const buildProvider = (suggestion: ChatSuggestion): ChatActionSuggestionProvider => ({
  name: "test-provider",
  evaluate: vi.fn(async () => suggestion),
});

describe("ChatAnswerPresenter.applyActionSuggestions", () => {
  it("returns the presentation unchanged when no action service is wired", async () => {
    const presenter = new ChatAnswerPresenter(stubExpansionService);
    const result = await presenter.applyActionSuggestions(buildSession(), basePresentation);
    expect(result).toEqual(basePresentation);
  });

  it("prepends action chips ahead of question chips", async () => {
    const actionChip: ChatSuggestion = {
      text: "Contact us",
      kind: "contact_human",
      action: { kind: "start_intent", intent: { skillName: "human_contact.request" } },
    };
    const service = new ChatActionSuggestionService(
      new ChatActionSuggestionRegistry([buildProvider(actionChip)]),
    );
    const presenter = new ChatAnswerPresenter(stubExpansionService, service);

    const presentationWithQuestions: ChatPresentedAnswer = {
      ...basePresentation,
      suggestions: [
        { text: "Tell me more", kind: "deeper" },
        { text: "What about Y?", kind: "broader" },
      ],
    };

    const result = await presenter.applyActionSuggestions(buildSession(), presentationWithQuestions);

    expect(result.suggestions?.map((s) => s.kind)).toEqual(["contact_human", "deeper", "broader"]);
  });

  it("passes skill-owned outcome context to the provider", async () => {
    const captured: { workspaceId?: string; skillName?: string; skillOutcome?: string; status?: string; legacyOutcome?: string } = {};
    const provider: ChatActionSuggestionProvider = {
      name: "spy",
      evaluate: async (ctx) => {
        captured.workspaceId = ctx.workspaceId;
        captured.skillName = ctx.skillName;
        captured.skillOutcome = ctx.skillOutcome;
        captured.status = ctx.skillStatus;
        captured.legacyOutcome = ctx.answerOutcome;
        return null;
      },
    };
    const service = new ChatActionSuggestionService(new ChatActionSuggestionRegistry([provider]));
    const presenter = new ChatAnswerPresenter(stubExpansionService, service);

    await presenter.applyActionSuggestions(buildSession(), basePresentation);

    expect(captured).toEqual({
      workspaceId: "ws-1",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      status: "completed",
      legacyOutcome: "no_context_refusal",
    });
  });
});
