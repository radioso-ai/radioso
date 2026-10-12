/**
 * A sentence ends at a Unicode sentence terminator (`.`, `?`, `؟`, `।`, …) or an ellipsis, with any
 * closing quotes or brackets, once whitespace proves it ended (so "3.50" and an unfinished "nine."
 * stay whole). Full-width terminators are written without a following space, so they end a
 * sentence on their own. Punctuation only: this cuts any language the same way and knows no words.
 */
const SENTENCE_BOUNDARY = /(?:\p{Sentence_Terminal}|…)+["'”’»)\]」』）]*\s+|[。！？]+[」』）”’"']*\s*/gu;

interface SentenceSplit {
  /** Complete sentences, each with its punctuation and trailing whitespace. */
  sentences: string[];
  /** The unfinished tail, waiting for more text or the end of the reply. */
  remainder: string;
}

/** Cuts the complete sentences off the front of `buffer`; joined back together they are `buffer`. */
export const splitCompleteSentences = (buffer: string): SentenceSplit => {
  const sentences: string[] = [];
  let start = 0;
  for (const match of buffer.matchAll(SENTENCE_BOUNDARY)) {
    const end = match.index + match[0].length;
    sentences.push(buffer.slice(start, end));
    start = end;
  }
  return { sentences, remainder: buffer.slice(start) };
};
