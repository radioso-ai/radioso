import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ConversationChannelContext } from "@radioso/conversation-contract";
import type {
  ConnectorChatOutcome,
  ConnectorChatPort,
  ConnectorIngestInput,
  ConnectorIngestResult,
  ConnectorReplyDraft,
  ConnectorRespondInput,
  ConnectorTurnFacts,
  ConnectorTurnResult,
} from "@radioso/connector-api";

import type {
  ChatAnswerPort,
  ChatReviewResult,
  ConversationIngestPort,
} from "../../../src/modules/chat/contracts/index.js";
import { createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";

const answerResponse = {
  conversationId: "conversation-1",
  answer: "Refunds take five days.",
  skillOutcome: "grounded",
  // A live reply carries far more than a connector sees; none of it may leak through `answer`.
  assistantMessageId: "assistant-message-1",
  answerOutcome: "grounded_success",
  citations: [{ chunkId: "chunk-1" }],
};

const portFor = (review?: ChatReviewResult) => {
  const chatService = {
    answer: vi.fn(async () => answerResponse),
    review: vi.fn(async () => review),
  };
  const conversationIngest: ConversationIngestPort = {
    ingest: vi.fn(async () => ({
      conversationId: "conversation-1",
      messageId: "message-1",
      conversationCreated: true,
      messageCreated: true,
      ownership: { state: "ai_owned" as const, version: 0 },
    })),
  };
  return {
    chatService,
    conversationIngest,
    port: createConnectorChatPort(chatService as unknown as ChatAnswerPort, conversationIngest),
  };
};

describe("ConnectorChatPort contract", () => {
  describe("answer", () => {
    it("keeps its input and result types", () => {
      expectTypeOf<Parameters<ConnectorChatPort["answer"]>[0]>().toEqualTypeOf<{
        workspaceId: string;
        agentId?: string;
        conversationId?: string;
        query: string;
        sourceChannel?: string | null;
        channelContext?: ConversationChannelContext | null;
      }>();
      expectTypeOf<Awaited<ReturnType<ConnectorChatPort["answer"]>>>().toEqualTypeOf<{
        conversationId: string;
        answer: string;
        outcome: ConnectorChatOutcome;
      }>();
    });

    it("answers a Slack message exactly as before", async () => {
      const { chatService, port } = portFor();
      const channelContext: ConversationChannelContext = { provider: "web", origin: "https://example.com" };

      const result = await port.answer({
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
      expect(chatService.review).not.toHaveBeenCalled();
      expect(result).toStrictEqual({
        conversationId: "conversation-1",
        answer: "Refunds take five days.",
        outcome: "answered",
      });
    });

    it("answers a WhatsApp message exactly as before", async () => {
      const { chatService, port } = portFor();

      const result = await port.answer({
        workspaceId: "workspace-1",
        conversationId: undefined,
        query: "Do you deliver on Sundays?",
        sourceChannel: "whatsapp",
      });

      expect(chatService.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: undefined,
        conversationId: undefined,
        query: "Do you deliver on Sundays?",
        stream: false,
        sourceChannel: "whatsapp",
        channelContext: undefined,
      });
      expect(result).toStrictEqual({
        conversationId: "conversation-1",
        answer: "Refunds take five days.",
        outcome: "answered",
      });
    });
  });

  describe("ingest", () => {
    it("keeps its input and result shapes", async () => {
      expectTypeOf<Parameters<ConnectorChatPort["ingest"]>[0]>().toEqualTypeOf<ConnectorIngestInput>();
      expectTypeOf<Awaited<ReturnType<ConnectorChatPort["ingest"]>>>().toEqualTypeOf<ConnectorIngestResult>();
      expectTypeOf<ConnectorIngestResult["ownership"]>().toEqualTypeOf<{ state: "ai_owned" | "human_owned"; version: number }>();
      const { port, chatService } = portFor();

      const result = await port.ingest({
        workspaceId: "workspace-1",
        agentId: null,
        conversation: { kind: "existing", conversationId: "conversation-1" },
        message: { id: "message-1", text: "Hello", receivedAt: new Date("2026-10-01T09:30:00.000Z") },
        humanOwnership: null,
      });

      expect(Object.keys(result).sort()).toEqual(
        ["conversationCreated", "conversationId", "messageCreated", "messageId", "ownership"],
      );
      expect(chatService.answer).not.toHaveBeenCalled();
      expect(chatService.review).not.toHaveBeenCalled();
    });
  });

  describe("respond", () => {
    const respondInput: ConnectorRespondInput = {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      respondToMessageId: "message-1",
      executionMode: "review",
      historyWindow: { maxMessages: 20 },
    };

    const reviewFacts = {
      answerOutcome: "grounded_success" as const,
      answerCoverage: {
        availability: "assessed" as const,
        coverage: "answered" as const,
        reason: "sufficient_evidence" as const,
        contextualizedRequest: "Where is my order?",
        originatingTurnId: "message-1",
        originatingRequestId: "message-1",
      },
      skillOutcome: "grounded",
      ownershipHandoffSignal: { reason: "retrieval_miss" },
      suppressedEffects: [{ skillName: "order_lookup", site: "staged_tool" as const }],
      citationCount: 1,
    };

    it("accepts only the review execution mode and returns the three result kinds", () => {
      expectTypeOf<ConnectorRespondInput["executionMode"]>().toEqualTypeOf<"review">();
      expectTypeOf<ConnectorTurnResult["kind"]>().toEqualTypeOf<"draft" | "no_draft" | "human_owned">();
      expectTypeOf<Extract<ConnectorTurnResult, { kind: "draft" }>["draft"]>().toEqualTypeOf<ConnectorReplyDraft>();
      expectTypeOf<Extract<ConnectorTurnResult, { kind: "no_draft" }>>().not.toHaveProperty("draft");
      expectTypeOf<Extract<ConnectorTurnResult, { kind: "human_owned" }>>().not.toHaveProperty("facts");
      expectTypeOf<ConnectorTurnFacts["suppressedEffects"]>().toEqualTypeOf<readonly { skillName: string }[]>();
    });

    it("returns a draft with exactly the contract's fields, leaking no host-internal fact", async () => {
      const { port } = portFor({
        kind: "draft",
        conversationId: "conversation-1",
        ownershipVersion: 2,
        draft: { text: "It ships tomorrow.", presentation: { skillName: "retrieval.answer" } },
        facts: reviewFacts,
      });

      const result = await port.respond(respondInput);

      expect(Object.keys(result).sort()).toEqual(["conversationId", "draft", "facts", "kind", "ownershipVersion"]);
      if (result.kind !== "draft") {
        throw new Error("expected a draft");
      }
      expect(Object.keys(result.draft).sort()).toEqual(["presentation", "text"]);
      expect(result.facts).toStrictEqual({
        outcome: "answered",
        grounding: "grounded",
        coverage: "answered",
        handoff: { requested: true, reason: "retrieval_miss" },
        suppressedEffects: [{ skillName: "order_lookup" }],
        citationCount: 1,
      });
    });

    it("returns no draft with facts and no draft field", async () => {
      const { port } = portFor({ kind: "no_draft", conversationId: "conversation-1", ownershipVersion: 2, facts: reviewFacts });

      const result = await port.respond(respondInput);

      expect(Object.keys(result).sort()).toEqual(["conversationId", "facts", "kind", "ownershipVersion"]);
    });

    it("returns human_owned with only the conversation and its ownership version", async () => {
      const { port } = portFor({ kind: "human_owned", conversationId: "conversation-1", ownershipVersion: 5 });

      await expect(port.respond(respondInput)).resolves.toStrictEqual({
        kind: "human_owned",
        conversationId: "conversation-1",
        ownershipVersion: 5,
      });
    });
  });
});
