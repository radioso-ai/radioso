import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorChatPort, ConnectorStatePort } from "@radioso/connector-api";
import { AppError } from "../../../../src/shared/domain/errors.js";
import {
  CONNECTOR_IMAGES_STALE_CODE,
  CONNECTOR_IMAGES_UNAVAILABLE_CODE,
  CONNECTOR_IMAGES_UNUSABLE_CODE,
} from "../../../../src/modules/connectors/services/connectorImageTurns.js";
import { WhatsAppClientError } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import type { WhatsAppClient } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { WhatsAppMessageHandler, type WhatsAppInboundMessage } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.js";
import {
  photoReceiptOf,
  type WhatsAppContactRecord,
  type WhatsAppMessageLogRecord,
  type WhatsAppPersistencePort,
} from "../../../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";

class InMemoryWhatsAppPersistence implements WhatsAppPersistencePort {
  readonly contacts = new Map<string, WhatsAppContactRecord>();
  readonly messageLogs = new Map<string, WhatsAppMessageLogRecord>();

  async findContact(workspaceId: string, waId: string): Promise<WhatsAppContactRecord | null> {
    return this.contacts.get(`${workspaceId}:${waId}`) ?? null;
  }

  async upsertContact(input: {
    workspaceId: string;
    waId: string;
    profileName: string | null;
    conversationId: string;
    lastMessageAt: Date;
  }): Promise<WhatsAppContactRecord> {
    const key = `${input.workspaceId}:${input.waId}`;
    const existing = this.contacts.get(key);
    const record: WhatsAppContactRecord = {
      id: existing?.id ?? `contact-${this.contacts.size + 1}`,
      workspaceId: input.workspaceId,
      waId: input.waId,
      profileName: input.profileName,
      conversationId: input.conversationId,
      firstSeenAt: existing?.firstSeenAt ?? new Date(),
      lastMessageAt: input.lastMessageAt,
    };
    this.contacts.set(key, record);
    return record;
  }

  async findMessageLogByWamid(wamid: string): Promise<WhatsAppMessageLogRecord | null> {
    return this.messageLogs.get(wamid) ?? null;
  }

  async createMessageLog(input: {
    wamid: string;
    direction: "inbound" | "outbound";
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
    status: WhatsAppMessageLogRecord["status"];
    errorDetails?: string | null;
  }): Promise<WhatsAppMessageLogRecord> {
    const record: WhatsAppMessageLogRecord = {
      id: `log-${this.messageLogs.size + 1}`,
      wamid: input.wamid,
      direction: input.direction,
      workspaceId: input.workspaceId,
      waId: input.waId,
      messageType: input.messageType,
      payload: input.payload,
      status: input.status,
      errorDetails: input.errorDetails ?? null,
      createdAt: new Date(),
    };
    this.messageLogs.set(input.wamid, record);
    return record;
  }

  async createInboundMessageLog(input: {
    wamid: string;
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
  }): Promise<WhatsAppMessageLogRecord | null> {
    if (this.messageLogs.has(input.wamid)) {
      return null;
    }
    return this.createMessageLog({
      ...input,
      direction: "inbound",
      status: "received",
    });
  }

