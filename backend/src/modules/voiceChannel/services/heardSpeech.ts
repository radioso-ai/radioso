import { heardLength, spokenLength } from "./speechText.js";

/** The speech a turn handed the runtime before it lost its caller, in the order it left. */
export interface ReachedSpeech {
  /** The teammate replies' pieces, spoken ahead of everything else. */
  operatorReplies: readonly string[];
  bridge: string | null;
  /** The pieces of the turn's own answer. */
  answer: readonly string[];
}

/** How much of a turn's speech its caller heard. */
export interface HeardSpeech {
  /** How many of the teammate replies' pieces were heard to their end. */
  operatorReplyPieces: number;
  /** How many of the answer's pieces were heard to their end. */
  answerPieces: number;
  /** The answer's characters heard, which can reach into a piece heard only in part. */
  answerHeardCharacterCount: number;
  /** The answer's characters that reached the runtime. */
  answerSpokenCharacterCount: number;
}

/** How many of `pieces`, spoken from `offset` on, end within `heard` characters. */
const piecesWithin = (pieces: readonly string[], offset: number, heard: number): number => {
  let count = 0;
  while (count < pieces.length && offset + spokenLength(pieces.slice(0, count + 1).join("")) <= heard) {
    count += 1;
  }
  return count;
};

/**
 * How much of `reached` the caller heard. `report` is the runtime's record of what it played, cut
 * where the caller spoke over it; without one, everything that reached the runtime counts as
 * heard. Null when the report is no prefix of what reached it, so it says nothing about this
 * speech. Counted as the runtime renders speech: plainly spaced, one space between its parts.
 */
export const heardSpeechOf = (reached: ReachedSpeech, report?: string): HeardSpeech | null => {
  const teammate = reached.operatorReplies.join("");
  const answer = reached.answer.join("");
  const parts = [teammate, reached.bridge ?? "", answer].filter((part) => spokenLength(part) > 0);
  const whole = parts.join(" ");
  const heard = report === undefined ? spokenLength(whole) : heardLength(whole, report);
  if (heard === null) {
    return null;
  }
  const answerStart = parts.slice(0, -1).reduce((characters, part) => characters + spokenLength(part) + 1, 0);
  const answerSpokenCharacterCount = spokenLength(answer);
  const answerHeardCharacterCount = answerSpokenCharacterCount === 0 ? 0 : Math.min(answerSpokenCharacterCount, Math.max(0, heard - answerStart));
  return {
    operatorReplyPieces: piecesWithin(reached.operatorReplies, 0, heard),
    answerPieces: answerSpokenCharacterCount === 0 ? 0 : piecesWithin(reached.answer, answerStart, heard),
    answerHeardCharacterCount,
    answerSpokenCharacterCount,
  };
};
