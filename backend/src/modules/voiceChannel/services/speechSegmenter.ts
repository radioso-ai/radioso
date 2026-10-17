import { spokenText, type SpeechPosition } from "./speechText.js";

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

const STREAMING_REPLY_START: SpeechPosition = { startsLine: true, final: false };

/**
 * Cuts the complete sentences off the front of `buffer` once it is spoken text (assertion markers
 * and markdown removed); joined back together they are that cleaned buffer. A marker or delimiter
 * still open at the end of the buffer stays in the remainder until the chunk that closes it arrives.
 * `position` places the buffer in its reply; by default it starts a reply that is still streaming.
 */
export const splitCompleteSentences = (rawBuffer: string, position: SpeechPosition = STREAMING_REPLY_START): SentenceSplit => {
  const buffer = spokenText(rawBuffer, position);
  const sentences: string[] = [];
  let start = 0;
  for (const match of buffer.matchAll(SENTENCE_BOUNDARY)) {
    const end = match.index + match[0].length;
    sentences.push(buffer.slice(start, end));
    start = end;
  }
  return { sentences, remainder: buffer.slice(start) };
};

/**
 * A whole text nobody streams, such as a teammate's reply, as speech: its sentences once it is
 * spoken text, each ending in whitespace, so its last piece stays apart from what is spoken next.
 * A text with no words to say is no speech at all.
 */
export const wholeTextSpeech = (text: string): string[] => {
  // The line break that ends the text closes its last sentence.
  const { sentences, remainder } = splitCompleteSentences(`${text}\n`, { startsLine: true, final: true });
  return [...sentences, remainder].filter((piece) => piece.trim().length > 0);
};

/** A cut sentence ends its line when the whitespace after its terminator holds a line break. */
const ENDS_LINE = /\n\s*$/u;

/**
 * A streamed reply cut into sentences as its chunks arrive. It remembers whether its unfinished
 * tail starts a line of the reply, so a list marker is removed only at a real line start, and it
 * closes an emphasis left open at the end only once the reply is whole.
 */
export const createSentenceCutter = (): {
  /** The sentences `text` completes. */
  push(text: string): string[];
  /** The rest of the reply once no more text follows: any sentences, then the unterminated tail. */
  finish(): SentenceSplit;
} => {
  let pending = "";
  let startsLine = true;
  const cut = (text: string, final: boolean): SentenceSplit => {
    const split = splitCompleteSentences(pending + text, { startsLine, final });
    const last = split.sentences.at(-1);
    if (last !== undefined) {
      startsLine = ENDS_LINE.test(last);
    }
    pending = final ? "" : split.remainder;
    return split;
  };
  return {
    push: (text) => cut(text, false).sentences,
    finish: () => cut("", true),
  };
};
