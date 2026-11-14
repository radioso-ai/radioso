import { describe, expect, it, vi } from "vitest";

import type { ConnectorIngestInput, ConnectorRespondInput } from "@radioso/connector-api";
import type { ReplyBlock } from "@radioso/conversation-contract";

import {
  ITEM_SELECTION_REFUSAL_CODES,
  type ChatAnswerPort,
  type ChatDoorPickTurnPort,
  type ChatReviewResult,
  type ConversationIngestPort,
} from "../../../src/modules/chat/contracts/index.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { CONNECTOR_PICK_REFUSED_CODE, createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";
import {
  CONNECTOR_IMAGES_UNUSABLE_CODE,
  type ConnectorImageAnswer,
  type ConnectorImageTurns,
} from "../../../src/modules/connectors/services/connectorImageTurns.js";
import { connectorChatOutcome } from "../../../src/modules/connectors/services/connectorTurnFacts.js";

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

  describe("photos", () => {
    const PHOTO = new Uint8Array([0xff, 0xd8, 1]);
    const setup = (answered: ConnectorImageAnswer | null) => {
      const chatService = {
        answer: vi.fn(async () => ({ conversationId: "conversation-text", answer: "Text answer", skillOutcome: "grounded" })),
      } as unknown as ChatAnswerPort;
      const imageTurns: ConnectorImageTurns = {
        imageAllowance: vi.fn(async () => ({ maxImages: 3 })),
        answer: vi.fn(async () => answered),
      };
      return { chatService, imageTurns, connectorChat: createConnectorChatPort(chatService, unusedIngest, { imageTurns }) };
    };
    const photoAnswer: ConnectorImageAnswer = { conversationId: "conversation-new", answer: "Looks lovely.", skillOutcome: "grounded" };

    it("allows no photos on a port that has no photo support", async () => {
      const connectorChat = createConnectorChatPort({ answer: vi.fn() } as unknown as ChatAnswerPort, unusedIngest);

      await expect(connectorChat.imageAllowance({ workspaceId: "workspace-1" })).resolves.toBeNull();
    });

    it("reports what a turn on the conversation takes in photos", async () => {
      const { connectorChat, imageTurns } = setup(null);

      await expect(connectorChat.imageAllowance({ workspaceId: "workspace-1", conversationId: "conversation-1" }))
        .resolves.toEqual({ maxImages: 3 });
      expect(imageTurns.imageAllowance).toHaveBeenCalledWith({ workspaceId: "workspace-1", conversationId: "conversation-1" });
    });

    it("runs a turn with photos through the photo turns, not the text path, and maps its outcome", async () => {
      const { connectorChat, chatService, imageTurns } = setup({ ...photoAnswer, skillOutcome: "retrieval.no_context" });
      const channelContext = { provider: "web", origin: "https://example.com" } as const;
      const onImagesStored = vi.fn(async () => undefined);

      const response = await connectorChat.answer({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        query: "Like this",
        sourceChannel: "whatsapp",
        channelContext,
        images: [{ key: "wamid-1", bytes: PHOTO }],
        onImagesStored,
      });

      expect(imageTurns.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        query: "Like this",
        images: [{ key: "wamid-1", bytes: PHOTO }],
        sourceChannel: "whatsapp",
        channelContext,
        onImagesStored,
      });
      expect(chatService.answer).not.toHaveBeenCalled();
      expect(response).toEqual({ conversationId: "conversation-new", answer: "Looks lovely.", outcome: connectorChatOutcome("retrieval.no_context") });
    });

    it("runs the turn on its text when every photo was refused", async () => {
      const { connectorChat, chatService } = setup(null);

      await connectorChat.answer({ workspaceId: "workspace-1", query: "Like this", images: [{ key: "wamid-1", bytes: PHOTO }] });

      expect(chatService.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: undefined,
        conversationId: undefined,
        query: "Like this",
        stream: false,
        sourceChannel: undefined,
        channelContext: undefined,
      });
    });

    it("refuses a turn with nothing to answer, by a code the connector can tell apart: no text and no usable photo", async () => {
      const { connectorChat, chatService } = setup(null);

      await expect(connectorChat.answer({ workspaceId: "workspace-1", query: "  ", images: [{ key: "wamid-1", bytes: PHOTO }] }))
        .rejects.toMatchObject({ statusCode: 422, code: CONNECTOR_IMAGES_UNUSABLE_CODE });
      expect(chatService.answer).not.toHaveBeenCalled();
    });

    it("refuses photos on a port that has no photo support, rather than dropping them", async () => {
      const chatService = { answer: vi.fn() } as unknown as ChatAnswerPort;
      const connectorChat = createConnectorChatPort(chatService, unusedIngest);

      await expect(connectorChat.answer({ workspaceId: "workspace-1", query: "Like this", images: [{ key: "wamid-1", bytes: PHOTO }] }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(chatService.answer).not.toHaveBeenCalled();
    });

    it("never touches the photo path for a turn without photos", async () => {
      const { connectorChat, imageTurns } = setup(null);

      await connectorChat.answer({ workspaceId: "workspace-1", query: "Hello", images: [] });

      expect(imageTurns.answer).not.toHaveBeenCalled();
    });
  });

  describe("reply blocks and picks", () => {
    const BLOCK: ReplyBlock = {
      type: "item_list",
      id: "b1",
      layout: "carousel",
      selection: "single",
      caption: "Homes",
      items: [{ key: "/results/0", title: "Casa Blu", actions: [{ type: "select" }] }],
      buttonLabels: { select: "Scegli" },
    };
    const WHATSAPP_BLOCKS = { item_list: { layouts: ["carousel", "grid", "list"] as const, buttonLabels: true } };
    const SELECTION = { messageId: "11111111-1111-4111-8111-111111111111", blockId: "b1", itemKey: "/results/0" };
    const reply = { conversationId: "conversation-1", answer: "Two homes fit.", skillOutcome: "grounded", assistantMessageId: "message-9", blocks: [BLOCK] };

    it("declares the channel's blocks to the turn and hands back the blocks with the message that stored them", async () => {
      const chatService = { answer: vi.fn(async () => reply) } as unknown as ChatAnswerPort;
      const connectorChat = createConnectorChatPort(chatService, unusedIngest);

      const response = await connectorChat.answer({ workspaceId: "workspace-1", conversationId: "conversation-1", query: "Homes?", sourceChannel: "whatsapp", replyBlocks: WHATSAPP_BLOCKS });

      expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({
        clientContextCapabilities: { "reply.blocks": { item_list: { layouts: ["carousel", "grid", "list"], buttonLabels: true } } },
      }));
      expect(response).toEqual({
        conversationId: "conversation-1",
        answer: "Two homes fit.",
        outcome: "answered",
        replyBlocks: { messageId: "message-9", blocks: [BLOCK] },
      });
    });

    it("runs a pick through the chat door, which reads the card from the stored reply", async () => {
      const chatService = { answer: vi.fn() } as unknown as ChatAnswerPort;
      const picks: ChatDoorPickTurnPort = { answer: vi.fn(async () => ({ ...reply, blocks: undefined, answer: "Casa Blu it is." })) };
      const connectorChat = createConnectorChatPort(chatService, unusedIngest, { picks });

      const response = await connectorChat.answer({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        query: "Casa Blu",
        sourceChannel: "whatsapp",
        replyBlocks: WHATSAPP_BLOCKS,
        selection: SELECTION,
      });

      expect(picks.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: undefined,
        conversationId: "conversation-1",
        message: "Casa Blu",
        stream: false,
        inputMetadata: { method: "item_select", selection: SELECTION },
        sourceChannel: "whatsapp",
        channelContext: undefined,
        clientContextCapabilities: { "reply.blocks": { item_list: { layouts: ["carousel", "grid", "list"], buttonLabels: true } } },
      });
      expect(chatService.answer).not.toHaveBeenCalled();
      expect(response).toEqual({ conversationId: "conversation-1", answer: "Casa Blu it is.", outcome: "answered" });
    });

    it.each([
      ["names no card the conversation can pick", new AppError(400, ITEM_SELECTION_REFUSAL_CODES.invalid, "no card")],
      ["picks another card of a reply already picked from", new AppError(409, ITEM_SELECTION_REFUSAL_CODES.alreadySelected, "picked")],
    ])("refuses the pick, as the web chat does, and never runs the card's words as typed text, when it %s", async (_case, refusal) => {
      const chatService = { answer: vi.fn(async () => reply) } as unknown as ChatAnswerPort;
      const picks: ChatDoorPickTurnPort = { answer: vi.fn(async () => { throw refusal; }) };
      const connectorChat = createConnectorChatPort(chatService, unusedIngest, { picks });

      await expect(connectorChat.answer({ workspaceId: "workspace-1", conversationId: "conversation-1", query: "Casa Blu", selection: SELECTION }))
        .rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_PICK_REFUSED_CODE });
      expect(chatService.answer).not.toHaveBeenCalled();
    });

    it("passes any other failure of a pick on, for the connector to retry", async () => {
      const picks: ChatDoorPickTurnPort = { answer: vi.fn(async () => { throw new AppError(503, "busy", "busy"); }) };
      const connectorChat = createConnectorChatPort({ answer: vi.fn() } as unknown as ChatAnswerPort, unusedIngest, { picks });

      await expect(connectorChat.answer({ workspaceId: "workspace-1", conversationId: "conversation-1", query: "Casa Blu", selection: SELECTION }))
        .rejects.toMatchObject({ statusCode: 503 });
    });

    it("refuses a pick on a port without the chat door, or with no conversation to pick in", async () => {
      const chatService = { answer: vi.fn(async () => reply) } as unknown as ChatAnswerPort;
      const picks: ChatDoorPickTurnPort = { answer: vi.fn() };

      await expect(createConnectorChatPort(chatService, unusedIngest).answer({ workspaceId: "workspace-1", conversationId: "conversation-1", query: "Casa Blu", selection: SELECTION }))
        .rejects.toMatchObject({ code: CONNECTOR_PICK_REFUSED_CODE });
      await expect(createConnectorChatPort(chatService, unusedIngest, { picks }).answer({ workspaceId: "workspace-1", query: "Casa Blu", selection: SELECTION }))
        .rejects.toMatchObject({ code: CONNECTOR_PICK_REFUSED_CODE });
      expect(chatService.answer).not.toHaveBeenCalled();
      expect(picks.answer).not.toHaveBeenCalled();
    });

    it("asks whether a reply's pictures are stored, and answers yes on a port that cannot tell", async () => {
      const replyPictures = { awaitStored: vi.fn(async () => false) };
      const input = { workspaceId: "workspace-1", messageId: "message-9", withinMs: 6000 };

      await expect(createConnectorChatPort({} as ChatAnswerPort, unusedIngest, { replyPictures }).awaitReplyPictures(input)).resolves.toBe(false);
      expect(replyPictures.awaitStored).toHaveBeenCalledWith(input);
      await expect(createConnectorChatPort({} as ChatAnswerPort, unusedIngest).awaitReplyPictures(input)).resolves.toBe(true);
    });
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
