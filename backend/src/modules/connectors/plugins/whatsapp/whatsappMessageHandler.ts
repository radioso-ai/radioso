import type {
  ConnectorChatPort,
  ConnectorDatabasePort,
  ConnectorInboundImage,
  ConnectorItemSelection,
  ConnectorLogger,
  ConnectorReplyBlocks,
  ConnectorReplyBlocksCapability,
  ConnectorStatePort,
  ConnectorStoredImage,
} from "@radioso/connector-api";

import { isStructuredAppError } from "../../../../shared/domain/errors.js";
import { errorClassOf } from "../../../../shared/observability/errorClass.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { WhatsAppClient, WhatsAppClientError } from "./whatsappClient.js";
import {
  CONNECTOR_IMAGES_STALE_CODE,
  CONNECTOR_IMAGES_UNAVAILABLE_CODE,
  CONNECTOR_IMAGES_UNUSABLE_CODE,
} from "../../services/connectorImageTurns.js";
import { CONNECTOR_PICK_REFUSED_CODE } from "../../services/connectorChatPort.js";
import { connectorKyselyDb } from "../../services/connectorKyselyDb.js";
import { PostgresWhatsAppPersistence, photoReceiptOf, type WhatsAppPersistencePort } from "./whatsappPersistence.js";
import { WhatsAppReplyDelivery } from "./whatsappReplyDelivery.js";
import { isCardTap, REPLY_CARDS_KEY, replyCardsOf, WhatsAppReplyTaps, type WhatsAppTap } from "./whatsappReplyTaps.js";

interface WhatsAppMessageHandlerOptions {
  db: ConnectorDatabasePort;
  logger: ConnectorLogger;
  chat: Pick<ConnectorChatPort, "answer" | "imageAllowance" | "awaitReplyPictures">;
  state: Pick<ConnectorStatePort, "getConfig" | "setErrorStatus">;
  client: Pick<WhatsAppClient, "sendTextMessage" | "sendMessage" | "downloadImage">;
  persistence?: WhatsAppPersistencePort;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  debounceMs?: number;
  retryBaseDelayMs?: number;
  maxRetryAttempts?: number;
}

/**
 * What WhatsApp draws of a reply's blocks: item lists in every layout, as carousels, image,
 * reply-button and list messages, with button labels the reply writes, since WhatsApp has no copy
 * of its own. Cards still show only for an agent that has them on.
 */
const WHATSAPP_REPLY_BLOCKS: ConnectorReplyBlocksCapability = {
  item_list: { layouts: ["carousel", "grid", "list"], buttonLabels: true },
};

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
  /** A tap on a button or list row, with the id it carried. */
  tap?: WhatsAppTap;
  /** The card a tap names, read from the reply that showed it; `textBody` is then the card's title. */
  pick?: ConnectorItemSelection;
  payload: Record<string, unknown>;
}

interface PendingBatch {
  timer: NodeJS.Timeout;
  messages: WhatsAppInboundMessage[];
}

interface PreparedWhatsAppReply {
  outboundWamid: string;
  responseText: string;
  /** The reply's cards, as the turn returned them; null for a text reply. */
  cards: ConnectorReplyBlocks | null;
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

/**
 * Raised inside a turn when a tap picks a card the conversation cannot pick: the host refused it,
 * as the web chat refuses one, or there is no conversation to pick in. The tap is then a message
 * the connector does not support: no turn runs, and the card's words never run as typed text.
 */
class PickNotTakenError extends Error {
  constructor() {
    super("The tap picks no card this conversation can pick");
    this.name = "PickNotTakenError";
  }
}

/** What the host's refusal of a turn's photos means for the connector, when it is one the connector acts on. */
const isStaleReceiptsRefusal = (error: unknown): boolean =>
  isStructuredAppError(error) && error.code === CONNECTOR_IMAGES_STALE_CODE;

const photosNotTakenBy = (error: unknown): PhotosNotTakenError | null => {
  if (!isStructuredAppError(error)) {
    return null;
  }
  if (error.code === CONNECTOR_IMAGES_UNUSABLE_CODE) {
    return new PhotosNotTakenError("unusable");
  }
  return error.code === CONNECTOR_IMAGES_UNAVAILABLE_CODE ? new PhotosNotTakenError("unavailable") : null;
};

const sameCard = (left: ConnectorItemSelection, right: ConnectorItemSelection): boolean =>
  left.messageId === right.messageId && left.blockId === right.blockId && left.itemKey === right.itemKey;

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
  private readonly delivery: WhatsAppReplyDelivery;
  private readonly taps: WhatsAppReplyTaps;

