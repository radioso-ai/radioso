import type { ConnectorLogger, ConnectorReplyBlocks } from "@radioso/connector-api";

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

/** The Cloud API's customer-service window: a reply's fallback goes out only inside it. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The key of a sent cards message's log row that names the reply it belongs to. */
const CARDS_OF_KEY = "cards_of";

/** What a block went as, or `text_list` for the numbered list, or `none` when no message carries it. Bounded. */
type BlockMessageType = WhatsAppCardsMessageType | "text_list" | "none";

/**
 * How it went: `sent` (Graph took it), `failed` (Graph refused it, or reported later that it could
 * not deliver it), `labels_missing` (the reply left out a label the message needs) or `unsupported`
 * (no WhatsApp message carries the block). Bounded.
 */
type BlockSendOutcome = "sent" | "failed" | "labels_missing" | "unsupported";

interface GraphConfig {
  phoneNumberId: string;
  accessToken: string;
}

interface WhatsAppReplyDeliveryDependencies {
  client: Pick<WhatsAppClient, "sendTextMessage" | "sendMessage">;
  persistence: Pick<WhatsAppPersistencePort, "createMessageLog" | "findMessageLogByWamid" | "claimCardsFallback">;
  logger: ConnectorLogger;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  now?: () => Date;
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

/**
 * Sends a reply on WhatsApp: its text, or its text and its cards (the first block it carries).
 * A reply without cards goes exactly as a text reply always has.
 *
 * Cards that cannot go (Graph refuses them, or reports later that it could not fetch a picture)
 * fall back to the model's text, unless it already went, and a numbered list of the items, once
 * per reply. Once any message of a reply has reached Graph, a later failure is counted and logged
 * but not thrown, so a retry never sends the customer the same words twice; a failure before that
 * throws, and the caller retries the reply. Every outcome is counted in
 * `whatsapp_block_send_total{message_type, outcome}`.
 */
export class WhatsAppReplyDelivery {
  private readonly now: () => Date;

  constructor(private readonly deps: WhatsAppReplyDeliveryDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async deliver(reply: ReplyToDeliver): Promise<{ wamid: string }> {
    if (!reply.cards) {
      return this.deps.client.sendTextMessage(reply.config, { to: reply.waId, text: reply.text, outboundWamid: reply.outboundWamid });
    }
    const block = reply.cards.blocks[0];
    const rendering = rendered(reply, reply.cards);
    if (rendering.kind === "text_only") {
      this.count("none", "unsupported");
      return this.deps.client.sendTextMessage(reply.config, { to: reply.waId, text: reply.text, outboundWamid: reply.outboundWamid });
    }
    if (rendering.kind === "labels_missing") {
      this.count(rendering.messageType, "labels_missing");
      return this.sendFallback(reply, fallbackTextMessages(reply.text, block), null);
    }

    let first: { wamid: string } | null = null;
    for (const part of rendering.parts) {
      try {
        const sent = await this.send(reply, part.message);
        first ??= sent;
        if (part.role === "cards") {
          await this.rememberCardsMessage(reply, sent.wamid, rendering.messageType);
        }
      } catch (error) {
        if (part.role === "text") {
          throw error;
        }
        this.count(rendering.messageType, "failed");
        this.deps.logger.warn(
          { workspaceId: reply.workspaceId, outboundWamid: reply.outboundWamid, messageType: rendering.messageType, ...this.errorFields(error) },
          "WhatsApp cards could not be sent; sending the items as a numbered list",
        );
        const fallback = fallbackTextMessages(rendering.textSentFirst ? null : reply.text, block);
        return this.sendFallback(reply, fallback, first);
      }
    }
    this.count(rendering.messageType, "sent");
    return first!;
  }

  /**
   * Graph reported a message as not delivered. When it was a reply's cards (Meta could not fetch a
   * picture, say) and the reply is still inside the service window, the customer gets the reply's
   * fallback, once per reply. Any other message is not this module's to act on.
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
    if (this.now().getTime() - replyLog.createdAt.getTime() > SERVICE_WINDOW_MS) {
      this.count(messageType, "failed");
      this.deps.logger.warn(fields, "WhatsApp cards were not delivered, outside the service window; nothing more is sent");
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
    await this.sendFallback(reply, fallbackTextMessages(textSentFirst ? null : text, cards.blocks[0]), { wamid: input.wamid }).catch(() => undefined);
  }

  /**
   * Sends the numbered list (with the text where it has not gone), marking the reply as fallen
   * back. Throws only when nothing of the reply has reached Graph, so the caller retries it whole.
   */
  private async sendFallback(reply: ReplyToDeliver, messages: WhatsAppOutboundMessage[], delivered: { wamid: string } | null): Promise<{ wamid: string }> {
    let first = delivered;
    try {
      for (const message of messages) {
        const sent = await this.send(reply, message);
        first ??= sent;
      }
      this.count("text_list", "sent");
    } catch (error) {
      this.count("text_list", "failed");
      if (!first) {
        throw error;
      }
      this.deps.logger.warn(
        { workspaceId: reply.workspaceId, outboundWamid: reply.outboundWamid, ...this.errorFields(error) },
        "WhatsApp numbered list could not be sent after part of the reply went",
      );
      return first;
    }
    await this.deps.persistence.claimCardsFallback(reply.outboundWamid).catch(() => false);
    return first!;
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
      this.deps.logger.warn({ workspaceId: reply.workspaceId, outboundWamid: reply.outboundWamid, errorClass: errorClassOf(error) }, "WhatsApp cards message could not be recorded");
    }
  }

  private errorFields(error: unknown): Record<string, unknown> {
    return { errorClass: errorClassOf(error), ...(error instanceof WhatsAppClientError ? { statusCode: error.statusCode } : {}) };
  }

  private count(messageType: BlockMessageType, outcome: BlockSendOutcome): void {
    this.deps.metrics?.incrementCounter("whatsapp_block_send_total", {
      help: "Reply cards sent on WhatsApp, by the message they went as (or the numbered list they fell back to) and how it went",
      labels: { message_type: messageType, outcome },
    });
  }
}
