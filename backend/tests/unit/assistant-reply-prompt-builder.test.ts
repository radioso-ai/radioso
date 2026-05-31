import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { buildAssistantReplyPrompt } from "../../src/modules/chat/services/assistantReplyPromptBuilder.js";
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
    const prompt = buildAssistantReplyPrompt({
      route: CHAT_TURN_ROUTE.SOCIAL_ONLY,
      responseIdentity: {
        name: "Vikram",
      },
      answerInstructionBlock: [
        "Stable assistant identity:",
        "Name: Vikram",
        "Configured response instructions:",
        "Help visitors choose retreats and courses.",
      ].join("\n"),
      history: [
        historyMessage({
          role: "assistant",
          content: "The course starts in June.",
        }),
      ],
      query: "Thanks!",
      intentTopic: "gratitude",
    });

    expect(prompt).toContain("Detected intent topic: gratitude");
    expect(prompt).toContain("Use the Answer Instructions to understand what this assistant is configured to help with.");
    expect(prompt).toContain("loop the user back to that configured scope");
    expect(prompt).toContain("Do not mention internal labels");
    expect(prompt).toContain("Help visitors choose retreats and courses.");
    expect(prompt).toContain("ASSISTANT: The course starts in June.");
  });

  it("treats detected intent topic as evidence for scope handling instead of answer authority", () => {
    const prompt = buildAssistantReplyPrompt({
      route: CHAT_TURN_ROUTE.SOCIAL_ONLY,
      responseIdentity: {
        name: "Vikram",
      },
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose retreats and courses.",
      history: [],
      query: "sqrt(5)",
      intentTopic: "math problem",
      outsideScopeRequest: "solve sqrt(5)",
    });

    expect(prompt).toContain("Detected intent topic: math problem");
    expect(prompt).toContain("Detected outside-scope request: solve sqrt(5)");
    expect(prompt).toContain("classifier evidence only");
    expect(prompt).toContain("change the language, wording, length, or format");
    expect(prompt).toContain("If a detected outside-scope request is provided");
    expect(prompt).toContain("briefly decline that topic");
    expect(prompt).toContain("mixes an in-scope request with an outside-scope request");
    expect(prompt).toContain("do not solve, explain, summarize, translate, calculate, debug, or partially answer");
    expect(prompt).toContain("Do not include the result, formula, code output, factual answer, draft text, joke");
    expect(prompt).toContain("not permission to leave the configured assistant scope");
  });

  it("instructs identity replies to describe the configured scope when asked what the assistant can do", () => {
    const prompt = buildAssistantReplyPrompt({
      route: CHAT_TURN_ROUTE.ASSISTANT_IDENTITY,
      responseIdentity: {
        name: "Vikram",
      },
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose retreats and courses.",
      history: [],
      query: "What can you do?",
    });

    expect(prompt).toContain("When the user asks what you can do");
    expect(prompt).toContain("use the Answer Instructions to describe the configured scope");
    expect(prompt).toContain("Identity status: configured_or_not_needed");
  });

  it("renders matched steering directives into the prompt", () => {
    const prompt = buildAssistantReplyPrompt({
      route: CHAT_TURN_ROUTE.SOCIAL_ONLY,
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose retreats and courses.",
      history: [],
      query: "Thanks!",
      steering: [
        {
          action: "Prefer short paragraphs and avoid unnecessary structure.",
          source: "directive",
          lifespan: "response",
        },
      ],
    });

    expect(prompt).toContain("The following behavioral directives apply to this turn");
    expect(prompt).toContain("Prefer short paragraphs and avoid unnecessary structure.");
  });
});
