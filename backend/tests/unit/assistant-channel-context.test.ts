import { describe, expect, it, vi } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { AssistantChatService } from "../../src/modules/chat/composition.js";

const slackContext: ConversationChannelContext = {
  provider: "slack",
  team: { id: "T1", name: "Acme" },
  channel: { id: "D1", type: "im" },
  user: { id: "U1" },
};

describe("AssistantChatService channel context", () => {
  it("threads explicit channelContext into new conversation answer calls", async () => {
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        agentId: "agent-1",
        answer: "Answer",
        citations: [],
        answerSegments: [],
        suggestions: [],
        activitySummary: {},
        route: { type: "direct", reason: "social_only" },
      })),
    };
    const service = new AssistantChatService(
      chatService as never,
      { startConversation: vi.fn() } as never,
    );

    await service.answer({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      message: "Question",
      stream: false,
      sourceChannel: "slack",
      channelContext: slackContext,
    });

    expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannel: "slack",
      channelContext: slackContext,
    }));
  });

  it("falls back to sourceContext.channelContext", async () => {
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        agentId: "agent-1",
        answer: "Answer",
        citations: [],
        answerSegments: [],
        suggestions: [],
        activitySummary: {},
        route: { type: "direct", reason: "social_only" },
      })),
    };
    const service = new AssistantChatService(
      chatService as never,
      { startConversation: vi.fn() } as never,
    );

    await service.answer({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      message: "Question",
      stream: false,
      sourceContext: {
        surface: "public_chat",
        channelContext: slackContext,
      },
    });

    expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannel: "public_chat",
      channelContext: slackContext,
    }));
  });
});