  async findPendingOutboundReply(input: {
    workspaceId: string;
    waId: string;
    inboundWamids: string[];
  }): Promise<WhatsAppMessageLogRecord | null> {
    return [...this.messageLogs.values()]
      .filter((record) =>
        record.direction === "outbound" &&
        record.workspaceId === input.workspaceId &&
        record.waId === input.waId &&
        ["processing", "retryable_failed"].includes(record.status) &&
        JSON.stringify(record.payload.inbound_wamids) === JSON.stringify(input.inboundWamids))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async findDeliveredOutboundReply(input: {
    workspaceId: string;
    waId: string;
    inboundWamids: string[];
  }): Promise<WhatsAppMessageLogRecord | null> {
    return [...this.messageLogs.values()]
      .filter((record) =>
        record.direction === "outbound" &&
        record.workspaceId === input.workspaceId &&
        record.waId === input.waId &&
        record.status === "replied" &&
        JSON.stringify(record.payload.inbound_wamids) === JSON.stringify(input.inboundWamids))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async markOutboundReplyDelivered(input: {
    outboundWamid: string;
    inboundWamids: string[];
  }): Promise<void> {
    await this.updateMessageLogStatus(input.outboundWamid, "replied");
    for (const wamid of input.inboundWamids) {
      await this.updateMessageLogStatus(wamid, "replied");
    }
  }

  async updateMessageLogStatus(
    wamid: string,
    status: WhatsAppMessageLogRecord["status"],
    errorDetails?: string | null,
  ): Promise<void> {
    const existing = this.messageLogs.get(wamid);
    if (existing) {
      existing.status = status;
      existing.errorDetails = errorDetails ?? null;
    }
  }

  async listRecoverableInboundLogs(): Promise<WhatsAppMessageLogRecord[]> {
    return [...this.messageLogs.values()].filter(
      (record) => record.direction === "inbound" && ["received", "processing", "retryable_failed"].includes(record.status),
    );
  }

  async savePhotoReceipt(wamid: string, receipt: string): Promise<void> {
    const existing = this.messageLogs.get(wamid);
    if (existing?.direction === "inbound") {
      existing.payload = { ...existing.payload, radioso: { photoReceipt: receipt } };
    }
  }

  nextLocalOutboundWamid(): string {
    return `local-${this.messageLogs.size + 1}`;
  }
}

const inbound = (overrides: Partial<WhatsAppInboundMessage> = {}): WhatsAppInboundMessage => ({
  workspaceId: "workspace-1",
  waId: "14155551234",
  profileName: "Alicia",
  wamid: "wamid-in-1",
  phoneNumberId: "15550001111",
  timestamp: new Date("2026-03-18T10:00:00.000Z"),
  type: "text",
  textBody: "Hello",
  payload: { body: "Hello" },
  ...overrides,
});

describe("WhatsAppMessageHandler", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createHandler = (input?: {
    persistence?: InMemoryWhatsAppPersistence;
    chat?: Pick<ConnectorChatPort, "answer"> & Partial<Pick<ConnectorChatPort, "imageAllowance">>;
    client?: Pick<WhatsAppClient, "sendTextMessage"> & Partial<Pick<WhatsAppClient, "downloadImage">>;
    enabled?: boolean;
    setErrorStatus?: ConnectorStatePort["setErrorStatus"];
    retryBaseDelayMs?: number;
    maxRetryAttempts?: number;
    unsupportedMessageReply?: string;
  }) => {
    const persistence = input?.persistence ?? new InMemoryWhatsAppPersistence();
    // Photos are off unless a test turns them on: the agent allows none, so an image is an unsupported message.
    const chat = {
      imageAllowance: vi.fn<ConnectorChatPort["imageAllowance"]>(async () => null),
      ...(input?.chat ?? {
        answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-1", answer: "Combined answer", outcome: "answered" })),
      }),
    };
    const client = {
      downloadImage: vi.fn<WhatsAppClient["downloadImage"]>(async () => {
        throw new Error("no photo download expected");
      }),
      ...(input?.client ?? {
        sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>(async () => ({ wamid: "wamid-out-1" })),
      }),
    };
    const setErrorStatus = input?.setErrorStatus ?? vi.fn<ConnectorStatePort["setErrorStatus"]>(async () => {});
    const handler = new WhatsAppMessageHandler({
      db: { query: vi.fn() },
      logger,
      chat,
      state: {
        getConfig: async () => ({
          enabled: input?.enabled ?? true,
          config: {
            phone_number_id: "15550001111",
            access_token: "wa-access-token",
            app_secret: "app-secret",
            webhook_verify_token: "verify-token",
            business_account_id: "waba-123",
            conversation_timeout_hours: "24",
            ...(input?.unsupportedMessageReply ? { unsupported_message_reply: input.unsupportedMessageReply } : {}),
          },
        }),
        setErrorStatus,
      },
      client,
      persistence,
      debounceMs: 3000,
      retryBaseDelayMs: input?.retryBaseDelayMs,
      maxRetryAttempts: input?.maxRetryAttempts,
    });

    return { handler, persistence, chat, client, setErrorStatus };
  };

  it("debounces rapid messages into one chat turn and marks logs replied", async () => {
    const { handler, persistence, chat, client } = createHandler();
    await persistence.createMessageLog({
      wamid: "wamid-in-1",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "First line" },
      status: "received",
    });
    await persistence.createMessageLog({
      wamid: "wamid-in-2",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "Second line" },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-in-1", textBody: "First line" }));
    await handler.handleInboundMessage(inbound({
      wamid: "wamid-in-2",
      textBody: "Second line",
      timestamp: new Date("2026-03-18T10:00:01.000Z"),
    }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      query: "First line\nSecond line",
      sourceChannel: "whatsapp",
    }));
    expect(client.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "15550001111" }),
      { to: "14155551234", text: "Combined answer", outboundWamid: expect.any(String) },
    );
    expect(persistence.contacts.get("workspace-1:14155551234")).toMatchObject({
      conversationId: "conversation-1",
      profileName: "Alicia",
    });
    expect(persistence.messageLogs.get("wamid-in-1")?.status).toBe("replied");
    expect(persistence.messageLogs.get("wamid-in-2")?.status).toBe("replied");
    expect([...persistence.messageLogs.values()].find((record) => record.direction === "outbound")).toMatchObject({
      direction: "outbound",
      status: "replied",
      payload: {
        text: "Combined answer",
        inbound_wamids: ["wamid-in-1", "wamid-in-2"],
      },
    });
  });

  it("reuses active conversations and rolls over when the timeout expires", async () => {
    const chat = {
      answer: vi
        .fn()
        .mockResolvedValueOnce({ conversationId: "conversation-a", answer: "First answer", outcome: "answered" })
        .mockResolvedValueOnce({ conversationId: "conversation-a", answer: "Second answer", outcome: "answered" })
        .mockResolvedValueOnce({ conversationId: "conversation-b", answer: "Third answer", outcome: "answered" }),
    };
    const client = {
      sendTextMessage: vi
        .fn()
        .mockResolvedValueOnce({ wamid: "wamid-out-a" })
        .mockResolvedValueOnce({ wamid: "wamid-out-b" })
        .mockResolvedValueOnce({ wamid: "wamid-out-c" }),
    };
    const { handler, persistence } = createHandler({ chat, client });

    for (const message of [
      inbound({ wamid: "wamid-1", textBody: "hello" }),
      inbound({ wamid: "wamid-2", textBody: "follow up", timestamp: new Date("2026-03-18T10:10:00.000Z") }),
      inbound({ wamid: "wamid-3", textBody: "next day", timestamp: new Date("2026-03-19T11:30:00.000Z") }),
    ]) {
      await persistence.createMessageLog({
        wamid: message.wamid,
        direction: "inbound",
        workspaceId: message.workspaceId,
        waId: message.waId,
        messageType: "text",
        payload: { body: message.textBody },
        status: "received",
      });
      await handler.handleInboundMessage(message);
      await vi.advanceTimersByTimeAsync(3000);
    }

    expect(chat.answer).toHaveBeenNthCalledWith(2, expect.objectContaining({ conversationId: "conversation-a" }));
    expect(chat.answer).toHaveBeenNthCalledWith(3, expect.not.objectContaining({ conversationId: "conversation-a" }));
    expect(persistence.contacts.get("workspace-1:14155551234")?.conversationId).toBe("conversation-b");
  });

  it("sends configured unsupported-message copy without persisting an internal chat turn", async () => {
    const chat = {
      answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-media", answer: "Assistant media reply", outcome: "answered" })),
    };
    const { handler, persistence, client } = createHandler({
      chat,
      unsupportedMessageReply: "Please send your request as text.",
    });
    await persistence.createMessageLog({
      wamid: "wamid-image",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "image",
      payload: { image: true },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-image", type: "image", textBody: undefined }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).not.toHaveBeenCalled();
    expect(client.sendTextMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ text: "Please send your request as text." }),
    );
    expect(persistence.messageLogs.get("wamid-image")?.status).toBe("replied");
  });

  it("skips unsupported messages when no configured copy exists", async () => {
    const chat = { answer: vi.fn<ConnectorChatPort["answer"]>() };
    const { handler, persistence, client } = createHandler({ chat });
    await persistence.createMessageLog({
      wamid: "wamid-image-skip",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "image",
      payload: { image: true },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-image-skip", type: "image", textBody: undefined }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).not.toHaveBeenCalled();
    expect(client.sendTextMessage).not.toHaveBeenCalled();
    expect(persistence.messageLogs.get("wamid-image-skip")?.status).toBe("skipped");
  });

  it("processes text messages separately from unsupported messages in a mixed batch", async () => {
    const chat = {
      answer: vi
        .fn<ConnectorChatPort["answer"]>()
        .mockResolvedValueOnce({ conversationId: "conversation-text", answer: "Text answer", outcome: "answered" }),
    };
    const client = {
      sendTextMessage: vi
        .fn<WhatsAppClient["sendTextMessage"]>()
        .mockResolvedValueOnce({ wamid: "wamid-out-text" })
        .mockResolvedValueOnce({ wamid: "wamid-out-media" }),
    };
    const { handler, persistence } = createHandler({
      chat,
      client,
      unsupportedMessageReply: "Please send text.",
    });
    await persistence.createMessageLog({
      wamid: "wamid-text",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "What are your hours?" },
      status: "received",
    });
    await persistence.createMessageLog({
      wamid: "wamid-image",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "image",
      payload: { image: true },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-text", textBody: "What are your hours?" }));
    await handler.handleInboundMessage(inbound({
      wamid: "wamid-image",
      type: "image",
      textBody: undefined,
      timestamp: new Date("2026-03-18T10:00:01.000Z"),
    }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).toHaveBeenNthCalledWith(1, expect.objectContaining({ query: "What are your hours?" }));
    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(client.sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Object), expect.objectContaining({ text: "Please send text." }));
    expect(persistence.messageLogs.get("wamid-text")?.status).toBe("replied");
    expect(persistence.messageLogs.get("wamid-image")?.status).toBe("replied");
  });

  it("keeps retryable processing failures recoverable and retries them", async () => {
    const chat = {
      answer: vi
        .fn<ConnectorChatPort["answer"]>()
        .mockRejectedValueOnce(new Error("temporary LLM outage"))
        .mockResolvedValueOnce({ conversationId: "conversation-retry", answer: "Recovered answer", outcome: "answered" }),
    };
    const { handler, persistence, client } = createHandler({
      chat,
      retryBaseDelayMs: 1000,
      maxRetryAttempts: 3,
    });
    await persistence.createMessageLog({
      wamid: "wamid-retry",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "hello" },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-retry" }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(persistence.messageLogs.get("wamid-retry")?.status).toBe("retryable_failed");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).toHaveBeenCalledTimes(2);
    expect(client.sendTextMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ text: "Recovered answer" }),
    );
    expect(persistence.messageLogs.get("wamid-retry")?.status).toBe("replied");
  });

  it("retries WhatsApp delivery without rerunning the assistant turn", async () => {
    const chat = {
      answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-delivery", answer: "Stable answer", outcome: "answered" })),
    };
    const client = {
      sendTextMessage: vi
        .fn<WhatsAppClient["sendTextMessage"]>()
        .mockRejectedValueOnce(new WhatsAppClientError("WhatsApp rate limited", 429, true))
        .mockResolvedValueOnce({ wamid: "wamid-out-delivered" }),
    };
    const { handler, persistence } = createHandler({
      chat,
      client,
      retryBaseDelayMs: 1000,
      maxRetryAttempts: 3,
    });
    await persistence.createMessageLog({
      wamid: "wamid-delivery-retry",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "hello" },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-delivery-retry", textBody: "hello" }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(persistence.messageLogs.get("wamid-delivery-retry")?.status).toBe("retryable_failed");
    expect([...persistence.messageLogs.values()].find((record) => record.direction === "outbound")).toMatchObject({
      status: "retryable_failed",
      payload: {
        text: "Stable answer",
        inbound_wamids: ["wamid-delivery-retry"],
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(client.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(client.sendTextMessage).toHaveBeenLastCalledWith(expect.any(Object), {
      to: "14155551234",
      text: "Stable answer",
      outboundWamid: expect.any(String),
    });
    expect(persistence.messageLogs.get("wamid-delivery-retry")?.status).toBe("replied");
  });

  it("uses delivered outbound evidence on recovery without rerunning chat or resending", async () => {
    const persistence = new InMemoryWhatsAppPersistence();
    await persistence.createMessageLog({
      wamid: "wamid-crash-window",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "hello" },
      status: "processing",
    });
    await persistence.createMessageLog({
      wamid: "local-delivered-before-crash",
      direction: "outbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: {
        text: "Already sent",
        inbound_wamids: ["wamid-crash-window"],
      },
      status: "replied",
    });
    const chat = {
      answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-duplicate", answer: "Duplicate answer", outcome: "answered" })),
    };
    const client = {
      sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>(async () => ({ wamid: "wamid-duplicate-send" })),
    };
    const { handler } = createHandler({ persistence, chat, client });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-crash-window", textBody: "hello" }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).not.toHaveBeenCalled();
    expect(client.sendTextMessage).not.toHaveBeenCalled();
    expect(persistence.messageLogs.get("wamid-crash-window")?.status).toBe("replied");
  });

  it("continues processing unsupported messages when a text group fails", async () => {
    const chat = {
      answer: vi
        .fn<ConnectorChatPort["answer"]>()
        .mockRejectedValueOnce(new Error("temporary LLM outage")),
    };
    const client = {
      sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>(async () => ({ wamid: "wamid-out-media" })),
    };
    const { handler, persistence } = createHandler({
      chat,
      client,
      retryBaseDelayMs: 1000,
      maxRetryAttempts: 3,
      unsupportedMessageReply: "Please send text.",
    });
    await persistence.createMessageLog({
      wamid: "wamid-text-fail",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "What are your hours?" },
      status: "received",
    });
    await persistence.createMessageLog({
      wamid: "wamid-image-after-fail",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "image",
      payload: { image: true },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-text-fail", textBody: "What are your hours?" }));
    await handler.handleInboundMessage(inbound({
      wamid: "wamid-image-after-fail",
      type: "image",
      textBody: undefined,
      timestamp: new Date("2026-03-18T10:00:01.000Z"),
    }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Please send text." }));
    expect(persistence.messageLogs.get("wamid-text-fail")?.status).toBe("retryable_failed");
    expect(persistence.messageLogs.get("wamid-image-after-fail")?.status).toBe("replied");

    await handler.shutdown();
  });

  describe("photos", () => {
    const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 9]);
    const photoMessage = (n: number, overrides: Partial<WhatsAppInboundMessage> = {}): WhatsAppInboundMessage => inbound({
      wamid: `wamid-photo-${n}`,
      type: "image",
      textBody: undefined,
      image: { mediaId: `media-${n}` },
      timestamp: new Date(`2026-03-18T10:00:0${n}.000Z`),
      ...overrides,
    });
    const logInbound = async (persistence: InMemoryWhatsAppPersistence, message: WhatsAppInboundMessage) => {
      await persistence.createMessageLog({
        wamid: message.wamid,
        direction: "inbound",
        workspaceId: message.workspaceId,
        waId: message.waId,
        messageType: message.type,
        payload: { wamid: message.wamid },
        status: "received",
      });
    };
    const send = async (persistence: InMemoryWhatsAppPersistence, handler: WhatsAppMessageHandler, messages: WhatsAppInboundMessage[]) => {
      for (const message of messages) {
        if (!persistence.messageLogs.has(message.wamid)) {
          await logInbound(persistence, message);
        }
        await handler.handleInboundMessage(message);
      }
      await vi.advanceTimersByTimeAsync(3000);
    };
    const photosOn = (maxImages = 3) => ({
      answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-photo", answer: "Lovely place.", outcome: "answered" })),
      imageAllowance: vi.fn<ConnectorChatPort["imageAllowance"]>(async () => ({ maxImages })),
    });
    const downloads = () => vi.fn<WhatsAppClient["downloadImage"]>(async () => ({ kind: "downloaded", bytes: PHOTO }));
    const sender = () => ({ sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>(async () => ({ wamid: "wamid-out-1" })) });

    it("answers a photo with a caption as one turn: the caption is the typed text and the photo is the image", async () => {
      const chat = photosOn();
      const downloadImage = downloads();
      const { handler, persistence, client } = createHandler({ chat, client: { ...sender(), downloadImage } });

      await send(persistence, handler, [photoMessage(1, { textBody: "Something like this, near the coast" })]);

      expect(downloadImage).toHaveBeenCalledWith({ accessToken: "wa-access-token" }, { mediaId: "media-1", wamid: "wamid-photo-1" });
      expect(chat.answer).toHaveBeenCalledTimes(1);
      expect(chat.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        conversationId: undefined,
        query: "Something like this, near the coast",
        sourceChannel: "whatsapp",
        images: [{ key: "wamid-photo-1", bytes: PHOTO }],
        onImagesStored: expect.any(Function),
      });
      expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Lovely place." }));
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
    });

    it("answers a photo with no caption on the photo alone", async () => {
      const chat = photosOn();
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() } });

      await send(persistence, handler, [photoMessage(1)]);

      expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({ query: "", images: [{ key: "wamid-photo-1", bytes: PHOTO }] }));
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
    });

    it("turns an album sent in a row into one turn, the photos in the order they were sent", async () => {
      const chat = photosOn();
      const downloadImage = vi.fn<WhatsAppClient["downloadImage"]>(async (_config, input) => ({
        kind: "downloaded",
        bytes: Buffer.from(input.mediaId),
      }));
      const { handler, persistence, client } = createHandler({ chat, client: { ...sender(), downloadImage } });

      // The webhook delivers them out of order; the turn follows the senders' clock.
      await send(persistence, handler, [
        photoMessage(2),
        photoMessage(1),
        photoMessage(3, { textBody: "These three" }),
      ]);

      expect(chat.answer).toHaveBeenCalledTimes(1);
      expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
        query: "These three",
        images: [{ key: "wamid-photo-1", bytes: Buffer.from("media-1") }, { key: "wamid-photo-2", bytes: Buffer.from("media-2") }, { key: "wamid-photo-3", bytes: Buffer.from("media-3") }],
      }));
      expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
      for (const wamid of ["wamid-photo-1", "wamid-photo-2", "wamid-photo-3"]) {
        expect(persistence.messageLogs.get(wamid)?.status).toBe("replied");
      }
    });

    it("carries photos beyond what a turn takes as unsupported messages", async () => {
      const chat = photosOn(2);
      const downloadImage = downloads();
      const { handler, persistence, client } = createHandler({ chat, client: { ...sender(), downloadImage } });

      await send(persistence, handler, [photoMessage(1), photoMessage(2), photoMessage(3)]);

      expect(downloadImage).toHaveBeenCalledTimes(2);
      expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({ images: [{ key: "wamid-photo-1", bytes: PHOTO }, { key: "wamid-photo-2", bytes: PHOTO }] }));
      expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      expect(persistence.messageLogs.get("wamid-photo-2")?.status).toBe("replied");
      expect(persistence.messageLogs.get("wamid-photo-3")?.status).toBe("skipped");
    });

    it("answers typed text and a photo sent together as one turn", async () => {
      const chat = photosOn();
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() } });

      await send(persistence, handler, [
        inbound({ wamid: "wamid-text-1", textBody: "I am looking for a house" }),
        photoMessage(1, { textBody: "like this one" }),
      ]);

      expect(chat.answer).toHaveBeenCalledTimes(1);
      expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
        query: "I am looking for a house\nlike this one",
        images: [{ key: "wamid-photo-1", bytes: PHOTO }],
      }));
    });

    it("treats a photo as an unsupported message when the agent allows none, without downloading it", async () => {
      const chat = {
        answer: vi.fn<ConnectorChatPort["answer"]>(),
        imageAllowance: vi.fn<ConnectorChatPort["imageAllowance"]>(async () => null),
      };
      const downloadImage = downloads();
      const { handler, persistence, client } = createHandler({
        chat,
        client: { ...sender(), downloadImage },
        unsupportedMessageReply: "Please send your request as text.",
      });

      await send(persistence, handler, [photoMessage(1, { textBody: "Something like this" })]);

      expect(downloadImage).not.toHaveBeenCalled();
      expect(chat.answer).not.toHaveBeenCalled();
      expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Please send your request as text." }));
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
    });

    it("skips a photo the agent cannot read when no unsupported-message reply is configured", async () => {
      const chat = { answer: vi.fn<ConnectorChatPort["answer"]>(), imageAllowance: vi.fn<ConnectorChatPort["imageAllowance"]>(async () => null) };
      const { handler, persistence, client } = createHandler({ chat, client: sender() });

      await send(persistence, handler, [photoMessage(1)]);

      expect(client.sendTextMessage).not.toHaveBeenCalled();
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("skipped");
    });

    it("asks only when a batch carries a photo", async () => {
      const chat = photosOn();
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() } });

      await send(persistence, handler, [inbound({ wamid: "wamid-plain", textBody: "Hello" })]);

      expect(chat.imageAllowance).not.toHaveBeenCalled();
    });

    it("asks about the conversation the sender is in, and about a new one once it has timed out", async () => {
      const chat = photosOn();
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() } });
      await persistence.upsertContact({
        workspaceId: "workspace-1",
        waId: "14155551234",
        profileName: "Alicia",
        conversationId: "conversation-existing",
        lastMessageAt: new Date("2026-03-18T09:00:00.000Z"),
      });

      await send(persistence, handler, [photoMessage(1)]);

      expect(chat.imageAllowance).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", conversationId: "conversation-existing" });
      expect(chat.answer).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: "conversation-existing" }));

      await send(persistence, handler, [photoMessage(2, { timestamp: new Date("2026-03-20T12:00:00.000Z") })]);

      expect(chat.imageAllowance).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", conversationId: undefined });
    });

    it("treats a photo as unsupported, and says why in the log, when the allowance cannot be had", async () => {
      const chat = {
        answer: vi.fn<ConnectorChatPort["answer"]>(),
        imageAllowance: vi.fn<ConnectorChatPort["imageAllowance"]>(async () => {
          throw new Error("agent lookup failed for 14155551234");
        }),
      };
      const { handler, persistence } = createHandler({ chat, client: sender() });

      await send(persistence, handler, [photoMessage(1)]);

      expect(chat.answer).not.toHaveBeenCalled();
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("skipped");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace-1", errorClass: "Error" }),
        "WhatsApp photo support could not be determined",
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("14155551234");
    });

    it("answers the caption alone when its photo is gone", async () => {
      const chat = photosOn();
      const downloadImage = vi.fn<WhatsAppClient["downloadImage"]>(async () => ({ kind: "unavailable", reason: "not_found" }));
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage } });

      await send(persistence, handler, [photoMessage(1, { textBody: "Do you have this in blue?" })]);

      expect(chat.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        conversationId: undefined,
        query: "Do you have this in blue?",
        sourceChannel: "whatsapp",
      });
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
    });

    describe("when no photo of the turn can be used and nothing was typed", () => {
      const refusedByHost = () => ({
        ...photosOn(),
        answer: vi.fn<ConnectorChatPort["answer"]>(async () => {
          throw new AppError(422, CONNECTOR_IMAGES_UNUSABLE_CODE, "None of the images could be used and there is no text to answer");
        }),
      });
      const goneOnWhatsApp = () => vi.fn<WhatsAppClient["downloadImage"]>(async () => ({ kind: "unavailable", reason: "too_large" }));

      it.each([
        ["every photo is gone or over the cap", () => ({ chat: photosOn(), downloadImage: goneOnWhatsApp() })],
        ["the host refuses every photo", () => ({ chat: refusedByHost(), downloadImage: downloads() })],
      ])("sends the configured unsupported-message reply when %s", async (_label, build) => {
        const { chat, downloadImage } = build();
        const { handler, persistence, client } = createHandler({
          chat,
          client: { ...sender(), downloadImage },
          unsupportedMessageReply: "Please send your request as text.",
          maxRetryAttempts: 3,
        });

        await send(persistence, handler, [photoMessage(1), photoMessage(2)]);

        expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Please send your request as text." }));
        for (const wamid of ["wamid-photo-1", "wamid-photo-2"]) {
          expect(persistence.messageLogs.get(wamid)).toMatchObject({ status: "replied", errorDetails: null });
        }
        // Nothing is left to retry: the outcome is the unsupported-message one, not a failure.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
      });

      it.each([
        ["every photo is gone or over the cap", () => ({ chat: photosOn(), downloadImage: goneOnWhatsApp() })],
        ["the host refuses every photo", () => ({ chat: refusedByHost(), downloadImage: downloads() })],
      ])("skips the messages, as for any unsupported message, when %s and no reply is configured", async (_label, build) => {
        const { chat, downloadImage } = build();
        const { handler, persistence, client } = createHandler({ chat, client: { ...sender(), downloadImage }, maxRetryAttempts: 3 });

        await send(persistence, handler, [photoMessage(1)]);

        expect(client.sendTextMessage).not.toHaveBeenCalled();
        expect(persistence.messageLogs.get("wamid-photo-1")).toMatchObject({ status: "skipped", errorDetails: "Unsupported WhatsApp message type" });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(chat.answer.mock.calls.length).toBeLessThanOrEqual(1);
      });
    });

    describe("when the host refuses the turn's photos", () => {
      const refusing = (error: AppError) => ({
        ...photosOn(),
        answer: vi.fn<ConnectorChatPort["answer"]>().mockRejectedValue(error),
      });
      const overPlan = () => new AppError(429, "usage_limit_exceeded", "Usage limit exceeded");

      it("treats an over-plan photo as it treats an over-plan text turn: a retryable failure with no reply", async () => {
        const text = createHandler({ chat: { answer: vi.fn<ConnectorChatPort["answer"]>().mockRejectedValue(overPlan()) }, client: sender(), unsupportedMessageReply: "Text only, please." });
        const photo = createHandler({ chat: refusing(overPlan()), client: { ...sender(), downloadImage: downloads() }, unsupportedMessageReply: "Text only, please." });

        await send(text.persistence, text.handler, [inbound({ wamid: "wamid-text-over-plan", textBody: "Hello" })]);
        await send(photo.persistence, photo.handler, [photoMessage(1)]);

        expect(text.persistence.messageLogs.get("wamid-text-over-plan")?.status).toBe("retryable_failed");
        expect(photo.persistence.messageLogs.get("wamid-photo-1")?.status).toBe("retryable_failed");
        expect(photo.client.sendTextMessage).not.toHaveBeenCalled();
        await text.handler.shutdown();
        await photo.handler.shutdown();
      });

      it("retries a busy upload through the existing machinery and answers once it clears", async () => {
        const chat = {
          ...photosOn(),
          answer: vi.fn<ConnectorChatPort["answer"]>()
            .mockRejectedValueOnce(new AppError(503, "visitor_image_busy", "Too many images are being processed."))
            .mockResolvedValueOnce({ conversationId: "conversation-photo", answer: "Lovely place.", outcome: "answered" }),
        };
        const { handler, persistence } = createHandler({
          chat,
          client: { ...sender(), downloadImage: downloads() },
          retryBaseDelayMs: 1000,
          maxRetryAttempts: 3,
        });

        await send(persistence, handler, [photoMessage(1, { textBody: "This one" })]);
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("retryable_failed");

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);

        expect(chat.answer).toHaveBeenCalledTimes(2);
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      });

      it("handles an uncaptioned photo as unsupported when the agent stops taking photos while the turn runs", async () => {
        const chat = refusing(new AppError(409, CONNECTOR_IMAGES_UNAVAILABLE_CODE, "This agent does not read images."));
        const { handler, persistence, client } = createHandler({
          chat,
          client: { ...sender(), downloadImage: downloads() },
          unsupportedMessageReply: "Please send your request as text.",
        });

        await send(persistence, handler, [photoMessage(1)]);

        expect(chat.answer).toHaveBeenCalledTimes(1);
        expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Please send your request as text." }));
        expect(persistence.messageLogs.get("wamid-photo-1")).toMatchObject({ status: "replied", errorDetails: null });
      });

      it("answers the caption as text when the agent stops taking photos while the turn runs", async () => {
        const chat = {
          ...photosOn(),
          answer: vi.fn<ConnectorChatPort["answer"]>()
            .mockRejectedValueOnce(new AppError(409, CONNECTOR_IMAGES_UNAVAILABLE_CODE, "This agent does not read images."))
            .mockResolvedValueOnce({ conversationId: "conversation-text", answer: "Happy to help.", outcome: "answered" }),
        };
        const downloadImage = downloads();
        const { handler, persistence, client } = createHandler({
          chat,
          client: { ...sender(), downloadImage },
          unsupportedMessageReply: "Please send your request as text.",
        });

        await send(persistence, handler, [photoMessage(1, { textBody: "Something like this" })]);

        expect(chat.answer).toHaveBeenCalledTimes(2);
        expect(chat.answer).toHaveBeenNthCalledWith(2, expect.objectContaining({ query: "Something like this" }));
        expect(chat.answer).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ images: expect.anything() }));
        expect(downloadImage).toHaveBeenCalledTimes(1);
        expect(client.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Happy to help." }));
        expect(persistence.messageLogs.get("wamid-photo-1")).toMatchObject({ status: "replied", errorDetails: null });
      });

      it("still answers the typed text of the batch once the photos turn out to be unsupported", async () => {
        const chat = {
          ...photosOn(),
          answer: vi.fn<ConnectorChatPort["answer"]>()
            .mockRejectedValueOnce(new AppError(409, CONNECTOR_IMAGES_UNAVAILABLE_CODE, "This agent does not read images."))
            .mockResolvedValueOnce({ conversationId: "conversation-text", answer: "Happy to help.", outcome: "answered" }),
        };
        const client = {
          downloadImage: downloads(),
          sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>()
            .mockResolvedValueOnce({ wamid: "wamid-out-text" })
            .mockResolvedValueOnce({ wamid: "wamid-out-unsupported" }),
        };
        const { handler, persistence } = createHandler({ chat, client, unsupportedMessageReply: "Please send text." });

        await send(persistence, handler, [inbound({ wamid: "wamid-text-1", textBody: "I am looking for a house" }), photoMessage(1)]);

        expect(chat.answer).toHaveBeenCalledTimes(2);
        expect(chat.answer).toHaveBeenNthCalledWith(1, expect.objectContaining({ query: "I am looking for a house", images: [{ key: "wamid-photo-1", bytes: PHOTO }] }));
        expect(chat.answer).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ images: expect.anything() }));
        expect(chat.answer).toHaveBeenNthCalledWith(2, expect.objectContaining({ query: "I am looking for a house" }));
        expect(client.sendTextMessage).toHaveBeenNthCalledWith(1, expect.any(Object), expect.objectContaining({ text: "Happy to help." }));
        expect(client.sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Object), expect.objectContaining({ text: "Please send text." }));
        expect(persistence.messageLogs.get("wamid-text-1")?.status).toBe("replied");
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      });
    });

    describe("a retry of a turn", () => {
      const storesThenFails = (error: Error) => async (input: Parameters<ConnectorChatPort["answer"]>[0]) => {
        await input.onImagesStored?.((input.images ?? []).flatMap((image) => (image.bytes ? [{ key: image.key, receipt: `receipt-of-${image.key}` }] : [])));
        throw error;
      };

      it("keeps the receipt of each photo the host stored with its message, even when the turn fails", async () => {
        const chat = { ...photosOn(), answer: vi.fn<ConnectorChatPort["answer"]>(storesThenFails(new Error("model unavailable"))) };
        const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() }, maxRetryAttempts: 5 });

        await send(persistence, handler, [photoMessage(1), photoMessage(2)]);

        expect(photoReceiptOf(persistence.messageLogs.get("wamid-photo-1") ?? null)).toBe("receipt-of-wamid-photo-1");
        expect(photoReceiptOf(persistence.messageLogs.get("wamid-photo-2") ?? null)).toBe("receipt-of-wamid-photo-2");
        await handler.shutdown();
      });

      it("reuses the photos an earlier attempt stored: nothing is downloaded or uploaded again", async () => {
        const chat = {
          ...photosOn(),
          answer: vi.fn<ConnectorChatPort["answer"]>()
            .mockImplementationOnce(storesThenFails(new Error("model unavailable")))
            .mockResolvedValueOnce({ conversationId: "conversation-photo", answer: "Lovely place.", outcome: "answered" }),
        };
        const downloadImage = downloads();
        const { handler, persistence, client } = createHandler({
          chat,
          client: { ...sender(), downloadImage },
          retryBaseDelayMs: 1000,
          maxRetryAttempts: 3,
        });

        await send(persistence, handler, [photoMessage(1, { textBody: "These" }), photoMessage(2)]);
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("retryable_failed");
        expect(downloadImage).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);

        expect(downloadImage).toHaveBeenCalledTimes(2);
        expect(chat.answer).toHaveBeenCalledTimes(2);
        expect(chat.answer).toHaveBeenLastCalledWith(expect.objectContaining({
          query: "These",
          images: [
            { key: "wamid-photo-1", receipt: "receipt-of-wamid-photo-1" },
            { key: "wamid-photo-2", receipt: "receipt-of-wamid-photo-2" },
          ],
        }));
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Lovely place." }));
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      });

      it("downloads only the photos that have no receipt yet", async () => {
        const chat = photosOn();
        const downloadImage = downloads();
        const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage } });
        await logInbound(persistence, photoMessage(1));
        await persistence.savePhotoReceipt("wamid-photo-1", "receipt-1");

        await send(persistence, handler, [photoMessage(1), photoMessage(2)]);

        expect(downloadImage).toHaveBeenCalledTimes(1);
        expect(downloadImage).toHaveBeenCalledWith(expect.anything(), { mediaId: "media-2", wamid: "wamid-photo-2" });
        expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
          images: [{ key: "wamid-photo-1", receipt: "receipt-1" }, { key: "wamid-photo-2", bytes: PHOTO }],
        }));
      });

      it("sends the photos again when the host says a receipt is stale, within the same attempt", async () => {
        const chat = {
          ...photosOn(),
          answer: vi.fn<ConnectorChatPort["answer"]>()
            .mockRejectedValueOnce(new AppError(409, CONNECTOR_IMAGES_STALE_CODE, "A stored image can no longer be used."))
            .mockResolvedValueOnce({ conversationId: "conversation-photo", answer: "Lovely place.", outcome: "answered" }),
        };
        const downloadImage = downloads();
        const { handler, persistence, client } = createHandler({ chat, client: { ...sender(), downloadImage } });
        await logInbound(persistence, photoMessage(1));
        await persistence.savePhotoReceipt("wamid-photo-1", "receipt-1");

        await send(persistence, handler, [photoMessage(1)]);

        expect(chat.answer).toHaveBeenCalledTimes(2);
        expect(chat.answer).toHaveBeenNthCalledWith(1, expect.objectContaining({ images: [{ key: "wamid-photo-1", receipt: "receipt-1" }] }));
        expect(chat.answer).toHaveBeenNthCalledWith(2, expect.objectContaining({ images: [{ key: "wamid-photo-1", bytes: PHOTO }] }));
        expect(downloadImage).toHaveBeenCalledTimes(1);
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Lovely place." }));
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      });

      it("does not loop on a host that calls the photos stale twice", async () => {
        const stale = new AppError(409, CONNECTOR_IMAGES_STALE_CODE, "A stored image can no longer be used.");
        const chat = { ...photosOn(), answer: vi.fn<ConnectorChatPort["answer"]>().mockRejectedValue(stale) };
        const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() }, maxRetryAttempts: 1 });
        await logInbound(persistence, photoMessage(1));
        await persistence.savePhotoReceipt("wamid-photo-1", "receipt-1");

        await send(persistence, handler, [photoMessage(1)]);

        expect(chat.answer).toHaveBeenCalledTimes(2);
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("failed");
      });
    });

    describe("a photo that cannot be downloaded", () => {
      const refused = (statusCode: number, retryable = false) =>
        vi.fn<WhatsAppClient["downloadImage"]>(async () => {
          throw new WhatsAppClientError(`WhatsApp media request failed with status ${statusCode}`, statusCode, retryable);
        });

      it.each([401, 403])("answers the text of the batch when Graph answers %s for good, as for a photo that is gone", async (statusCode) => {
        const chat = photosOn();
        const { handler, persistence, client } = createHandler({
          chat,
          client: { ...sender(), downloadImage: refused(statusCode) },
        });

        await send(persistence, handler, [inbound({ wamid: "wamid-text-1", textBody: "Do you have this in blue?" }), photoMessage(1)]);

        expect(chat.answer).toHaveBeenCalledTimes(1);
        expect(chat.answer).toHaveBeenCalledWith({
          workspaceId: "workspace-1",
          conversationId: undefined,
          query: "Do you have this in blue?",
          sourceChannel: "whatsapp",
        });
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Lovely place." }));
        expect(persistence.messageLogs.get("wamid-text-1")?.status).toBe("replied");
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      });

      it("sets the connector's error status when the access token is rejected, as a rejected reply does", async () => {
        const setErrorStatus = vi.fn(async () => {});
        const { handler, persistence } = createHandler({
          chat: photosOn(),
          client: { ...sender(), downloadImage: refused(401) },
          setErrorStatus,
        });

        await send(persistence, handler, [photoMessage(1, { textBody: "Look" })]);

        expect(setErrorStatus).toHaveBeenCalledWith("workspace-1", "WhatsApp media request failed with status 401");
      });

      it("handles an uncaptioned photo that cannot be downloaded as an unsupported message", async () => {
        const chat = photosOn();
        const client = {
          ...sender(),
          downloadImage: refused(403),
          sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>()
            .mockResolvedValueOnce({ wamid: "wamid-out-1" }),
        };
        const { handler, persistence } = createHandler({ chat, client, unsupportedMessageReply: "Please send text." });

        await send(persistence, handler, [photoMessage(1)]);

        expect(chat.answer).not.toHaveBeenCalled();
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Please send text." }));
        expect(persistence.messageLogs.get("wamid-photo-1")).toMatchObject({ status: "replied", errorDetails: null });
      });

      it("retries a transient failure first, and counts the photo as unavailable only once the retries are used up", async () => {
        const chat = photosOn();
        const downloadImage = refused(503, true);
        const { handler, persistence, client } = createHandler({
          chat,
          client: { ...sender(), downloadImage },
          retryBaseDelayMs: 1000,
          maxRetryAttempts: 2,
        });

        await send(persistence, handler, [photoMessage(1, { textBody: "Do you have this in blue?" })]);
        expect(chat.answer).not.toHaveBeenCalled();
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("retryable_failed");

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);

        expect(downloadImage).toHaveBeenCalledTimes(2);
        expect(chat.answer).toHaveBeenCalledTimes(1);
        expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({ query: "Do you have this in blue?" }));
        expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Lovely place." }));
        expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
      });
    });

    it("puts captions and photos in one order, the order they were sent, however WhatsApp delivered them", async () => {
      const chat = photosOn();
      const downloadImage = vi.fn<WhatsAppClient["downloadImage"]>(async (_config, input) => ({
        kind: "downloaded",
        bytes: Buffer.from(input.mediaId),
      }));
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage } });

      await send(persistence, handler, [
        photoMessage(3, { textBody: "and this is the third" }),
        photoMessage(1, { textBody: "this is the first" }),
        photoMessage(2),
      ]);

      expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
        query: "this is the first\nand this is the third",
        images: [
          { key: "wamid-photo-1", bytes: Buffer.from("media-1") },
          { key: "wamid-photo-2", bytes: Buffer.from("media-2") },
          { key: "wamid-photo-3", bytes: Buffer.from("media-3") },
        ],
      }));
    });

    it("still fails a turn whose answer fails for another reason", async () => {
      const chat = {
        ...photosOn(),
        answer: vi.fn<ConnectorChatPort["answer"]>(async () => {
          throw new Error("model unavailable");
        }),
      };
      const { handler, persistence, client } = createHandler({
        chat,
        client: { ...sender(), downloadImage: downloads() },
        unsupportedMessageReply: "Please send your request as text.",
        maxRetryAttempts: 1,
      });

      await send(persistence, handler, [photoMessage(1)]);

      expect(client.sendTextMessage).not.toHaveBeenCalled();
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("failed");
    });

    it("retries a transient download failure without answering twice", async () => {
      const chat = photosOn();
      const downloadImage = vi.fn<WhatsAppClient["downloadImage"]>()
        .mockRejectedValueOnce(new WhatsAppClientError("WhatsApp media download timed out", 504, true))
        .mockResolvedValueOnce({ kind: "downloaded", bytes: PHOTO });
      const { handler, persistence } = createHandler({
        chat,
        client: { ...sender(), downloadImage },
        retryBaseDelayMs: 1000,
        maxRetryAttempts: 3,
      });

      await send(persistence, handler, [photoMessage(1, { textBody: "This one" })]);

      expect(chat.answer).not.toHaveBeenCalled();
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("retryable_failed");

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(3000);

      expect(downloadImage).toHaveBeenCalledTimes(2);
      expect(chat.answer).toHaveBeenCalledTimes(1);
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
    });

    it("does not download the photo again when only the delivery of the reply is retried", async () => {
      const chat = photosOn();
      const downloadImage = downloads();
      const client = {
        downloadImage,
        sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>()
          .mockRejectedValueOnce(new WhatsAppClientError("WhatsApp rate limited", 429, true))
          .mockResolvedValueOnce({ wamid: "wamid-out-delivered" }),
      };
      const { handler, persistence } = createHandler({ chat, client, retryBaseDelayMs: 1000, maxRetryAttempts: 3 });

      await send(persistence, handler, [photoMessage(1)]);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(3000);

      expect(downloadImage).toHaveBeenCalledTimes(1);
      expect(chat.answer).toHaveBeenCalledTimes(1);
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("replied");
    });

    it("leaves an image message without a media id unsupported", async () => {
      const chat = photosOn();
      const { handler, persistence } = createHandler({ chat, client: { ...sender(), downloadImage: downloads() } });

      await send(persistence, handler, [photoMessage(1, { image: undefined })]);

      expect(chat.answer).not.toHaveBeenCalled();
      expect(persistence.messageLogs.get("wamid-photo-1")?.status).toBe("skipped");
    });
  });

  it("sets connector error status when the Cloud API rejects credentials", async () => {
    const setErrorStatus = vi.fn(async () => {});
    const client = {
      sendTextMessage: vi.fn(async () => {
        throw new WhatsAppClientError("Invalid WhatsApp access token", 401, false);
      }),
    };
    const { handler, persistence } = createHandler({ client, setErrorStatus });
    await persistence.createMessageLog({
      wamid: "wamid-auth-error",
      direction: "inbound",
      workspaceId: "workspace-1",
      waId: "14155551234",
      messageType: "text",
      payload: { body: "hello" },
      status: "received",
    });

    await handler.handleInboundMessage(inbound({ wamid: "wamid-auth-error" }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(setErrorStatus).toHaveBeenCalledWith("workspace-1", "Invalid WhatsApp access token");
    expect(persistence.messageLogs.get("wamid-auth-error")?.status).toBe("failed");
    expect([...persistence.messageLogs.values()].some((record) => record.direction === "outbound" && record.status === "failed")).toBe(true);
  });
});
