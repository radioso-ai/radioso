import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { AssistantChatService } from "../../../src/modules/chat/composition.js";
import type { ChatAnswerPort } from "../../../src/modules/chat/contracts/index.js";
import type { UserMessageStoredListener } from "../../../src/modules/chat/types/assistantApi.js";
import { createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";
import { createConnectorImageTurns } from "../../../src/modules/connectors/services/connectorImageTurns.js";
import type { VisitorImageAvailability, VisitorImageReader } from "../../../src/modules/visitorImages/domain.js";
import { VisitorImageService } from "../../../src/modules/visitorImages/services/visitorImageService.js";
import { InMemoryVisitorImageObjects, InMemoryVisitorImageStore } from "../../support/inMemoryVisitorImages.js";

const WORKSPACE = "8d2b8f0e-6a1e-4c1a-9a43-0c1b2b5f9a01";
const AGENT = "1f0e0c7c-2b8e-4a55-8e3b-7d8f7f0c8a11";
const READING = "A two-storey stone farmhouse among olive trees.";

const photo = (): Promise<Buffer> => sharp({ create: { width: 1200, height: 800, channels: 3, background: "#4a7a3a" } }).jpeg().toBuffer();

type StoringTurn = { onUserMessageStored?: UserMessageStoredListener; query: string; inputMetadata?: unknown };

/**
 * A WhatsApp turn end to end below the chat service: the real connector port, the real photo
 * turns, the real chat door and the real photo service over in-memory rows. The chat service
 * stands in for the session preparer, which stores the user message and tells the door.
 */
const harness = (options: { messageIds?: { conversationId: string; messageId: string } } = {}) => {
  const store = new InMemoryVisitorImageStore();
  const reader: VisitorImageReader = { read: vi.fn(async () => ({ kind: "read" as const, description: READING })) };
  const availability = { forAgent: vi.fn<VisitorImageAvailability["forAgent"]>(async () => "available") };
  const reservation = { commit: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const visitorImages = new VisitorImageService({
    store,
    objects: new InMemoryVisitorImageObjects(),
    reader,
    audit: { viewed: vi.fn(async () => undefined) },
    availability,
    usage: { reserveAnswer: vi.fn(async () => reservation) },
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  const stored = options.messageIds ?? { conversationId: "conversation-whatsapp", messageId: "message-whatsapp-user" };
  const turns: StoringTurn[] = [];
  const chatService = {
    answer: vi.fn(async (input: StoringTurn) => {
      turns.push(input);
      await input.onUserMessageStored?.(stored);
      return { conversationId: stored.conversationId, assistantMessageId: "message-assistant", answer: "Lovely place.", skillOutcome: "grounded" };
    }),
  };
  const door = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });
  const connectorChat = createConnectorChatPort(
    {} as ChatAnswerPort,
    { ingest: vi.fn() },
    createConnectorImageTurns({
      agents: { resolve: async (_workspaceId, agentId) => ({ id: agentId ?? AGENT }) },
      conversations: { findByIdAndWorkspaceId: async () => null },
      availability,
      images: visitorImages,
      door,
    }),
  );
  return { connectorChat, store, chatService, turns, availability, reader };
};

describe("a WhatsApp photo through the chat door", () => {
  it("is bound to the user message the turn stores, in the conversation it created", async () => {
    const { connectorChat, store, turns } = harness();

    const answered = await connectorChat.answer({
      workspaceId: WORKSPACE,
      query: "Something like this, near the coast",
      sourceChannel: "whatsapp",
      images: [{ key: "wamid-photo-1", bytes: await photo() }],
    });

    expect(answered).toMatchObject({ conversationId: "conversation-whatsapp", answer: "Lovely place.", outcome: "answered" });
    const rows = [...store.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      owner: { kind: "connector_conversation" },
      conversationId: "conversation-whatsapp",
      messageId: "message-whatsapp-user",
      readingStatus: "read",
      reading: READING,
    });
    // The turn runs on the caption and the reading, and its message keeps the photo's id.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.query).toContain("Something like this, near the coast");
    expect(turns[0]?.query).toContain(READING);
    expect(turns[0]?.inputMetadata).toMatchObject({
      imageInput: { typedText: "Something like this, near the coast", images: [{ id: rows[0]?.id, reading: READING }] },
    });
  });

  it("is bound to the message of the conversation the sender is already in", async () => {
    const { connectorChat, store } = harness({ messageIds: { conversationId: "conversation-existing", messageId: "message-2" } });

    await connectorChat.answer({
      workspaceId: WORKSPACE,
      conversationId: "conversation-existing",
      query: "",
      sourceChannel: "whatsapp",
      images: [{ key: "wamid-photo-1", bytes: await photo() }, { key: "wamid-photo-2", bytes: await photo() }],
    });

    const rows = [...store.rows.values()];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        owner: { kind: "connector_conversation", id: "conversation-existing" },
        conversationId: "conversation-existing",
        messageId: "message-2",
      });
    }
  });

  it("is left for the unbound sweep, not bound to anything, when the agent stops taking photos before the claim", async () => {
    const { connectorChat, store, chatService, availability } = harness();
    availability.forAgent
      .mockResolvedValueOnce("available") // the connector's own check before the upload
      .mockResolvedValue("disabled"); // the claim's check, after the flag is turned off

    await expect(connectorChat.answer({
      workspaceId: WORKSPACE,
      query: "Something like this",
      sourceChannel: "whatsapp",
      images: [{ key: "wamid-photo-1", bytes: await photo() }],
    })).rejects.toMatchObject({ statusCode: 409, code: "visitor_images_unavailable" });

    expect(chatService.answer).not.toHaveBeenCalled();
    expect([...store.rows.values()].every((row) => row.messageId === null && row.conversationId === null)).toBe(true);
  });
});
