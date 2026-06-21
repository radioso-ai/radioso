import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorChatPort, ConnectorStatePort } from "@radioso/connector-api";
import { WhatsAppClientError } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import type { WhatsAppClient } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { WhatsAppMessageHandler, type WhatsAppInboundMessage } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.js";
import type {
  WhatsAppContactRecord,
  WhatsAppMessageLogRecord,
  WhatsAppPersistencePort,
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
    chat?: ConnectorChatPort;
    client?: Pick<WhatsAppClient, "sendTextMessage">;
    enabled?: boolean;
    setErrorStatus?: ConnectorStatePort["setErrorStatus"];
    retryBaseDelayMs?: number;
    maxRetryAttempts?: number;
    unsupportedMessageReply?: string;
  }) => {
    const persistence = input?.persistence ?? new InMemoryWhatsAppPersistence();
    const chat = input?.chat ?? {
      answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-1", answer: "Combined answer", outcome: "answered" })),
    };
    const client = input?.client ?? {
      sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>(async () => ({ wamid: "wamid-out-1" })),
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
      { to: "14155551234", text: "Combined answer" },
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
