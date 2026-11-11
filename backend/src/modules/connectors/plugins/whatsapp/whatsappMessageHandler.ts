import type {
  ConnectorChatPort,
  ConnectorDatabasePort,
  ConnectorInboundImage,
  ConnectorLogger,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { isStructuredAppError } from "../../../../shared/domain/errors.js";
import { errorClassOf } from "../../../../shared/observability/errorClass.js";
import { WhatsAppClient, WhatsAppClientError } from "./whatsappClient.js";
import { CONNECTOR_IMAGES_UNAVAILABLE_CODE, CONNECTOR_IMAGES_UNUSABLE_CODE } from "../../services/connectorImageTurns.js";
import { connectorKyselyDb } from "../../services/connectorKyselyDb.js";
import { PostgresWhatsAppPersistence, type WhatsAppPersistencePort } from "./whatsappPersistence.js";

interface WhatsAppMessageHandlerOptions {
  db: ConnectorDatabasePort;
  logger: ConnectorLogger;
  chat: Pick<ConnectorChatPort, "answer" | "imageAllowance">;
  state: Pick<ConnectorStatePort, "getConfig" | "setErrorStatus">;
  client: Pick<WhatsAppClient, "sendTextMessage" | "downloadImage">;
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
  /** What the sender typed: a text message's body, or an image's caption. */
  textBody?: string;
  /** The photo of an image message, by the media id Graph resolves to its bytes. */
  image?: { mediaId: string };
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

/**
 * Raised inside a turn when its photos are not ones the turn takes: `unusable` when none of them
 * could be used and nothing was typed with them (gone, over the cap, or refused by the host), and
 * `unavailable` when the agent stopped taking photos while the turn ran. Either way the photos are
 * messages the connector does not support, not a failure to retry.
 */
class PhotosNotTakenError extends Error {
  constructor(readonly reason: "unusable" | "unavailable") {
    super("The photos of the turn are not ones it takes");
    this.name = "PhotosNotTakenError";
  }
}

/** What the host's refusal of a turn's photos means for the connector, when it is one the connector acts on. */
const photosNotTakenBy = (error: unknown): PhotosNotTakenError | null => {
  if (!isStructuredAppError(error)) {
    return null;
  }
  if (error.code === CONNECTOR_IMAGES_UNUSABLE_CODE) {
    return new PhotosNotTakenError("unusable");
  }
  return error.code === CONNECTOR_IMAGES_UNAVAILABLE_CODE ? new PhotosNotTakenError("unavailable") : null;
};

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
          { err: error },
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

    // Rapid messages are one batch, so an album's photos and the caption that comes with them are
    // one turn, the same as a few lines of text sent in a row.
    const photoMessages = await this.selectPhotoMessages(messages, configRecord.config);
    const unsupportedMessages: WhatsAppInboundMessage[] = [];
    const errors: unknown[] = [];

    await this.answerTurn(messages, photoMessages, configRecord.config, unsupportedMessages, errors);

    if (unsupportedMessages.length > 0) {
      await this.processUnsupportedMessages(unsupportedMessages, configRecord.config).catch((error) => errors.push(error));
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "WhatsApp batch processing failed");
    }
  }

  /**
   * Answers the batch's text and the photos a turn takes as one turn; whatever it does not take is
   * collected as unsupported, for the caller to handle. Photos the turn could not use, with nothing
   * typed, are unsupported. If the agent stops taking photos while the turn runs, the batch is
   * handled as if it had allowed none from the start: its text is answered alone and its photos
   * are unsupported. No reply is left unsaid.
   */
  private async answerTurn(
    messages: WhatsAppInboundMessage[],
    photoMessages: WhatsAppInboundMessage[],
    config: Record<string, string>,
    unsupportedMessages: WhatsAppInboundMessage[],
    errors: unknown[],
  ): Promise<void> {
    const turnMessages = messages.filter((message) => this.isProcessableTextMessage(message) || photoMessages.includes(message));
    unsupportedMessages.push(...messages.filter((message) => !turnMessages.includes(message)));
    if (turnMessages.length === 0) {
      return;
    }

    try {
      await this.processMessageGroup(turnMessages, async () => {
        await this.answerAndReply(turnMessages, this.buildTextQuery(turnMessages), config);
      });
    } catch (error) {
      if (!(error instanceof PhotosNotTakenError)) {
        errors.push(error);
      } else if (error.reason === "unusable") {
        unsupportedMessages.push(...turnMessages);
      } else {
        await this.answerTurn(turnMessages, [], config, unsupportedMessages, errors);
      }
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
      if (error instanceof PhotosNotTakenError) {
        // Not a failure: the caller handles these messages as ones it does not support.
        throw error;
      }
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

    const { conversationId, latestTimestamp } = await this.continuingConversation(messages, config);
    const images = await this.downloadPhotos(messages, config);
    if (images.length === 0 && query.trim().length === 0) {
      throw new PhotosNotTakenError("unusable");
    }

    let response: Awaited<ReturnType<ConnectorChatPort["answer"]>>;
    try {
      response = await this.options.chat.answer({
        workspaceId: first.workspaceId,
        conversationId,
        query,
        sourceChannel: "whatsapp",
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (error) {
      throw (images.length > 0 ? photosNotTakenBy(error) : null) ?? error;
    }

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

  /** What the sender typed across the turn: text bodies and photo captions, in the order they arrived. */
  private buildTextQuery(messages: WhatsAppInboundMessage[]): string {
    return messages
      .map((message) => message.textBody?.trim() ?? "")
      .filter((value) => value.length > 0)
      .join("\n");
  }

  private isProcessableTextMessage(message: WhatsAppInboundMessage): boolean {
    return message.type === "text" && Boolean(message.textBody?.trim());
  }

  private isPhotoMessage(message: WhatsAppInboundMessage): message is WhatsAppInboundMessage & { image: { mediaId: string } } {
    return message.type === "image" && Boolean(message.image?.mediaId);
  }

  private photosInSentOrder(messages: WhatsAppInboundMessage[]): Array<WhatsAppInboundMessage & { image: { mediaId: string } }> {
    return messages
      .filter((message) => this.isPhotoMessage(message))
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  }

  /**
   * The conversation a turn on these messages continues: the sender's latest, unless it has been
   * quiet longer than the connector's timeout, which starts a new one.
   */
  private async continuingConversation(
    messages: WhatsAppInboundMessage[],
    config: Record<string, string>,
  ): Promise<{ conversationId: string | undefined; latestTimestamp: Date }> {
    const [first] = messages;
    const latestTimestamp = [...messages]
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .at(-1)?.timestamp ?? first.timestamp;

    const contact = await this.persistence.findContact(first.workspaceId, first.waId);
    const timeoutHours = Number(config.conversation_timeout_hours ?? "24");
    const timeoutMs = timeoutHours * 60 * 60 * 1000;
    const canContinueConversation =
      contact &&
      latestTimestamp.getTime() - contact.lastMessageAt.getTime() <= timeoutMs;

    return { conversationId: canContinueConversation ? contact.conversationId : undefined, latestTimestamp };
  }

  /**
   * The photos of this batch a turn takes: the first the host allows, in the order they were sent,
   * when the agent that answers reads photos. Otherwise none, so every photo is an unsupported
   * message, as it is for any agent with photos off. The host's answer decides before a byte is
   * downloaded; one that cannot be had is treated as photos off.
   */
  private async selectPhotoMessages(
    messages: WhatsAppInboundMessage[],
    config: Record<string, string>,
  ): Promise<WhatsAppInboundMessage[]> {
    const photos = this.photosInSentOrder(messages);
    if (photos.length === 0) {
      return [];
    }

    const [first] = messages;
    try {
      const { conversationId } = await this.continuingConversation(messages, config);
      const allowance = await this.options.chat.imageAllowance({ workspaceId: first.workspaceId, conversationId });
      return allowance ? photos.slice(0, allowance.maxImages) : [];
    } catch (error) {
      this.options.logger.warn(
        { workspaceId: first.workspaceId, errorClass: errorClassOf(error) },
        "WhatsApp photo support could not be determined",
      );
      return [];
    }
  }

  /**
   * Downloads the turn's photos, in the order they were sent. One that is gone is left out; a
   * transient failure throws, so the batch is retried whole.
   */
  private async downloadPhotos(
    messages: WhatsAppInboundMessage[],
    config: Record<string, string>,
  ): Promise<ConnectorInboundImage[]> {
    const downloads = await Promise.all(this.photosInSentOrder(messages).map((message) =>
      this.options.client.downloadImage(
        { accessToken: config.access_token },
        { mediaId: message.image.mediaId, wamid: message.wamid },
      )));
    return downloads.flatMap((download) => (download.kind === "downloaded" ? [{ bytes: download.bytes }] : []));
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
          outboundWamid: input.outboundWamid,
        },
      );

      await this.persistence.markOutboundReplyDelivered({
        outboundWamid: input.outboundWamid,
        inboundWamids: input.inboundWamids,
      });
      this.options.logger.info(
        { workspaceId: input.workspaceId, localWamid: input.outboundWamid, providerWamid: outbound.wamid },
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