  constructor(private readonly options: WhatsAppMessageHandlerOptions) {
    this.persistence = options.persistence ?? new PostgresWhatsAppPersistence(connectorKyselyDb(options.db));
    this.debounceMs = options.debounceMs ?? 3000;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
    this.delivery = new WhatsAppReplyDelivery({
      client: options.client,
      persistence: this.persistence,
      pictures: options.chat,
      logger: options.logger,
      metrics: options.metrics,
    });
    this.taps = new WhatsAppReplyTaps({ persistence: this.persistence, logger: options.logger });
  }

  /** Graph reported a message it could not deliver; a reply's cards fall back to a numbered list. */
  async handleFailedStatus(input: { workspaceId: string; wamid: string; errorCode: number | null }): Promise<void> {
    const configRecord = await this.options.state.getConfig(input.workspaceId);
    if (!configRecord?.enabled) {
      return;
    }
    await this.delivery.handleFailedStatus({
      ...input,
      config: { phoneNumberId: configRecord.config.phone_number_id, accessToken: configRecord.config.access_token },
    });
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

  private async flushBatch(batch: WhatsAppInboundMessage[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    const [first] = batch;
    const configRecord = await this.options.state.getConfig(first.workspaceId);
    if (!configRecord?.enabled) {
      for (const message of batch) {
        await this.persistence.updateMessageLogStatus(message.wamid, "failed", "Connector disabled before batch processing");
      }
      return;
    }

    // A tap on a card reads as the card it names; one that names none is unsupported.
    const messages = await this.withCardTaps(batch);
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
    captionsAsText = false,
  ): Promise<void> {
    const turnMessages = messages.filter((message) =>
      this.isProcessableTextMessage(message)
      || this.isTapMessage(message)
      || photoMessages.includes(message)
      || (captionsAsText && this.isPhotoMessage(message) && this.hasCaption(message)));
    unsupportedMessages.push(...messages.filter((message) => !turnMessages.includes(message)));
    if (turnMessages.length === 0) {
      return;
    }

    try {
      await this.processMessageGroup(turnMessages, async () => {
        await this.answerAndReply(turnMessages, this.buildTextQuery(turnMessages), config, photoMessages);
      });
    } catch (error) {
      if (error instanceof PickNotTakenError) {
        unsupportedMessages.push(...turnMessages);
      } else if (!(error instanceof PhotosNotTakenError)) {
        errors.push(error);
      } else if (error.reason === "unusable") {
        unsupportedMessages.push(...turnMessages);
      } else {
        // The agent stopped taking photos: what was typed with them is still a message, so the
        // text and the captions are answered, and a photo with no caption is unsupported.
        await this.answerTurn(turnMessages, [], config, unsupportedMessages, errors, true);
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
      if (error instanceof PhotosNotTakenError || error instanceof PickNotTakenError) {
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
        inboundWamids: this.inboundWamids(messages),
        prepared,
        config,
      });
    });
  }

  private async answerAndReply(
    messages: WhatsAppInboundMessage[],
    query: string,
    config: Record<string, string>,
    photoMessages: WhatsAppInboundMessage[],
  ): Promise<void> {
    const prepared = await this.prepareReply(messages, query, config, photoMessages);

    await this.sendReply({
      workspaceId: messages[0].workspaceId,
      waId: messages[0].waId,
      inboundWamids: this.inboundWamids(messages),
      prepared,
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
        cards: null,
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
      cards: null,
    };
  }

  private async prepareReply(
    messages: WhatsAppInboundMessage[],
    query: string,
    config: Record<string, string>,
    photoMessages: WhatsAppInboundMessage[],
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
        cards: replyCardsOf(pendingOutbound),
      };
    }

    const { conversationId, latestTimestamp } = await this.continuingConversation(messages, config);
    const selection = this.pickOf(messages);
    if (selection && !conversationId) {
      throw new PickNotTakenError();
    }
    const response = await this.answerOnChat({
      workspaceId: first.workspaceId,
      conversationId,
      query,
      photoMessages,
      config,
      ...(selection ? { selection } : {}),
    });

    await this.persistence.upsertContact({
      workspaceId: first.workspaceId,
      waId: first.waId,
      profileName: first.profileName,
      conversationId: response.conversationId,
      lastMessageAt: latestTimestamp,
    });

    // A reply with cards keeps them on its row: a retry sends the same messages, and a tap on one
    // resolves through the row to the card the host stored.
    const cards = response.replyBlocks ?? null;
    const outboundWamid = this.persistence.nextLocalOutboundWamid();
    await this.persistence.createMessageLog({
      wamid: outboundWamid,
      direction: "outbound",
      workspaceId: first.workspaceId,
      waId: first.waId,
      messageType: cards ? "interactive" : "text",
      payload: {
        text: response.answer,
        inbound_wamids: inboundWamids,
        ...(cards ? { [REPLY_CARDS_KEY]: cards } : {}),
      },
      status: "processing",
    });

    return {
      outboundWamid,
      responseText: response.answer,
      cards,
    };
  }

