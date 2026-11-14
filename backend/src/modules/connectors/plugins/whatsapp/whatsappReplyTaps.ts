import type { ConnectorItemSelection, ConnectorLogger, ConnectorReplyBlocks } from "@radioso/connector-api";
import type { ReplyBlock } from "@radioso/conversation-contract";

import type { WhatsAppMessageLogRecord, WhatsAppPersistencePort } from "./whatsappPersistence.js";

/**
 * Taps on a reply's cards. A button or list row carries a short token, not the ids of the card:
 * the reply's own outbound log row, and the card's place in it. The row keeps the blocks the reply
 * sent (`reply_cards`), so a tap resolves to the message, block and item the host stored, and the
 * host checks the pick again against its own copy. A token stays well inside Meta's limits on a
 * button id (256 characters) and a list row id (200).
 */

/** The key of a cards reply's outbound row payload that keeps the blocks it sent, with the message that stored them. */
export const REPLY_CARDS_KEY = "reply_cards";

const TAP_ID_PREFIX = "rb";
const TAP_ID_SHAPE = /^rb:([A-Za-z0-9_.-]{1,100}):(\d{1,2}):(\d{1,2})$/;

/** The id a card's button or row carries: the reply's outbound row, the block's place, the item's place. */
export const encodeTapId = (outboundWamid: string, blockIndex: number, itemIndex: number): string =>
  `${TAP_ID_PREFIX}:${outboundWamid}:${blockIndex}:${itemIndex}`;

const decodeTapId = (id: string): { outboundWamid: string; blockIndex: number; itemIndex: number } | null => {
  const match = TAP_ID_SHAPE.exec(id);
  return match ? { outboundWamid: match[1], blockIndex: Number(match[2]), itemIndex: Number(match[3]) } : null;
};

/** A tap on a button or list row, as the webhook delivers it: the id the button carried and the words on it. */
export interface WhatsAppTap {
  id: string;
  title: string;
}

/**
 * Whether a tap was on a card this connector sent: its id has the card token's shape. A tap on any
 * other button, such as a template's, stays a message the connector does not support.
 */
export const isCardTap = (tap: WhatsAppTap | undefined): boolean => Boolean(tap && decodeTapId(tap.id));

const tapOf = (value: unknown, idKey: string, titleKey: string): WhatsAppTap | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = record[idKey];
  const title = record[titleKey];
  return typeof id === "string" && id.length > 0 ? { id, title: typeof title === "string" ? title : "" } : undefined;
};

/**
 * The tap an inbound message is, or undefined. Reads `interactive.button_reply` and
 * `interactive.list_reply`, and, since Meta does not document what a carousel's quick-reply tap
 * delivers, any other `interactive` reply object with an `id`, and a `button` message's `payload`.
 */
export const readTap = (message: Record<string, unknown>): WhatsAppTap | undefined => {
  if (message.type === "button") {
    return tapOf(message.button, "payload", "text");
  }
  if (message.type !== "interactive" || !message.interactive || typeof message.interactive !== "object") {
    return undefined;
  }
  const interactive = message.interactive as Record<string, unknown>;
  const kind = typeof interactive.type === "string" ? interactive.type : "";
  return tapOf(interactive[kind], "id", "title")
    ?? tapOf(interactive.button_reply, "id", "title")
    ?? tapOf(interactive.list_reply, "id", "title");
};

/** The blocks a cards reply's outbound row kept, or null for any other row. */
export const replyCardsOf = (log: WhatsAppMessageLogRecord | null): ConnectorReplyBlocks | null => {
  const stored = log?.payload[REPLY_CARDS_KEY];
  if (!stored || typeof stored !== "object") {
    return null;
  }
  const { messageId, blocks } = stored as { messageId?: unknown; blocks?: unknown };
  return typeof messageId === "string" && Array.isArray(blocks) && blocks.length > 0
    ? { messageId, blocks: blocks as ReplyBlock[] }
    : null;
};

/** Why a tap names no card: bounded, a log field. */
type UnresolvedTap = "not_a_card" | "unknown_reply" | "other_sender" | "unknown_item";

/** A tap resolved to the card it names: the ids the host checks, and the card's words. */
interface ResolvedTap {
  selection: ConnectorItemSelection;
  words: string;
}

/**
 * Resolves taps against the outbound log. A tap is resolved only on a reply this connector sent
 * the same customer of the same workspace; anything else is answered as the words on the button,
 * and logged with ids only.
 */
export class WhatsAppReplyTaps {
  constructor(private readonly deps: { persistence: Pick<WhatsAppPersistencePort, "findMessageLogByWamid">; logger: ConnectorLogger }) {}

  async resolve(input: { workspaceId: string; waId: string; wamid: string; tap: WhatsAppTap }): Promise<ResolvedTap | null> {
    const decoded = decodeTapId(input.tap.id);
    if (!decoded) {
      return this.unresolved(input, "not_a_card");
    }
    const reply = await this.deps.persistence.findMessageLogByWamid(decoded.outboundWamid);
    const cards = reply?.direction === "outbound" ? replyCardsOf(reply) : null;
    if (!reply || !cards) {
      return this.unresolved(input, "unknown_reply");
    }
    if (reply.workspaceId !== input.workspaceId || reply.waId !== input.waId) {
      return this.unresolved(input, "other_sender");
    }
    const block = cards.blocks[decoded.blockIndex];
    const item = block?.items[decoded.itemIndex];
    if (!block || !item) {
      return this.unresolved(input, "unknown_item");
    }
    return {
      selection: { messageId: cards.messageId, blockId: block.id, itemKey: item.key },
      words: item.title.trim() || item.image?.alt.trim() || item.key,
    };
  }

  private unresolved(input: { workspaceId: string; wamid: string }, reason: UnresolvedTap): null {
    this.deps.logger.info({ workspaceId: input.workspaceId, wamid: input.wamid, reason }, "WhatsApp card tap answered as text: it names no card");
    return null;
  }
}
