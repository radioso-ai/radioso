import { z } from "zod";

import type { MessageRecord } from "../../../../db/repositories/messageRepository.js";
import type { ItemSelection } from "../../../../shared/domain/chatInputMetadata.js";
import { storedReplyBlockSchema, type StoredReplyItemDocument } from "../../contracts/replyBlocks.js";

/**
 * The item a visitor picked, read from the block stored on the message that showed it: the
 * selection fact a turn carries as its subject. A card from the answer's evidence carries its
 * document; one from a skill's result, the skill that returned it.
 */
export interface SelectedItem {
  messageId: string;
  blockId: string;
  key: string;
  title: string;
  description?: string;
  link?: string;
  document?: StoredReplyItemDocument;
  skillName?: string;
}

/** Why a pick names no item that can be picked. Bounded: each is a metric label. */
export type ItemSelectionRejection = "unknown_message" | "unknown_block" | "unknown_item" | "not_selectable";

type ItemSelectionReading = { ok: true; item: SelectedItem } | { ok: false; reason: ItemSelectionRejection };

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
  if (block.selection !== "single") {
    return { ok: false, reason: "not_selectable" };
  }
  const item = block.items.find((candidate) => candidate.key === selection.itemKey);
  if (!item) {
    return { ok: false, reason: "unknown_item" };
  }
  const link = item.actions.find((action) => action.type === "open")?.url;
  return {
    ok: true,
    item: {
      messageId: message.id,
      blockId: block.id,
      key: item.key,
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(link ? { link } : {}),
      ...(item.document ? { document: item.document } : {}),
      ...(block.origin ? { skillName: block.origin.skillName } : {}),
    },
  };
};