  /**
   * The batch with each tap on a card this connector sent read as the card it names: the stored
   * card's title as its words and the card as its pick. A tap that names no card the log still
   * holds keeps no words and no pick, so it is a message the connector does not support.
   */
  private async withCardTaps(messages: WhatsAppInboundMessage[]): Promise<WhatsAppInboundMessage[]> {
    return Promise.all(messages.map(async (message) => {
      if (!message.tap || message.pick || !isCardTap(message.tap)) {
        return message;
      }
      const resolved = await this.taps.resolve({ workspaceId: message.workspaceId, waId: message.waId, wamid: message.wamid, tap: message.tap });
      return resolved ? { ...message, textBody: resolved.words, pick: resolved.selection } : message;
    }));
  }

  /**
   * The card a turn picks: the batch is taps on one card and nothing else, however often it was
   * tapped. A tap sent with anything else is its card's words, never a pick.
   */
  private pickOf(messages: WhatsAppInboundMessage[]): ConnectorItemSelection | null {
    const [first] = messages;
    const pick = first?.pick;
    return pick && messages.every((message) => message.pick && sameCard(message.pick, pick)) ? pick : null;
  }

  /**
   * What the sender typed across the turn: text bodies, photo captions and the titles of the cards
   * they tapped (each card once), in the order they were sent, the same order the photos go in.
   * WhatsApp can deliver a batch out of order, and the sender's clock is the one both follow.
   */
  private buildTextQuery(messages: WhatsAppInboundMessage[]): string {
    const ordered = this.inSentOrder(messages);
    return ordered
      .filter((message, index) => !message.pick || !ordered.slice(0, index).some((earlier) => earlier.pick && sameCard(earlier.pick, message.pick!)))
      .map((message) => message.textBody?.trim() ?? "")
      .filter((value) => value.length > 0)
      .join("\n");
  }

  /** Messages in the order they were sent; messages sent in the same second keep the order they arrived in. */
  private inSentOrder<T extends WhatsAppInboundMessage>(messages: T[]): T[] {
    return [...messages].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  }

  private isProcessableTextMessage(message: WhatsAppInboundMessage): boolean {
    return message.type === "text" && Boolean(message.textBody?.trim());
  }

  /**
   * A tap on a card this connector sent, read as that card. A tap that names no card, or one on any
   * other button, stays unsupported.
   */
  private isTapMessage(message: WhatsAppInboundMessage): boolean {
    return Boolean(message.pick);
  }

  private isPhotoMessage(message: WhatsAppInboundMessage): message is WhatsAppInboundMessage & { image: { mediaId: string } } {
    return message.type === "image" && Boolean(message.image?.mediaId);
  }

  private hasCaption(message: WhatsAppInboundMessage): boolean {
    return Boolean(message.textBody?.trim());
  }

