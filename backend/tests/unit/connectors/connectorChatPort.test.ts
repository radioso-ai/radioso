import { describe, expect, it, vi } from "vitest";

import type { ChatAnswerPort } from "../../../src/modules/chat/contracts/index.js";
import { createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";

describe("createConnectorChatPort", () => {
  it("surfaces retrieval generation failures as unavailable", async () => {
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        answer: "I can't respond right now.",
        skillOutcome: "unavailable",
      })),
    } as unknown as ChatAnswerPort;
    const connectorChat = createConnectorChatPort(chatService);

    const response = await connectorChat.answer({
      workspaceId: "workspace-1",
      query: "What is the refund policy?",
    });

    expect(response).toEqual({
      conversationId: "conversation-1",
      answer: "I can't respond right now.",
      outcome: "unavailable",
    });
  });
});
