import type {
  WhatsAppContactRecord,
  WhatsAppMessageLogRecord,
  WhatsAppPersistencePort,
} from "../../../../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";

/** The WhatsApp contacts and message log in memory, kept the way the Postgres persistence keeps them. */
export class InMemoryWhatsAppPersistence implements WhatsAppPersistencePort {
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

  async claimCardsFallback(outboundWamid: string): Promise<boolean> {
    const existing = this.messageLogs.get(outboundWamid);
    const state = (existing?.payload.radioso ?? {}) as Record<string, unknown>;
    if (existing?.direction !== "outbound" || state.cardsFallback === true) {
      return false;
    }
    existing.payload = { ...existing.payload, radioso: { ...state, cardsFallback: true } };
    return true;
  }

  nextLocalOutboundWamid(): string {
    return `local-${this.messageLogs.size + 1}`;
  }
}
