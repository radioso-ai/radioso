import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { buildNonRetrievalAnswerPrompt } from "../../src/modules/chat/services/nonRetrievalAnswerPromptBuilder.js";
import { CHAT_TURN_ROUTE } from "../../src/modules/chat/services/chatTurnIntentService.js";

const historyMessage = (overrides: Partial<MessageRecord>): MessageRecord => ({
  id: "message-1",
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  role: "user",
  content: "Thanks",
  createdAt: new Date("2026-04-30T00:00:00.000Z"),
  ...overrides,
});

describe("non-retrieval answer prompt builder", () => {
  it("instructs social replies to loop back to the configured assistant scope", () => {
    const prompt = buildNonRetrievalAnswerPrompt({
      route: CHAT_TURN_ROUTE.SOCIAL_ONLY,
      responseIdentity: {
        name: "Vikram",
      },
      answerInstructionBlock: [
        "Stable assistant identity:",
        "Name: Vikram",
        "Workspace-specific instructions:",
        "Help visitors choose retreats and courses.",
      ].join("\n"),
      history: [
        historyMessage({
          role: "assistant",
          content: "The course starts in June.",
        }),
      ],
      query: "Thanks!",
    });

    expect(prompt).toContain("Use the Answer Instructions to understand what this assistant is configured to help with.");
    expect(prompt).toContain("loop the user back to that configured scope");
    expect(prompt).toContain("Do not mention internal labels");
    expect(prompt).toContain("Help visitors choose retreats and courses.");
    expect(prompt).toContain("ASSISTANT: The course starts in June.");
  });

  it("instructs identity replies to describe the configured scope when asked what the assistant can do", () => {
    const prompt = buildNonRetrievalAnswerPrompt({
      route: CHAT_TURN_ROUTE.ASSISTANT_IDENTITY,
      responseIdentity: {
        name: "Vikram",
      },
      answerInstructionBlock: "Workspace-specific instructions:\nHelp visitors choose retreats and courses.",
      history: [],
      query: "What can you do?",
    });

    expect(prompt).toContain("When the user asks what you can do");
    expect(prompt).toContain("use the Answer Instructions to describe the configured scope");
    expect(prompt).toContain("Identity status: configured_or_not_needed");
  });
});
