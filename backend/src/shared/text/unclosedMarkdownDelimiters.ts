/**
 * The start of a markdown text, cut where its writer had not finished: the delimiters it opens
 * and never closes removed, so it renders as the words it holds. A link's text, a code span (a
 * backtick run, closed by a run of the same length) and emphasis (a run of `*` or `_`) are the
 * constructs a cut can leave open. Structure only, so it reads any language the same way; closers
 * and constructs that are whole are left as written.
 */

/** Whitespace, or nothing at all (the edge of the text). */
const isSpaceOrEdge = (character: string | undefined): boolean => character === undefined || /\s/u.test(character);

/**
 * Emphasis opens where a delimiter run follows the text's start, a space, an opening bracket, an
 * opening quote, or a straight quote, and comes before something other than a space; it closes
 * where the run follows something other than a space and comes before the text's end, a space, or
 * punctuation. A run between two letters (`my_setting`, `5*3`) is neither, as speech reads it too.
 */
const OPENS_AFTER = /^[\s\p{Ps}\p{Pi}"']$/u;
const CLOSES_BEFORE = /^[\s\p{P}]$/u;

const opensEmphasis = (before: string | undefined, after: string | undefined): boolean =>
  (before === undefined || OPENS_AFTER.test(before)) && !isSpaceOrEdge(after);

const closesEmphasis = (before: string | undefined, after: string | undefined): boolean =>
  !isSpaceOrEdge(before) && (after === undefined || CLOSES_BEFORE.test(after));

/** The length of the run of `character` that starts at `start`. */
const runLength = (text: string, start: number, character: string): number => {
  let end = start;
  while (text[end] === character) end += 1;
  return end - start;
};

interface Opener {
  start: number;
  length: number;
}

/** `text` without the delimiters it leaves open at its end. */
export const withoutUnclosedMarkdownDelimiters = (text: string): string => {
  const unclosed: Opener[] = [];
  const linkTexts: Opener[] = [];
  const emphasis: Array<Opener & { character: string }> = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "`") {
      const length = runLength(text, index, "`");
      // A code span runs to the next run of exactly as many backticks; inside it, nothing else is markdown.
      let close = index + length;
      while (close < text.length && !(text[close] === "`" && runLength(text, close, "`") === length && text[close - 1] !== "`")) {
        close += text[close] === "`" ? runLength(text, close, "`") : 1;
      }
      if (close >= text.length) {
        unclosed.push({ start: index, length });
        index += length;
        continue;
      }
      index = close + length;
      continue;
    }
    if (character === "[") {
      linkTexts.push({ start: index, length: 1 });
    } else if (character === "]") {
      linkTexts.pop();
    } else if (character === "*" || character === "_") {
      const length = runLength(text, index, character);
      const before = text[index - 1];
      const after = text[index + length];
      let open = emphasis.length - 1;
      while (open >= 0 && emphasis[open]?.character !== character) open -= 1;
      if (open !== -1 && closesEmphasis(before, after)) {
        emphasis.splice(open);
      } else if (opensEmphasis(before, after)) {
        emphasis.push({ start: index, length, character });
      }
      index += length;
      continue;
    }
    index += 1;
  }
  const removed = [...unclosed, ...linkTexts, ...emphasis].sort((left, right) => right.start - left.start);
  return removed.reduce((repaired, opener) => repaired.slice(0, opener.start) + repaired.slice(opener.start + opener.length), text);
};
