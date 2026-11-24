import type { StoredReplyBlock } from "../../contracts/replyBlocks.js";
import type { PresentedReplyBlocks } from "./replyBlockTurn.js";

/**
 * What a reply's message keeps of its reply blocks, in its metadata: the cards it showed, and the
 * records a routine step listed in text where no cards are drawn (#1763). Server-only: a block's
 * origin and its items' fields never reach a client from here. A pick and a typed answer to a
 * routine step read them back (`readItemSelection`, `latestRoutinePresentation`).
 */
export interface MessageReplyBlocks {
  blocks?: StoredReplyBlock[];
  listedItems?: StoredReplyBlock[];
}

/** The part of a reply's message metadata its blocks fill; undefined when it presented and listed none. */
export const messageReplyBlocks = (presentation: {
  replyBlocks?: Pick<PresentedReplyBlocks, "stored">;
  listedItems?: StoredReplyBlock;
}): MessageReplyBlocks | undefined =>
  presentation.replyBlocks || presentation.listedItems
    ? {
        ...(presentation.replyBlocks ? { blocks: presentation.replyBlocks.stored } : {}),
        ...(presentation.listedItems ? { listedItems: [presentation.listedItems] } : {}),
      }
    : undefined;
