import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { WhatsAppClientError } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { ConnectorRegistry } from "../../../../src/modules/connectors/services/connectorRegistry.js";
import { WhatsAppPlugin } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappPlugin.js";
import { WhatsAppMessageHandler } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.js";
import { InMemoryConnectorDatabase } from "../../../support/fakes.js";

describe("WhatsAppMessageHandler", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  } as any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createRegistry = async (db: InMemoryConnectorDatabase, workspaceId: string) => {
    const registry = new ConnectorRegistry();
    registry.register(new WhatsAppPlugin());
    registry.setEncryptionKey(Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));

    await registry.saveConfig(db as any, workspaceId, "whatsapp", {
      phone_number_id: "15550001111",
      access_token: "wa-access-token",
      app_secret: "app-secret-1234",
      webhook_verify_token: "verify-token-1234",
      business_account_id: "waba-123",
      conversation_timeout_hours: "24",
    });
    await registry.enableConnector(db as any, workspaceId, "whatsapp");

    return registry;
  };

  it("debounces rapid messages into one chat turn and marks logs replied", async () => {
    const db = new InMemoryConnectorDatabase();
    const workspaceId = "workspace-1";
    const registry = await createRegistry(db, workspaceId);
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        answer: "Combined answer",
        retrievalInfo: {
          candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
          fallbackApplied: true,
          rerankStatus: "skipped",
        },
      })),
    } as any;
    const client = {
      sendTextMessage: vi.fn(async () => ({ wamid: "wamid-out-1" })),
    };

    await db.insertInboundMessageLog({
      wamid: "wamid-in-1",
      workspaceId,
      waId: "14155551234",
      messageType: "text",
      payload: { body: "First line" },
    });
    await db.insertInboundMessageLog({
      wamid: "wamid-in-2",
      workspaceId,
      waId: "14155551234",
      messageType: "text",
      payload: { body: "Second line" },
    });

    const handler = new WhatsAppMessageHandler({
      db: db as any,
      logger,
      chatService,
      connectorRegistry: registry,
      client,
      debounceMs: 3000,
    });

    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155551234",
      profileName: "Alicia",
      wamid: "wamid-in-1",
      timestamp: new Date("2026-03-18T10:00:00.000Z"),
      type: "text",
      textBody: "First line",
      payload: { body: "First line" },
    });
    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155551234",
      profileName: "Alicia",
      wamid: "wamid-in-2",
      timestamp: new Date("2026-03-18T10:00:01.000Z"),
      type: "text",
      textBody: "Second line",
      payload: { body: "Second line" },
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(chatService.answer).toHaveBeenCalledTimes(1);
    expect(chatService.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        query: "First line\nSecond line",
      }),
    );
    expect(client.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "15550001111",
      }),
      {
        to: "14155551234",
        text: "Combined answer",
      },
    );

    expect(db.contacts.get(`${workspaceId}:14155551234`)).toMatchObject({
      workspaceId,
      waId: "14155551234",
      conversationId: "conversation-1",
      profileName: "Alicia",
    });
    expect(db.messageLogs.get("wamid-in-1")?.status).toBe("replied");
    expect(db.messageLogs.get("wamid-in-2")?.status).toBe("replied");
    expect(db.messageLogs.get("wamid-out-1")).toMatchObject({
      direction: "outbound",
      status: "replied",
    });
  });

  it("reuses active conversations and rolls over when the timeout expires", async () => {
    const db = new InMemoryConnectorDatabase();
    const workspaceId = "workspace-2";
    const registry = await createRegistry(db, workspaceId);
    const chatService = {
      answer: vi
        .fn()
        .mockResolvedValueOnce({
          conversationId: "conversation-a",
          answer: "First answer",
          retrievalInfo: {
            candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
            fallbackApplied: true,
            rerankStatus: "skipped",
          },
        })
        .mockResolvedValueOnce({
          conversationId: "conversation-a",
          answer: "Second answer",
          retrievalInfo: {
            candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
            fallbackApplied: true,
            rerankStatus: "skipped",
          },
        })
        .mockResolvedValueOnce({
          conversationId: "conversation-b",
          answer: "Third answer",
          retrievalInfo: {
            candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
            fallbackApplied: true,
            rerankStatus: "skipped",
          },
        }),
    } as any;
    const client = {
      sendTextMessage: vi
        .fn()
        .mockResolvedValueOnce({ wamid: "wamid-out-a" })
        .mockResolvedValueOnce({ wamid: "wamid-out-b" })
        .mockResolvedValueOnce({ wamid: "wamid-out-c" }),
    };

    const handler = new WhatsAppMessageHandler({
      db: db as any,
      logger,
      chatService,
      connectorRegistry: registry,
      client,
      debounceMs: 3000,
    });

    await db.insertInboundMessageLog({
      wamid: "wamid-1",
      workspaceId,
      waId: "14155550001",
      messageType: "text",
      payload: { body: "hello" },
    });
    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155550001",
      profileName: "Nina",
      wamid: "wamid-1",
      timestamp: new Date("2026-03-18T10:00:00.000Z"),
      type: "text",
      textBody: "hello",
      payload: { body: "hello" },
    });
    await vi.advanceTimersByTimeAsync(3000);

    await db.insertInboundMessageLog({
      wamid: "wamid-2",
      workspaceId,
      waId: "14155550001",
      messageType: "text",
      payload: { body: "follow up" },
    });
    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155550001",
      profileName: "Nina",
      wamid: "wamid-2",
      timestamp: new Date("2026-03-18T10:10:00.000Z"),
      type: "text",
      textBody: "follow up",
      payload: { body: "follow up" },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(chatService.answer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        conversationId: "conversation-a",
      }),
    );

    vi.setSystemTime(new Date("2026-03-19T11:30:00.000Z"));
    await db.insertInboundMessageLog({
      wamid: "wamid-3",
      workspaceId,
      waId: "14155550001",
      messageType: "text",
      payload: { body: "next day" },
    });
    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155550001",
      profileName: "Nina",
      wamid: "wamid-3",
      timestamp: new Date("2026-03-19T11:30:00.000Z"),
      type: "text",
      textBody: "next day",
      payload: { body: "next day" },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(chatService.answer).toHaveBeenNthCalledWith(
      3,
      expect.not.objectContaining({
        conversationId: "conversation-a",
      }),
    );
    expect(db.contacts.get(`${workspaceId}:14155550001`)?.conversationId).toBe("conversation-b");
  });

  it("sends the unsupported-message fallback without calling chat", async () => {
    const db = new InMemoryConnectorDatabase();
    const workspaceId = "workspace-3";
    const registry = await createRegistry(db, workspaceId);
    const chatService = {
      answer: vi.fn(),
    } as any;
    const client = {
      sendTextMessage: vi.fn(async () => ({ wamid: "wamid-fallback" })),
    };

    await db.insertInboundMessageLog({
      wamid: "wamid-image",
      workspaceId,
      waId: "14155558888",
      messageType: "image",
      payload: { image: true },
    });

    const handler = new WhatsAppMessageHandler({
      db: db as any,
      logger,
      chatService,
      connectorRegistry: registry,
      client,
      debounceMs: 3000,
    });

    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155558888",
      profileName: "Chris",
      wamid: "wamid-image",
      timestamp: new Date("2026-03-18T10:00:00.000Z"),
      type: "image",
      payload: { image: true },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(chatService.answer).not.toHaveBeenCalled();
    expect(client.sendTextMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        text: "Sorry, I can only process text messages at this time.",
      }),
    );
    expect(db.messageLogs.get("wamid-image")?.status).toBe("replied");
  });

  it("sets connector error status when the Cloud API rejects credentials", async () => {
    const db = new InMemoryConnectorDatabase();
    const workspaceId = "workspace-auth-error";
    const registry = await createRegistry(db, workspaceId);
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-auth-error",
        answer: "Will fail to send",
        retrievalInfo: {
          candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
          fallbackApplied: true,
          rerankStatus: "skipped",
        },
      })),
    } as any;
    const client = {
      sendTextMessage: vi.fn(async () => {
        throw new WhatsAppClientError("Invalid WhatsApp access token", 401, false);
      }),
    };

    await db.insertInboundMessageLog({
      wamid: "wamid-auth-error",
      workspaceId,
      waId: "14155559999",
      messageType: "text",
      payload: { body: "hello" },
    });

    const handler = new WhatsAppMessageHandler({
      db: db as any,
      logger,
      chatService,
      connectorRegistry: registry,
      client,
      debounceMs: 3000,
    });

    await handler.handleInboundMessage({
      workspaceId,
      waId: "14155559999",
      profileName: "Alicia",
      wamid: "wamid-auth-error",
      timestamp: new Date("2026-03-18T10:00:00.000Z"),
      type: "text",
      textBody: "hello",
      payload: { body: "hello" },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(db.configs.get(`${workspaceId}:whatsapp`)?.errorStatus).toBe("Invalid WhatsApp access token");
    expect(db.messageLogs.get("wamid-auth-error")?.status).toBe("failed");
    expect(
      [...db.messageLogs.values()].find((record) => record.direction === "outbound" && record.status === "failed"),
    ).toBeDefined();
  });
});
