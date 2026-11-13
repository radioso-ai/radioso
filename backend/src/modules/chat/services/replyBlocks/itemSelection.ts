import { z } from "zod";

import type { MessageRecord } from "../../../../db/repositories/messageRepository.js";
import type { ItemSelection } from "../../../../shared/domain/chatInputMetadata.js";
import { storedReplyBlockSchema, type StoredReplyItem, type StoredReplyItemDocument } from "../../contracts/replyBlocks.js";

/**
 * The item a visitor picked, read from the block stored on the message that showed it: the
 * selection fact a turn carries as its subject, with the document it stands for.
 */
export interface SelectedItem {
  messageId: string;
  blockId: string;
  key: string;
  title: string;
  description?: string;
  link?: string;
  document?: StoredReplyItemDocument;
}

/**
 * The words a pick runs on, the same the chat sends: the card's title, else its picture's alt
 * text, else its key. Both sides read it from what the card shows, so they agree.
 */
const pickedItemText = (item: Pick<StoredReplyItem, "key" | "title" | "image">): string =>
  item.title.trim() || item.image?.alt.trim() || item.key;

/** Why a pick names no item that can be picked. Bounded: each is a metric label. */
export type ItemSelectionRejection = "unknown_message" | "unknown_block" | "unknown_item" | "not_selectable";

/** A pick read back: the item, and the words its turn runs on ({@link pickedItemText}). */
type ItemSelectionReading = { ok: true; item: SelectedItem; text: string } | { ok: false; reason: ItemSelectionRejection };

const storedReplyBlocksSchema = z.array(storedReplyBlockSchema).min(1);

/**
 * Reads the picked item from the assistant message in this conversation that showed it. Only the
 * stored block counts: an item the block does not hold, or a block whose items are only shown, is
 * no item, whatever the client says of it.
 */
export const readItemSelection = (
  message: MessageRecord | null,
  conversationId: string,
  selection: ItemSelection,
): ItemSelectionReading => {
  if (!message || message.conversationId !== conversationId || message.role !== "assistant") {
    return { ok: false, reason: "unknown_message" };
  }
  const blocks = storedReplyBlocksSchema.safeParse((message.metadata as { blocks?: unknown } | undefined)?.blocks);
  const block = blocks.success ? blocks.data.find((candidate) => candidate.id === selection.blockId) : undefined;
  if (!block) {
    return { ok: false, reason: "unknown_block" };
  }
  // Only cards from the answer's documents are picked in conversation. A skill's cards (`origin`)
  // are only shown: a pick there would reach retrieval, not the skill.
  if (block.selection !== "single" || block.origin) {
    return { ok: false, reason: "not_selectable" };
  }
  const item = block.items.find((candidate) => candidate.key === selection.itemKey);
  if (!item) {
    return { ok: false, reason: "unknown_item" };
  }
  const link = item.actions.find((action) => action.type === "open")?.url;
  return {
    ok: true,
    text: pickedItemText(item),
    item: {
      messageId: message.id,
      blockId: block.id,
      key: item.key,
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(link ? { link } : {}),
      ...(item.document ? { document: item.document } : {}),
    },
  };
};
