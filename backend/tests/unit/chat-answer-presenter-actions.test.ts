import { describe, expect, it, vi } from "vitest";

import { ChatAnswerPresenter, type ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatActionSuggestionRegistry } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionRegistry.js";
import { ChatActionSuggestionService } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionService.js";
import type { ChatActionSuggestionProvider } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionProvider.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type {
  AssistantSuggestionExpansionInput,
  AssistantSuggestionExpansionService,
} from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";

const stubExpansionService = {
  async apply() {
    return { suggestions: [] as ChatSuggestion[] };
  },
} as unknown as AssistantSuggestionExpansionService;

const buildExpansionSpy = (captured: { groundedAnswerSupported?: boolean }): AssistantSuggestionExpansionService => ({
  apply(input: AssistantSuggestionExpansionInput) {
    captured.groundedAnswerSupported = input.groundedAnswerSupported;
    return { suggestions: [] as ChatSuggestion[] };
  },
}) as unknown as AssistantSuggestionExpansionService;

const buildSession = (): PreparedSession => {
  const conversation: ConversationRecord = {
    id: "conv-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    agentName: "Agent",
    sourceChannel: "website_embed",
    sourceOrigin: "https://example.com",
    channelContext: null,
    anonymousSessionId: null,
    verifiedCustomerId: null,
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
    retrieval: {
      contexts: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Doc",
          content: "Grounded evidence.",
          metadata: {},
        },
      ],
      responseSettings: {},
    } as PreparedSession["retrieval"],
    turnRoute: "retrieval" as PreparedSession["turnRoute"],
    userMessage,
    effectiveQuery: userMessage.content,
    stagedContext: [],
    resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
    turnTrace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
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

const groundedPresentation: ChatPresentedAnswer = {
  ...basePresentation,
  citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Doc" }],
  answerSegments: [{ text: "Grounded answer.", citationIndices: [0] }],
  skillOutcome: "grounded",
  answerOutcome: "grounded_success",
};

const buildProvider = (suggestion: ChatSuggestion): ChatActionSuggestionProvider => ({
  name: "test-provider",
  evaluate: vi.fn(async () => suggestion),
});

describe("ChatAnswerPresenter.presentWithoutSuggestions", () => {
  it("preserves uncited model prose alongside cited segments", async () => {
    const presenter = new ChatAnswerPresenter(stubExpansionService);
    const answer =
      "Widgets are great[[1]].\n\nFor center stays, share your arrival and departure dates and preferred accommodation.";

    const result = await presenter.presentWithoutSuggestions(buildSession(), answer, "What is X?");

    expect(result.answer).toContain("For center stays, share your arrival and departure dates");
    expect(result.answerSegments?.map((segment) => segment.text).join("")).toContain(
      "For center stays, share your arrival and departure dates and preferred accommodation.",
    );
  });

  it("preserves uncited contact details verbatim", async () => {
    const presenter = new ChatAnswerPresenter(stubExpansionService);
    const answer =
      "Widgets are great[[1]].\n\nReach us by phone +39 0742 813620 or email info@ananda.it.";

    const result = await presenter.presentWithoutSuggestions(buildSession(), answer, "What is X?");

    expect(result.answer).toContain("+39 0742 813620");
    expect(result.answer).toContain("info@ananda.it");
  });

  it("reports a grounded outcome by default", async () => {
    const presenter = new ChatAnswerPresenter(stubExpansionService);

    const result = await presenter.presentWithoutSuggestions(buildSession(), "Grounded answer[[1]].", "What is X?");

    expect(result.skillName).toBe("retrieval.answer");
    expect(result.skillOutcome).toBe("grounded");
    expect(result.answerOutcome).toBe("grounded_success");
  });

  it("reports a degraded outcome when the model flags weak grounding", async () => {
    const presenter = new ChatAnswerPresenter(stubExpansionService);

    const result = await presenter.presentWithoutSuggestions(
      buildSession(),
      "Grounded answer[[1]].",
      "What is X?",
      undefined,
      "degraded",
    );

    expect(result.skillName).toBe("retrieval.answer");
    expect(result.skillOutcome).toBe("grounded_degraded");
    // The legacy answer_outcome enum has no degraded value; it collapses to success.
    expect(result.answerOutcome).toBe("grounded_success");
  });
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

  it("enables grounded question suggestions from the skill outcome capability", () => {
    const captured: { groundedAnswerSupported?: boolean } = {};
    const presenter = new ChatAnswerPresenter(
      buildExpansionSpy(captured),
      undefined,
      {
        supportsGroundedAnswer: ({ skillName, outcome }) =>
          skillName === "custom.grounded" && outcome === "grounded",
      },
    );

    presenter.applyAssistantSuggestions(
      buildSession(),
      {
        ...groundedPresentation,
        skillName: "custom.grounded",
      },
      [],
    );

    expect(captured.groundedAnswerSupported).toBe(true);
  });

  it("does not enable grounded question suggestions without the outcome capability", () => {
    const captured: { groundedAnswerSupported?: boolean } = {};
    const presenter = new ChatAnswerPresenter(
      buildExpansionSpy(captured),
      undefined,
      {
        supportsGroundedAnswer: () => false,
      },
    );

    presenter.applyAssistantSuggestions(buildSession(), groundedPresentation, []);

    expect(captured.groundedAnswerSupported).toBe(false);
  });
});
