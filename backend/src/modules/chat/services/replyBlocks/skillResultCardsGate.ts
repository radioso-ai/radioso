import type { ReplyBlocksCapability } from "../../contracts/replyBlocks.js";
import type { PreparedSession } from "../chatSessionPreparer.js";

/**
 * Whether a skill-result reply may show cards this turn, and the item-list layouts the client
 * draws them in; null when it may not. The one gate for skill-result cards: the offer of the
 * `present` head and the check that a records-only result can be answered both read it, so the
 * two never disagree.
 */
export const skillResultCardsFor = (
  session: Pick<PreparedSession, "replyBlocks">,
): NonNullable<ReplyBlocksCapability["item_list"]> | null => session.replyBlocks?.item_list ?? null;
