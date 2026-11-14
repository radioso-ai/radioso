import type { ConnectorChatPort, ConnectorLogger, ConnectorReplyBlocks } from "@radioso/connector-api";

import { errorClassOf } from "../../../../shared/observability/errorClass.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import type { WhatsAppClient } from "./whatsappClient.js";
import { WhatsAppClientError } from "./whatsappGraph.js";
import type { WhatsAppPersistencePort } from "./whatsappPersistence.js";
import {
  fallbackTextMessages,
  renderReplyCards,
  type WhatsAppCardsMessageType,
  type WhatsAppCardsRendering,
  type WhatsAppOutboundMessage,
} from "./whatsappReplyCards.js";
import { encodeTapId, replyCardsOf } from "./whatsappReplyTaps.js";

/** The Cloud API's customer-service window, from the customer's last message. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a reply waits for its cards' pictures to be stored before it sends the list instead. */
const DEFAULT_PICTURE_WAIT_MS = 6_000;

/** The key of a sent cards message's log row that names the reply it belongs to. */
const CARDS_OF_KEY = "cards_of";

/** What a block went as, or `text_list` for the numbered list, or `none` when no message carries it. Bounded. */
type BlockMessageType = WhatsAppCardsMessageType | "text_list" | "none";

/**
 * How it went: `sent` (Graph took it), `failed` (Graph refused it, or reported later that it could
 * not deliver it), `retried` (Graph could not take it for now, and the whole reply is retried),
 * `labels_missing` (the reply left out a label the message needs), `pictures_not_ready` (its
 * pictures were not stored in time) or `unsupported` (no WhatsApp message carries the block). Bounded.
 */
type BlockSendOutcome = "sent" | "failed" | "retried" | "labels_missing" | "pictures_not_ready" | "unsupported";

interface GraphConfig {
  phoneNumberId: string;
  accessToken: string;
}

interface WhatsAppReplyDeliveryDependencies {
  client: Pick<WhatsAppClient, "sendTextMessage" | "sendMessage">;
  persistence: Pick<
    WhatsAppPersistencePort,
    "createMessageLog" | "findMessageLogByWamid" | "findContact" | "findLatestOutboundReply" | "claimCardsFallback" | "releaseCardsFallback"
  >;
  /** Whether a reply's pictures are stored, which Meta fetches by address when the cards are sent. */
  pictures: Pick<ConnectorChatPort, "awaitReplyPictures">;
  logger: ConnectorLogger;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  now?: () => Date;
  pictureWaitMs?: number;
}

/** One reply as it is sent: the reply's own outbound row, the customer, and what it says. */
interface ReplyToDeliver {
  config: GraphConfig;
  workspaceId: string;
  waId: string;
  outboundWamid: string;
  text: string;
  cards: ConnectorReplyBlocks | null;
}

const rendered = (reply: { outboundWamid: string; text: string }, cards: ConnectorReplyBlocks): WhatsAppCardsRendering =>
  renderReplyCards({ text: reply.text, block: cards.blocks[0], tapId: (itemIndex) => encodeTapId(reply.outboundWamid, 0, itemIndex) });

/** A failure Graph may not repeat: a rate limit, a server error, or no answer at all. */
const isTransient = (error: unknown): boolean =>
  !(error instanceof WhatsAppClientError) || error.retryable || error.statusCode >= 500;

/** The failure as the reply's retry reads it: one Graph may not repeat is retried. */
const retryable = (error: unknown): Error => {
  if (error instanceof WhatsAppClientError) {
    return error.retryable ? error : new WhatsAppClientError(error.message, error.statusCode, true);
  }
  return error instanceof Error ? error : new Error("WhatsApp send failed");
};

/**
 * Sends a reply on WhatsApp: its text, or its text and its cards (the first block it carries).
 * A reply without cards goes exactly as a text reply always has.
 *
 * The customer always sees the items. Cards no WhatsApp message carries, cards whose button label
 * the reply left out, and cards whose pictures are not stored in time go as the model's text and a
 * numbered list of the items. Cards Graph refuses, or reports later that it could not deliver,
 * fall back the same way, once per reply, the list claimed before it is sent. When Graph cannot
 * take the cards for now and nothing of the reply has reached it, the whole reply is retried
 * instead. Once any message of a reply has reached Graph, a later failure is counted and logged
 * but not thrown, so a retry never sends the customer the same words twice. Every outcome is
 * counted in `whatsapp_block_send_total{message_type, outcome}`.
 */
export class WhatsAppReplyDelivery {
  private readonly now: () => Date;