  private photosInSentOrder(messages: WhatsAppInboundMessage[]): Array<WhatsAppInboundMessage & { image: { mediaId: string } }> {
    return this.inSentOrder(messages.filter((message) => this.isPhotoMessage(message)));
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
   * Runs the turn on the chat port: the typed text and the photos. Photos an earlier attempt
   * stored are sent by receipt, so a retry downloads, reads and pays for nothing twice; the host
   * says when a receipt is stale (a message already carries the photo, or it was swept) and the
   * photos are then sent again, once. A refusal that means the photos are not ones the turn takes
   * becomes the signal the caller acts on.
   */
  private async answerOnChat(input: {
    workspaceId: string;
    conversationId: string | undefined;
    query: string;
    photoMessages: WhatsAppInboundMessage[];
    config: Record<string, string>;
    selection?: ConnectorItemSelection;
  }): Promise<Awaited<ReturnType<ConnectorChatPort["answer"]>>> {
    let useReceipts = true;
    for (;;) {
      const images = await this.collectPhotos(input.photoMessages, input.config, useReceipts);
      if (images.length === 0 && input.query.trim().length === 0) {
        throw new PhotosNotTakenError("unusable");
      }
      try {
        return await this.options.chat.answer({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          query: input.query,
          sourceChannel: "whatsapp",
          replyBlocks: WHATSAPP_REPLY_BLOCKS,
          ...(input.selection ? { selection: input.selection } : {}),
          ...(images.length > 0 ? { images, onImagesStored: (stored) => this.keepPhotoReceipts(stored) } : {}),
        });
      } catch (error) {
        if (useReceipts && images.some((image) => image.receipt !== undefined) && isStaleReceiptsRefusal(error)) {
          useReceipts = false;
          continue;
        }
        if (input.selection && isStructuredAppError(error) && error.code === CONNECTOR_PICK_REFUSED_CODE) {
          throw new PickNotTakenError();
        }
        throw (images.length > 0 ? photosNotTakenBy(error) : null) ?? error;
      }
    }
  }

  /**
   * The turn's photos in the order they were sent: by receipt where an earlier attempt stored one,
   * otherwise downloaded. A photo that cannot be had is left out, so it counts as an unavailable
   * photo, whether it is gone, over the cap, or its download failed for good.
   */
  private async collectPhotos(
    photoMessages: WhatsAppInboundMessage[],
    config: Record<string, string>,
    useReceipts: boolean,
  ): Promise<ConnectorInboundImage[]> {
    const collected = await Promise.all(this.photosInSentOrder(photoMessages).map(async (message): Promise<ConnectorInboundImage | null> => {
      const receipt = useReceipts ? photoReceiptOf(await this.persistence.findMessageLogByWamid(message.wamid)) : null;
      return receipt ? { key: message.wamid, receipt } : this.downloadPhoto(message, config);
    }));
    return collected.filter((image) => image !== null);
  }

  /**
   * Downloads one photo. A photo that is gone or over the cap is `null`. So is one whose download
   * fails for good: Graph rejects the request (a rejected token also sets the connector's error
   * status, as a rejected reply does), or a transient failure has used up its retries. A transient
   * failure with retries left throws, so the batch is retried whole.
   */
  private async downloadPhoto(
    message: WhatsAppInboundMessage & { image: { mediaId: string } },
    config: Record<string, string>,
  ): Promise<ConnectorInboundImage | null> {
    try {
      const download = await this.options.client.downloadImage(
        { accessToken: config.access_token },
        { mediaId: message.image.mediaId, wamid: message.wamid },
      );
      return download.kind === "downloaded" ? { key: message.wamid, bytes: download.bytes } : null;
    } catch (error) {
      if (!(error instanceof WhatsAppClientError)) {
        throw error;
      }
      if (error.statusCode === 401) {
        await this.options.state.setErrorStatus(message.workspaceId, error.message);
      }
      const attempt = (this.retryAttempts.get(message.wamid) ?? 0) + 1;
      if (error.retryable && attempt < this.maxRetryAttempts) {
        throw error;
      }
      this.options.logger.warn(
        { workspaceId: message.workspaceId, wamid: message.wamid, statusCode: error.statusCode },
        "WhatsApp photo could not be downloaded; answering without it",
      );
      return null;
    }
  }

  /** Keeps the receipt of each photo the host stored with its message. A receipt that cannot be kept only costs a retry its reuse. */
  private async keepPhotoReceipts(stored: readonly ConnectorStoredImage[]): Promise<void> {
    for (const { key, receipt } of stored) {
      try {
        await this.persistence.savePhotoReceipt(key, receipt);
      } catch (error) {
        this.options.logger.warn({ wamid: key, errorClass: errorClassOf(error) }, "WhatsApp photo receipt could not be kept");
      }
    }
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
    inboundWamids: string[];
    prepared: PreparedWhatsAppReply;
    config: Record<string, string>;
  }): Promise<void> {
    const { outboundWamid } = input.prepared;
    try {
      const outbound = await this.delivery.deliver({
        config: { phoneNumberId: input.config.phone_number_id, accessToken: input.config.access_token },
        workspaceId: input.workspaceId,
        waId: input.waId,
        outboundWamid,
        text: input.prepared.responseText,
        cards: input.prepared.cards,
      });

      await this.persistence.markOutboundReplyDelivered({
        outboundWamid,
        inboundWamids: input.inboundWamids,
      });
      this.options.logger.info(
        { workspaceId: input.workspaceId, localWamid: outboundWamid, providerWamid: outbound.wamid },
        "WhatsApp outbound delivery completed",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      if (error instanceof WhatsAppClientError && error.statusCode === 401) {
        await this.options.state.setErrorStatus(input.workspaceId, detail);
      }
      await this.persistence.updateMessageLogStatus(
        outboundWamid,
        this.isRetryableError(error) ? "retryable_failed" : "failed",
        detail,
      );
      throw error;
    }
  }
}
