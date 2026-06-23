import type {
  ConnectorChatPort,
  ConnectorDatabasePort,
  ConnectorLogger,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { WhatsAppClient, WhatsAppClientError } from "./whatsappClient.js";
import { connectorKyselyDb } from "../../services/connectorKyselyDb.js";
import { PostgresWhatsAppPersistence, type WhatsAppPersistencePort } from "./whatsappPersistence.js";

interface WhatsAppMessageHandlerOptions {
  db: ConnectorDatabasePort;
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  state: Pick<ConnectorStatePort, "getConfig" | "setErrorStatus">;
  client: Pick<WhatsAppClient, "sendTextMessage">;
  persistence?: WhatsAppPersistencePort;
  debounceMs?: number;
  retryBaseDelayMs?: number;
  maxRetryAttempts?: number;
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

interface PreparedWhatsAppReply {
  outboundWamid: string;
  responseText: string;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

export class WhatsAppMessageHandler {
  private readonly persistence: WhatsAppPersistencePort;
  private readonly debounceMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryAttempts: number;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: WhatsAppMessageHandlerOptions) {
    this.persistence = options.persistence ?? new PostgresWhatsAppPersistence(connectorKyselyDb(options.db));
    this.debounceMs = options.debounceMs ?? 3000;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
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
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.retryTimers.clear();
  }

  private createTimer(key: string): NodeJS.Timeout {
    return setTimeout(() => {
      const batch = this.pending.get(key);
      if (!batch) {
        return;
      }
      this.pending.delete(key);
      void this.flushBatch(batch.messages).catch((error) => {
        this.options.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "WhatsApp batch processing failed",
        );
      });
    }, this.debounceMs);
  }

  private async flushBatch(messages: WhatsAppInboundMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const [first] = messages;
    const configRecord = await this.options.state.getConfig(first.workspaceId);
    if (!configRecord?.enabled) {
      for (const message of messages) {
        await this.persistence.updateMessageLogStatus(message.wamid, "failed", "Connector disabled before batch processing");
      }
      return;
    }

    const textMessages = messages.filter((message) => this.isProcessableTextMessage(message));
    const unsupportedMessages = messages.filter((message) => !this.isProcessableTextMessage(message));
    const errors: unknown[] = [];

    if (textMessages.length > 0) {
      await this.processMessageGroup(textMessages, async () => {
        await this.answerAndReply(textMessages, this.buildTextQuery(textMessages), configRecord.config);
      }).catch((error) => errors.push(error));
    }

    if (unsupportedMessages.length > 0) {
      await this.processUnsupportedMessages(unsupportedMessages, configRecord.config).catch((error) => errors.push(error));
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "WhatsApp batch processing failed");
    }
  }

  private async processMessageGroup(
    messages: WhatsAppInboundMessage[],
    process: () => Promise<void>,
  ): Promise<void> {
    if (await this.markRepliedFromDeliveredOutbound(messages)) {
      return;
    }

    for (const message of messages) {
      await this.persistence.updateMessageLogStatus(message.wamid, "processing");
    }

    try {
      await process();
      for (const message of messages) {
        this.retryAttempts.delete(message.wamid);
        await this.persistence.updateMessageLogStatus(message.wamid, "replied");
      }
    } catch (error) {
      await this.handleProcessingFailure(messages, error);
      throw error;
    }
  }

  private async processUnsupportedMessages(
    messages: WhatsAppInboundMessage[],
    config: Record<string, string>,
  ): Promise<void> {
    const configuredReply = config.unsupported_message_reply?.trim();
    if (!configuredReply) {
      for (const message of messages) {
        this.retryAttempts.delete(message.wamid);
        await this.persistence.updateMessageLogStatus(message.wamid, "skipped", "Unsupported WhatsApp message type");
      }
      return;
    }

    await this.processMessageGroup(messages, async () => {
      const prepared = await this.prepareConfiguredReply(messages, configuredReply);
      await this.sendReply({
        workspaceId: messages[0].workspaceId,
        waId: messages[0].waId,
        outboundWamid: prepared.outboundWamid,
        inboundWamids: this.inboundWamids(messages),
        responseText: prepared.responseText,
        config,
      });
    });
  }

  private async answerAndReply(
    messages: WhatsAppInboundMessage[],
    query: string,
    config: Record<string, string>,
  ): Promise<void> {
    const prepared = await this.prepareReply(messages, query, config);

    await this.sendReply({
      workspaceId: messages[0].workspaceId,
      waId: messages[0].waId,
      outboundWamid: prepared.outboundWamid,
      inboundWamids: this.inboundWamids(messages),
      responseText: prepared.responseText,
      config,
    });
  }

  private async prepareConfiguredReply(
    messages: WhatsAppInboundMessage[],
    responseText: string,
  ): Promise<PreparedWhatsAppReply> {
    const [first] = messages;
    const inboundWamids = this.inboundWamids(messages);
    const pendingOutbound = await this.persistence.findPendingOutboundReply({
      workspaceId: first.workspaceId,
      waId: first.waId,
      inboundWamids,
    });
    const pendingText = typeof pendingOutbound?.payload.text === "string" ? pendingOutbound.payload.text : null;
    if (pendingOutbound && pendingText) {
      return {
        outboundWamid: pendingOutbound.wamid,
        responseText: pendingText,
      };
    }

    const outboundWamid = this.persistence.nextLocalOutboundWamid();
    await this.persistence.createMessageLog({
      wamid: outboundWamid,
      direction: "outbound",
      workspaceId: first.workspaceId,
      waId: first.waId,
      messageType: "text",
      payload: {
        text: responseText,
        inbound_wamids: inboundWamids,
      },
      status: "processing",
    });

    return {
      outboundWamid,
      responseText,
    };
  }

  private async prepareReply(
    messages: WhatsAppInboundMessage[],
    query: string,
    config: Record<string, string>,
  ): Promise<PreparedWhatsAppReply> {
    const [first] = messages;
    const inboundWamids = this.inboundWamids(messages);
    const pendingOutbound = await this.persistence.findPendingOutboundReply({
      workspaceId: first.workspaceId,
      waId: first.waId,
      inboundWamids,
    });
    const pendingText = typeof pendingOutbound?.payload.text === "string" ? pendingOutbound.payload.text : null;
    if (pendingOutbound && pendingText) {
      return {
        outboundWamid: pendingOutbound.wamid,
        responseText: pendingText,
      };
    }

    const latestTimestamp = [...messages]
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .at(-1)?.timestamp ?? first.timestamp;

    const contact = await this.persistence.findContact(first.workspaceId, first.waId);
    const timeoutHours = Number(config.conversation_timeout_hours ?? "24");
    const timeoutMs = timeoutHours * 60 * 60 * 1000;
    const canContinueConversation =
      contact &&
      latestTimestamp.getTime() - contact.lastMessageAt.getTime() <= timeoutMs;

    const response = await this.options.chat.answer({
      workspaceId: first.workspaceId,
      conversationId: canContinueConversation ? contact.conversationId : undefined,
      query,
      sourceChannel: "whatsapp",
    });

    await this.persistence.upsertContact({
      workspaceId: first.workspaceId,
      waId: first.waId,
      profileName: first.profileName,
      conversationId: response.conversationId,
      lastMessageAt: latestTimestamp,
    });

    const outboundWamid = this.persistence.nextLocalOutboundWamid();
    await this.persistence.createMessageLog({
      wamid: outboundWamid,
      direction: "outbound",
      workspaceId: first.workspaceId,
      waId: first.waId,
      messageType: "text",
      payload: {
        text: response.answer,
        inbound_wamids: inboundWamids,
      },
      status: "processing",
    });

    return {
      outboundWamid,
      responseText: response.answer,
    };
  }

  private buildTextQuery(messages: WhatsAppInboundMessage[]): string {
    return messages
      .map((message) => message.textBody?.trim() ?? "")
      .filter((value) => value.length > 0)
      .join("\n");
  }

  private isProcessableTextMessage(message: WhatsAppInboundMessage): boolean {
    return message.type === "text" && Boolean(message.textBody?.trim());
  }

  private inboundWamids(messages: WhatsAppInboundMessage[]): string[] {
    return messages.map((message) => message.wamid).sort();
  }

  private async markRepliedFromDeliveredOutbound(messages: WhatsAppInboundMessage[]): Promise<boolean> {
    const [first] = messages;
    const inboundWamids = this.inboundWamids(messages);
    const deliveredOutbound = await this.persistence.findDeliveredOutboundReply({
      workspaceId: first.workspaceId,
      waId: first.waId,
      inboundWamids,
    });
    if (!deliveredOutbound) {
      return false;
    }

    for (const message of messages) {
      this.retryAttempts.delete(message.wamid);
      await this.persistence.updateMessageLogStatus(message.wamid, "replied");
    }
    return true;
  }

  private async handleProcessingFailure(messages: WhatsAppInboundMessage[], error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : "Unknown error";
    const retryable = this.isRetryableError(error);
    const retryableMessages: WhatsAppInboundMessage[] = [];

    for (const message of messages) {
      if (!retryable) {
        this.retryAttempts.delete(message.wamid);
        await this.persistence.updateMessageLogStatus(message.wamid, "failed", detail);
        continue;
      }

      const attempt = (this.retryAttempts.get(message.wamid) ?? 0) + 1;
      this.retryAttempts.set(message.wamid, attempt);
      if (attempt >= this.maxRetryAttempts) {
        this.retryAttempts.delete(message.wamid);
        await this.persistence.updateMessageLogStatus(message.wamid, "failed", detail);
        continue;
      }

      await this.persistence.updateMessageLogStatus(message.wamid, "retryable_failed", detail);
      retryableMessages.push(message);
    }

    if (retryableMessages.length > 0) {
      this.scheduleRetry(retryableMessages);
    }
  }

  private isRetryableError(error: unknown): boolean {
    return !(error instanceof WhatsAppClientError) || error.retryable;
  }

  private scheduleRetry(messages: WhatsAppInboundMessage[]): void {
    const highestAttempt = Math.max(...messages.map((message) => this.retryAttempts.get(message.wamid) ?? 1));
    const delayMs = this.retryBaseDelayMs * 2 ** Math.max(0, highestAttempt - 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      for (const message of messages) {
        void this.handleInboundMessage(message);
      }
    }, delayMs);
    this.retryTimers.add(timer);
  }

  private async sendReply(input: {
    workspaceId: string;
    waId: string;
    outboundWamid: string;
    inboundWamids: string[];
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

      await this.persistence.markOutboundReplyDelivered({
        outboundWamid: input.outboundWamid,
        inboundWamids: input.inboundWamids,
      });
      this.options.logger.info(
        { workspaceId: input.workspaceId, waId: input.waId, localWamid: input.outboundWamid, providerWamid: outbound.wamid },
        "WhatsApp outbound delivery completed",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      if (error instanceof WhatsAppClientError && error.statusCode === 401) {
        await this.options.state.setErrorStatus(input.workspaceId, detail);
      }
      await this.persistence.updateMessageLogStatus(
        input.outboundWamid,
        this.isRetryableError(error) ? "retryable_failed" : "failed",
        detail,
      );
      throw error;
    }
  }
}