  constructor(private readonly deps: WhatsAppReplyDeliveryDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The id Graph gave the reply's first message; null when the reply's list had already gone. */
  async deliver(reply: ReplyToDeliver): Promise<{ wamid: string | null }> {
    if (!reply.cards) {
      return this.deps.client.sendTextMessage(reply.config, { to: reply.waId, text: reply.text, outboundWamid: reply.outboundWamid });
    }
    const block = reply.cards.blocks[0];
    const rendering = rendered(reply, reply.cards);
    if (rendering.kind === "text_only") {
      this.count("none", "unsupported");
      return this.sendFallback(reply, fallbackTextMessages(reply.text, block), null);
    }
    if (rendering.kind === "labels_missing") {
      this.count(rendering.messageType, "labels_missing");
      return this.sendFallback(reply, fallbackTextMessages(reply.text, block), null);
    }
    if (rendering.pictured && !(await this.picturesStored(reply, reply.cards.messageId))) {
      this.count(rendering.messageType, "pictures_not_ready");
      return this.sendFallback(reply, fallbackTextMessages(reply.text, block), null);
    }

    let first: { wamid: string } | null = null;
    for (const part of rendering.parts) {
      try {
        const sent = await this.send(reply, part.message);
        first ??= sent;
        if (part.role === "cards") {
          await this.rememberCardsMessage(reply, sent.wamid, rendering.messageType);
        } else if (part.role === "list") {
          this.count("text_list", "sent");
        }
      } catch (error) {
        if (part.role === "text") {
          throw error;
        }
        if (part.role === "list" && first) {
          this.count("text_list", "failed");
          this.warn(reply, error, "WhatsApp numbered list of a gallery's other cards could not be sent");
          return first;
        }
        if (!first && isTransient(error)) {
          this.count(rendering.messageType, "retried");
          throw retryable(error);
        }
        this.count(rendering.messageType, "failed");
        this.warn(reply, error, "WhatsApp cards could not be sent; sending the items as a numbered list", rendering.messageType);
        return this.sendFallback(reply, fallbackTextMessages(rendering.textSentFirst ? null : reply.text, block), first);
      }
    }
    this.count(rendering.messageType, "sent");
    return first ?? { wamid: null };
  }

  /**
   * Graph reported a message as not delivered. When it was a reply's cards (Meta could not fetch a
   * picture, say), the customer gets the reply's fallback, once per reply, while the customer's
   * last message is less than 24 hours old and no newer reply has gone to them. Any other message
   * is not this module's to act on.
   */
  async handleFailedStatus(input: { workspaceId: string; wamid: string; errorCode: number | null; config: GraphConfig }): Promise<void> {
    const sent = await this.deps.persistence.findMessageLogByWamid(input.wamid);
    const replyWamid = sent?.direction === "outbound" && sent.workspaceId === input.workspaceId ? sent.payload[CARDS_OF_KEY] : undefined;
    if (typeof replyWamid !== "string") {
      return;
    }
    const replyLog = await this.deps.persistence.findMessageLogByWamid(replyWamid);
    const cards = replyCardsOf(replyLog);
    const text = replyLog?.payload.text;
    if (!replyLog || !cards || typeof text !== "string") {
      return;
    }
    const rendering = rendered({ outboundWamid: replyWamid, text }, cards);
    const messageType = rendering.kind === "cards" ? rendering.messageType : "none";
    const fields = { workspaceId: input.workspaceId, outboundWamid: replyWamid, providerWamid: input.wamid, errorCode: input.errorCode, messageType };
    const late = await this.lateFor(input.workspaceId, replyLog.waId, replyWamid);
    if (late) {
      this.count(messageType, "failed");
      this.deps.logger.warn({ ...fields, reason: late }, "WhatsApp cards were not delivered; the numbered list is not sent");
      return;
    }
    // Once per reply: a gallery's pictures can each fail, and Meta may send a status twice.
    if (!(await this.deps.persistence.claimCardsFallback(replyWamid))) {
      return;
    }
    this.count(messageType, "failed");
    this.deps.logger.warn(fields, "WhatsApp cards were not delivered; sending the items as a numbered list");
    const textSentFirst = rendering.kind === "cards" && rendering.textSentFirst;
    const reply = { config: input.config, workspaceId: input.workspaceId, waId: replyLog.waId, outboundWamid: replyWamid, text, cards };
    await this.sendClaimedList(reply, fallbackTextMessages(textSentFirst ? null : text, cards.blocks[0]), { wamid: input.wamid }).catch(() => undefined);
  }

  /** Why a late list would no longer be a reply: the service window closed, or a newer reply went. */
  private async lateFor(workspaceId: string, waId: string, replyWamid: string): Promise<"window_closed" | "newer_reply" | null> {
    const contact = await this.deps.persistence.findContact(workspaceId, waId);
    if (!contact || this.now().getTime() - contact.lastMessageAt.getTime() > SERVICE_WINDOW_MS) {
      return "window_closed";
    }
    const latest = await this.deps.persistence.findLatestOutboundReply({ workspaceId, waId });
    return latest && latest.wamid !== replyWamid ? "newer_reply" : null;
  }

  private async picturesStored(reply: ReplyToDeliver, messageId: string): Promise<boolean> {
    try {
      return await this.deps.pictures.awaitReplyPictures({
        workspaceId: reply.workspaceId,
        messageId,
        withinMs: this.deps.pictureWaitMs ?? DEFAULT_PICTURE_WAIT_MS,
      });
    } catch (error) {
      this.warn(reply, error, "WhatsApp cards' pictures could not be checked; sending the items as a numbered list");
      return false;
    }
  }

  /**
   * Claims the reply's numbered list, then sends it (with the text where it has not gone). When
   * the list was already claimed, by an earlier attempt or a failed status, it is not sent again.
   */
  private async sendFallback(reply: ReplyToDeliver, messages: WhatsAppOutboundMessage[], delivered: { wamid: string } | null): Promise<{ wamid: string | null }> {
    if (!(await this.deps.persistence.claimCardsFallback(reply.outboundWamid))) {
      return delivered ?? { wamid: null };
    }
    return this.sendClaimedList(reply, messages, delivered);
  }

  /**
   * Sends a claimed list. Throws only when nothing of the reply has reached Graph, letting go of
   * the claim first, so the caller's retry sends it whole.
   */
  private async sendClaimedList(reply: ReplyToDeliver, messages: WhatsAppOutboundMessage[], delivered: { wamid: string } | null): Promise<{ wamid: string | null }> {
    let first = delivered;
    try {
      for (const message of messages) {
        const sent = await this.send(reply, message);
        first ??= sent;
      }
      this.count("text_list", "sent");
      return first ?? { wamid: null };
    } catch (error) {
      this.count("text_list", "failed");
      if (!first) {
        await this.deps.persistence.releaseCardsFallback(reply.outboundWamid).catch(() => undefined);
        throw error;
      }
      this.warn(reply, error, "WhatsApp numbered list could not be sent after part of the reply went");
      return first;
    }
  }

  private send(reply: ReplyToDeliver, message: WhatsAppOutboundMessage): Promise<{ wamid: string }> {
    return message.type === "text"
      ? this.deps.client.sendTextMessage(reply.config, { to: reply.waId, text: message.text.body, outboundWamid: reply.outboundWamid })
      : this.deps.client.sendMessage(reply.config, { to: reply.waId, message, outboundWamid: reply.outboundWamid });
  }

  /** Keeps a sent cards message's id with its reply, so a later failed status falls back. Losing it costs only that. */
  private async rememberCardsMessage(reply: ReplyToDeliver, providerWamid: string, messageType: WhatsAppCardsMessageType): Promise<void> {
    try {
      await this.deps.persistence.createMessageLog({
        wamid: providerWamid,
        direction: "outbound",
        workspaceId: reply.workspaceId,
        waId: reply.waId,
        messageType,
        payload: { [CARDS_OF_KEY]: reply.outboundWamid },
        status: "replied",
      });
    } catch (error) {
      this.warn(reply, error, "WhatsApp cards message could not be recorded");
    }
  }

  private warn(reply: ReplyToDeliver, error: unknown, message: string, messageType?: WhatsAppCardsMessageType): void {
    this.deps.logger.warn(
      {
        workspaceId: reply.workspaceId,
        outboundWamid: reply.outboundWamid,
        ...(messageType ? { messageType } : {}),
        errorClass: errorClassOf(error),
        ...(error instanceof WhatsAppClientError ? { statusCode: error.statusCode } : {}),
      },
      message,
    );
  }

  private count(messageType: BlockMessageType, outcome: BlockSendOutcome): void {
    this.deps.metrics?.incrementCounter("whatsapp_block_send_total", {
      help: "Reply cards sent on WhatsApp, by the message they went as (or the numbered list they fell back to) and how it went",
      labels: { message_type: messageType, outcome },
    });
  }
}
