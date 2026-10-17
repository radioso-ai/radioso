import { hasSpokenWords, sourcedSpokenText, type SourcedText, type SpeechPosition } from "./speechText.js";

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

/** Where each complete sentence of spoken text ends, in order. */
const sentenceEnds = (spoken: string): number[] =>
  [...spoken.matchAll(SENTENCE_BOUNDARY)].map((match) => match.index + match[0].length);

/** The sentences of spoken text cut at `ends`, and what follows the last. */
const splitAt = (spoken: string, ends: readonly number[]): SentenceSplit => ({
  sentences: ends.map((end, index) => spoken.slice(index === 0 ? 0 : ends[index - 1], end)),
  remainder: spoken.slice(ends.at(-1) ?? 0),
});

/**
 * Cuts the complete sentences off the front of `buffer` once it is spoken text (assertion markers
 * and markdown removed); joined back together they are that cleaned buffer. A marker or delimiter
 * still open at the end of the buffer stays in the remainder until the chunk that closes it arrives.
 * `position` places the buffer in its reply; by default it starts a reply that is still streaming.
 */
export const splitCompleteSentences = (rawBuffer: string, position: SpeechPosition = STREAMING_REPLY_START): SentenceSplit => {
  const { text } = sourcedSpokenText(rawBuffer, position);
  return splitAt(text, sentenceEnds(text));
};

/**
 * A whole text nobody streams, such as a teammate's reply, as speech: its sentences once it is
 * spoken text, each ending in whitespace, so its last piece stays apart from what is spoken next.
 * A text with no words to say is no speech at all.
 */
export const wholeTextSpeech = (text: string): string[] => {
  // The line break that ends the text closes its last sentence.
  const { sentences, remainder } = splitCompleteSentences(`${text}\n`, { startsLine: true, final: true });
  return [...sentences, remainder].filter(hasSpokenWords);
};

/** A cut sentence ends its line when the whitespace after its terminator holds a line break. */
const ENDS_LINE = /\n\s*$/u;

/** A sentence of a streamed reply as it is spoken, and where it ends in the reply as written. */
export interface SpeechPiece {
  text: string;
  /** The offset, in the reply's text as it streamed, right after the sentence's last spoken character. */
  writtenEnd: number;
}

/**
 * A streamed reply cut into sentences as its chunks arrive. It remembers whether its unfinished
 * tail starts a line of the reply, so a list marker is removed only at a real line start, and it
 * closes an emphasis left open at the end only once the reply is whole. Its tail is kept as spoken
 * text with each character's offset in the reply as written, so every sentence it releases knows
 * where it ends there.
 */
export const createSentenceCutter = (): {
  /** The sentences `text` completes, each with where it ends in the reply as written. */
  push(text: string): SpeechPiece[];
  /** The rest of the reply once no more text follows: any sentences, then the unterminated tail. */
  finish(): SentenceSplit;
} => {
  let pending: SourcedText = { text: "", source: [] };
  let written = 0;
  let startsLine = true;
  const cut = (text: string, final: boolean): { split: SentenceSplit; writtenEnds: number[] } => {
    const bufferSource = [...pending.source, ...Array.from({ length: text.length }, (_unit, index) => written + index)];
    written += text.length;
    const spoken = sourcedSpokenText(pending.text + text, { startsLine, final });
    const ends = sentenceEnds(spoken.text);
    const split = splitAt(spoken.text, ends);
    const last = split.sentences.at(-1);
    if (last !== undefined) {
      startsLine = ENDS_LINE.test(last);
    }
    const writtenOf = (index: number): number => bufferSource[spoken.source[index] ?? 0] ?? 0;
    const rest = ends.at(-1) ?? 0;
    pending = final
      ? { text: "", source: [] }
      : { text: split.remainder, source: spoken.source.slice(rest).map((index) => bufferSource[index] ?? 0) };
    return { split, writtenEnds: ends.map((end) => writtenOf(end - 1) + 1) };
  };
  return {
    push: (text) => {
      const { split, writtenEnds } = cut(text, false);
      return split.sentences.map((sentence, index) => ({ text: sentence, writtenEnd: writtenEnds[index] ?? written }));
    },
    finish: () => cut("", true).split,
  };
};
