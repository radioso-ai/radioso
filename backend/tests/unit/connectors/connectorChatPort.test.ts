import { describe, expect, it, vi } from "vitest";

import type { ConnectorIngestInput, ConnectorRespondInput } from "@radioso/connector-api";

import type {
  ChatAnswerPort,
  ChatReviewResult,
  ConversationIngestPort,
} from "../../../src/modules/chat/contracts/index.js";
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

  describe("respond", () => {
    const respondInput: ConnectorRespondInput = {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      respondToMessageId: "message-1",
      executionMode: "review",
      historyWindow: { maxMessages: 12 },
    };
    const reviewFacts = {
      answerOutcome: "grounded_success" as const,
      answerCoverage: {
        availability: "assessed" as const,
        coverage: "answered" as const,
        reason: "sufficient_evidence" as const,
        originatingTurnId: "message-1",
        originatingRequestId: "message-1",
      },
      skillOutcome: "grounded",
      ownershipHandoffSignal: null,
      suppressedEffects: [{ skillName: "order_lookup", site: "turn" as const }],
      citationCount: 2,
    };
    const portWithReview = (result: ChatReviewResult) => {
      const chatService = { answer: vi.fn(), review: vi.fn(async () => result) };
      return { chatService, connectorChat: createConnectorChatPort(chatService, unusedIngest) };
    };

    it("runs a review turn on the named message and maps a draft", async () => {
      const presentation = { skillName: "retrieval.answer", metadata: { citations: [] } };
      const { chatService, connectorChat } = portWithReview({
        kind: "draft",
        conversationId: "conversation-1",
        ownershipVersion: 4,
        draft: { text: "Refunds take five days.", presentation },
        facts: reviewFacts,
      });

      const result = await connectorChat.respond(respondInput);

      expect(chatService.review).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        existingUserMessageId: "message-1",
        historyWindow: { maxMessages: 12 },
      });
      expect(chatService.answer).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: "draft",
        conversationId: "conversation-1",
        ownershipVersion: 4,
        draft: { text: "Refunds take five days.", presentation },
        facts: {
          outcome: "answered",
          grounding: "grounded",
          coverage: "answered",
          handoff: { requested: false },
          suppressedEffects: [{ skillName: "order_lookup" }],
          citationCount: 2,
        },
      });
    });

    it("maps no draft, asking for a person", async () => {
      const { connectorChat } = portWithReview({
        kind: "no_draft",
        conversationId: "conversation-1",
        ownershipVersion: 4,
        facts: { ...reviewFacts, skillOutcome: "unavailable", answerOutcome: null, answerCoverage: null, suppressedEffects: [] },
      });

      await expect(connectorChat.respond(respondInput)).resolves.toEqual({
        kind: "no_draft",
        conversationId: "conversation-1",
        ownershipVersion: 4,
        facts: {
          outcome: "unavailable",
          grounding: "unknown",
          coverage: "not_assessed",
          handoff: { requested: true, reason: "review_unavailable" },
          suppressedEffects: [],
          citationCount: 2,
        },
      });
    });

    it("maps a human-owned conversation", async () => {
      const { connectorChat } = portWithReview({ kind: "human_owned", conversationId: "conversation-1", ownershipVersion: 9 });

      await expect(connectorChat.respond(respondInput)).resolves.toEqual({
        kind: "human_owned",
        conversationId: "conversation-1",
        ownershipVersion: 9,
      });
    });
  });
});
