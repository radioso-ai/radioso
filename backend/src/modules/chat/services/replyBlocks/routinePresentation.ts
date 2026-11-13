import type { RoutineItemValue, RoutineShownItems } from "@radioso/conversation-contract";
import { z } from "zod";

import type { MessageRecord } from "../../../../db/repositories/messageRepository.js";
import { storedReplyBlockSchema, type StoredReplyBlock, type StoredReplyItem } from "../../contracts/replyBlocks.js";

const storedBlocksSchema = z.array(storedReplyBlockSchema);

/** A stored card as an item slot holds it: its key, title, link, and the record's own scalars. */
const routineItemOf = (item: StoredReplyItem): RoutineItemValue => {
  const link = item.actions.find((action) => action.type === "open")?.url;
  return { key: item.key, title: item.title, ...(link ? { link } : {}), fields: item.fields ?? {} };
};

/** A message's block from a routine step: the cards it showed, else the records it listed in text. */
const routineStepBlock = (metadata: unknown): StoredReplyBlock | undefined => {
  const stored = metadata && typeof metadata === "object" ? (metadata as { blocks?: unknown; listedItems?: unknown }) : {};
  for (const candidate of [stored.blocks, stored.listedItems]) {
    const parsed = storedBlocksSchema.safeParse(candidate);
    const block = parsed.success ? parsed.data.find((entry) => entry.origin?.kind === "routine_step") : undefined;
    if (block) {
      return block;
    }
  }
  return undefined;
};

/**
 * The items the conversation's latest routine-step presentation showed (#1763): the newest
 * assistant message whose cards, or the records it listed in text where no cards are drawn, came
 * from a routine step. A typed answer on that step names one of them, and a pick counts only from
 * this presentation; the engine reads them only while that run is on that step.
 */
export const latestRoutinePresentation = (history: readonly MessageRecord[]): RoutineShownItems | undefined => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const block = message?.role === "assistant" ? routineStepBlock(message.metadata) : undefined;
    if (message && block?.origin?.kind === "routine_step") {
      const { routineId, stepId, executionId } = block.origin;
      return { routineId, stepId, ...(executionId ? { executionId } : {}), messageId: message.id, items: block.items.map(routineItemOf) };
    }
  }
  return undefined;
};
