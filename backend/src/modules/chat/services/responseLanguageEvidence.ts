import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { SelectedItem } from "./replyBlocks/itemSelection.js";

const isPick = (message: MessageRecord): boolean =>
  message.role === "user" && message.inputMetadata?.method === "item_select";

/**
 * What a turn's response language is judged on: the visitor's latest words and the history. A
 * picked card's title is the page's or the record's own text, in whatever language that is written
 * in, never the visitor's, so picks stay out of the history, and a pick turn is judged on the last
 * message the visitor wrote. With none written yet, the query is empty and the detector reads the
 * conversation, the greeting included.
 */
export const responseLanguageEvidence = (
  query: string,
  turn: { itemSelection?: SelectedItem; history: MessageRecord[] },
): { query: string; history: MessageRecord[] } => {
  const history = turn.history.filter((message) => !isPick(message));
  if (!turn.itemSelection) {
    return { query, history };
  }
  const written = history.findLast((message) => message.role === "user");
  return { query: written?.content ?? "", history };
};
