import { comparableSpeech, hasSpokenWords, spokenLength } from "./speechText.js";

/** A turn's speech, in the order it left: what reached the runtime, or what the turn spoke. */
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

type PiecePart = "operator" | "bridge" | "answer";

/**
 * How many leading pieces `report` covers, and how many characters it runs into the next one.
 * Piece by piece, so whatever the runtime puts between pieces (a flush delta, a space, nothing
 * after a full-width terminator) is skipped as whitespace. A report that leaves out only
 * punctuation covers every piece; null when it is no prefix of the pieces.
 */
const coveredBy = (pieces: readonly string[], report: string): { whole: number; intoNext: number } | null => {
  let cursor = 0;
  for (const [index, piece] of pieces.entries()) {
    while (cursor < report.length && /\s/u.test(report[cursor] ?? "")) cursor += 1;
    const rest = report.slice(cursor);
    if (rest.startsWith(piece)) {
      cursor += piece.length;
      continue;
    }
    if (!piece.startsWith(rest)) {
      return null;
    }
    const unheard = [piece.slice(rest.length), ...pieces.slice(index + 1)].join(" ");
    return hasSpokenWords(unheard) ? { whole: index, intoNext: Array.from(rest).length } : { whole: pieces.length, intoNext: 0 };
  }
  return report.slice(cursor).trim().length === 0 ? { whole: pieces.length, intoNext: 0 } : null;
};

/**
 * How much of `speech` the caller heard. `report` is the runtime's record of what it played, cut
 * where the caller spoke over it; without one, all of `speech` counts as heard. Null when the
 * report is no prefix of it, so it says nothing about this speech. A bridge line without words
 * is not measured: the runtime's record holds nothing of it.
 */
export const heardSpeechOf = (speech: ReachedSpeech, report?: string): HeardSpeech | null => {
  const pieces: Array<{ part: PiecePart; text: string }> = [
    ...speech.operatorReplies.map((text) => ({ part: "operator" as const, text })),
    ...(speech.bridge !== null && hasSpokenWords(speech.bridge) ? [{ part: "bridge" as const, text: speech.bridge }] : []),
    ...speech.answer.map((text) => ({ part: "answer" as const, text })),
  ].filter((piece) => comparableSpeech(piece.text).length > 0);
  const covered = report === undefined
    ? { whole: pieces.length, intoNext: 0 }
    : coveredBy(pieces.map((piece) => comparableSpeech(piece.text)), comparableSpeech(report));
  if (!covered) {
    return null;
  }
  const heard = pieces.slice(0, covered.whole);
  const heardAnswer = heard.filter((piece) => piece.part === "answer").map((piece) => piece.text).join("");
  const cutInAnswer = pieces[covered.whole]?.part === "answer" && covered.intoNext > 0;
  // The runtime renders a space between the last whole piece and the next only where the text has one.
  const spaceBeforeCut = cutInAnswer && heardAnswer.length > 0 && /\s$/u.test(heardAnswer) ? 1 : 0;
  return {
    operatorReplyPieces: heard.filter((piece) => piece.part === "operator").length,
    answerPieces: heard.filter((piece) => piece.part === "answer").length,
    answerHeardCharacterCount: spokenLength(heardAnswer) + spaceBeforeCut + (cutInAnswer ? covered.intoNext : 0),
    answerSpokenCharacterCount: spokenLength(speech.answer.join("")),
  };
};
