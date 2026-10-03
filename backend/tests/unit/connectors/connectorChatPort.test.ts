import { describe, expect, it, vi } from "vitest";

import type { ConnectorIngestInput } from "@radioso/connector-api";

import type { ChatAnswerPort, ConversationIngestPort } from "../../../src/modules/chat/contracts/index.js";
import { createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";

const unusedIngest: ConversationIngestPort = {
  ingest: vi.fn(async () => {
    throw new Error("ingest is not expected here");
  }),
};

describe("createConnectorChatPort", () => {
  it("surfaces retrieval generation failures as unavailable", async () => {
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        answer: "I can't respond right now.",
        skillOutcome: "unavailable",
      })),
    } as unknown as ChatAnswerPort;
    const connectorChat = createConnectorChatPort(chatService, unusedIngest);

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

  it("answers through the chat service exactly as before, never ingesting", async () => {
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        answer: "Refunds take five days.",
        skillOutcome: "retrieval.answer:grounded",
      })),
    } as unknown as ChatAnswerPort;
    const connectorChat = createConnectorChatPort(chatService, unusedIngest);
    const channelContext = { provider: "web", origin: "https://example.com" } as const;

    const response = await connectorChat.answer({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      query: "What is the refund policy?",
      sourceChannel: "slack",
      channelContext,
    });

    expect(chatService.answer).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      query: "What is the refund policy?",
      stream: false,
      sourceChannel: "slack",
      channelContext,
    });
    expect(response).toEqual({ conversationId: "conversation-1", answer: "Refunds take five days.", outcome: "answered" });
    expect(unusedIngest.ingest).not.toHaveBeenCalled();
  });

  it("delegates ingest to the conversation ingest port, running no turn", async () => {
    const chatService = { answer: vi.fn() } as unknown as ChatAnswerPort;
    const ingestResult = {
      conversationId: "conversation-1",
      messageId: "message-1",
      conversationCreated: true,
      messageCreated: true,
      ownership: { state: "human_owned" as const, version: 1 },
    };
    const conversationIngest: ConversationIngestPort = { ingest: vi.fn(async () => ingestResult) };
    const connectorChat = createConnectorChatPort(chatService, conversationIngest);
    const input: ConnectorIngestInput = {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversation: {
        kind: "new",
        conversationId: "conversation-1",
        sourceChannel: "email",
        channelContext: {
          provider: "email",
          mailbox: { id: "mailbox-1", address: "support@customer.example" },
          threadKey: "thread-1",
          participant: { address: "person@example.org" },
        },
      },
      message: { id: "message-1", text: "Where is my order?", receivedAt: new Date("2026-10-01T09:30:00.000Z") },
      humanOwnership: { reason: "operator_only_mailbox" },
    };

    await expect(connectorChat.ingest(input)).resolves.toEqual(ingestResult);
    expect(conversationIngest.ingest).toHaveBeenCalledWith(input);
    expect(chatService.answer).not.toHaveBeenCalled();
  });
});
