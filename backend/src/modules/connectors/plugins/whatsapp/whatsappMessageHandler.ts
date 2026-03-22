import type {
  ConnectorChatPort,
  ConnectorDatabasePort,
  ConnectorLogger,
  ConnectorStatePort,
} from "@radioso/connector-api";
import type { WhatsAppPersistencePort } from "./whatsappPersistence.js";
import { PostgresWhatsAppPersistence } from "./whatsappPersistence.js";
import { WhatsAppClient, WhatsAppClientError } from "./whatsappClient.js";

interface WhatsAppMessageHandlerOptions {
  db: ConnectorDatabasePort;
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  state: Pick<ConnectorStatePort, "getConfig" | "setErrorStatus">;
  client: Pick<WhatsAppClient, "sendTextMessage">;
  persistence?: WhatsAppPersistencePort;
  debounceMs?: number;
}

export interface WhatsAppInboundMessage {
  workspaceId: string;
  waId: string;
  profileName: string | null;
  wamid: string;
  phoneNumberId: string | null;
  timestamp: Date;
  type: string;
  textBody?: string;
  payload: Record<string, unknown>;
}

interface PendingBatch {
  timer: NodeJS.Timeout;
  messages: WhatsAppInboundMessage[];
}

const UNSUPPORTED_MESSAGE_REPLY = "Sorry, I can only process text messages at this time.";

export class WhatsAppMessageHandler {
  private readonly persistence: WhatsAppPersistencePort;
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingBatch>();

  constructor(private readonly options: WhatsAppMessageHandlerOptions) {
    this.persistence = options.persistence ?? new PostgresWhatsAppPersistence(options.db);
    this.debounceMs = options.debounceMs ?? 3000;
  }

  async handleInboundMessage(message: WhatsAppInboundMessage): Promise<void> {
    const key = `${message.workspaceId}:${message.waId}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = this.createTimer(key);
      return;
    }

    this.pending.set(key, {
      messages: [message],
      timer: this.createTimer(key),
    });
  }

  async shutdown(): Promise<void> {
    for (const batch of this.pending.values()) {
      clearTimeout(batch.timer);
    }
    this.pending.clear();
  }

  private createTimer(key: string): NodeJS.Timeout {
    return setTimeout(() => {
      const batch = this.pending.get(key);
      if (!batch) {
        return;
      }
      this.pending.delete(key);
      void this.flushBatch(batch.messages).catch((error) => {
        this.options.logger.error({ err: error instanceof Error ? error.message : String(error) }, "WhatsApp batch processing failed");
      });
    }, this.debounceMs);
  }

  private async flushBatch(messages: WhatsAppInboundMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const [first] = messages;
    for (const message of messages) {
      await this.persistence.updateMessageLogStatus(message.wamid, "processing");
    }

    const configRecord = await this.options.state.getConfig(first.workspaceId);
    if (!configRecord?.enabled) {
      for (const message of messages) {
        await this.persistence.updateMessageLogStatus(message.wamid, "failed", "Connector disabled before batch processing");
      }
      return;
    }

    const latestTimestamp = [...messages]
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .at(-1)?.timestamp ?? first.timestamp;

    if (messages.some((message) => message.type !== "text")) {
      await this.sendReply({
        workspaceId: first.workspaceId,
        waId: first.waId,
        messageType: "text",
        responseText: UNSUPPORTED_MESSAGE_REPLY,
        config: configRecord.config,
      });
      for (const message of messages) {
        await this.persistence.updateMessageLogStatus(message.wamid, "replied");
      }
      return;
    }

    const contact = await this.persistence.findContact(first.workspaceId, first.waId);
    const timeoutHours = Number(configRecord.config.conversation_timeout_hours ?? "24");
    const timeoutMs = timeoutHours * 60 * 60 * 1000;
    const canContinueConversation =
      contact &&
      latestTimestamp.getTime() - contact.lastMessageAt.getTime() <= timeoutMs;

    const combinedText = messages
      .map((message) => message.textBody?.trim() ?? "")
      .filter((value) => value.length > 0)
      .join("\n");

    try {
      const response = await this.options.chat.answer({
        workspaceId: first.workspaceId,
        conversationId: canContinueConversation ? contact.conversationId : undefined,
        query: combinedText,
        sourceChannel: "whatsapp",
      });

      await this.persistence.upsertContact({
        workspaceId: first.workspaceId,
        waId: first.waId,
        profileName: first.profileName,
        conversationId: response.conversationId,
        lastMessageAt: latestTimestamp,
      });

      await this.sendReply({
        workspaceId: first.workspaceId,
        waId: first.waId,
        messageType: "text",
        responseText: response.answer,
        config: configRecord.config,
      });

      for (const message of messages) {
        await this.persistence.updateMessageLogStatus(message.wamid, "replied");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      for (const message of messages) {
        await this.persistence.updateMessageLogStatus(message.wamid, "failed", detail);
      }
      throw error;
    }
  }

  private async sendReply(input: {
    workspaceId: string;
    waId: string;
    messageType: string;
    responseText: string;
    config: Record<string, string>;
  }): Promise<void> {
    try {
      const outbound = await this.options.client.sendTextMessage(
        {
          phoneNumberId: input.config.phone_number_id,
          accessToken: input.config.access_token,
        },
        {
          to: input.waId,
          text: input.responseText,
        },
      );

      await this.persistence.createMessageLog({
        wamid: outbound.wamid,
        direction: "outbound",
        workspaceId: input.workspaceId,
        waId: input.waId,
        messageType: input.messageType,
        payload: { text: input.responseText },
        status: "replied",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      if (error instanceof WhatsAppClientError && error.statusCode === 401) {
        await this.options.state.setErrorStatus(input.workspaceId, detail);
      }
      await this.persistence.createMessageLog({
        wamid: this.persistence.nextLocalOutboundWamid(),
        direction: "outbound",
        workspaceId: input.workspaceId,
        waId: input.waId,
        messageType: input.messageType,
        payload: { text: input.responseText },
        status: "failed",
        errorDetails: detail,
      });
      throw error;
    }
  }
}
