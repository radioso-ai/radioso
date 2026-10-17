/**
 * A run of the assertion markers the answer composer writes for citations — `[[n]]`, `[[?]]`,
 * `[n]`, `[?]` with n digits — and the whitespace before it. A single-bracket marker never matches
 * inside an unfinished `[[n]` that a later chunk will close. Structure only: no words.
 */
const ASSERTION_MARKER_RUN = /\s*(?:\[\[(?:\d+|\?)\]\]|(?<!\[)\[(?:\d+|\?)\](?!\]))+/gu;

/** `[text](url)` and `![alt](url)`, with one level of parentheses inside the url; the text is spoken. */
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/gdu;

/** A heading (`#`…`######`) or list (`-`, `*`, `+`, `1.`, `1)`) marker. */
const LINE_MARKER = String.raw`[ \t]*(?:#{1,6}|[-*+]|\d{1,3}[.)])[ \t]+`;

/** A line marker right after a line break inside the text. */
const LINE_START_MARKER = new RegExp(String.raw`(?<=\n)${LINE_MARKER}`, "gu");

/** A line marker at the start of the text, removed only when the text starts a line of the reply. */
const TEXT_START_MARKER = new RegExp(`^${LINE_MARKER}`, "u");

/** Bold and underline delimiters: a run of two or more `*` or `_` is never spoken text. */
const DOUBLE_EMPHASIS = /\*{2,}|_{2,}/gu;

/** A single `*` or `_` opening emphasis: after the start, a space, a quote or an opening bracket, before text. */
const OPENING_EMPHASIS = /(?<=^|[\s\p{Ps}\p{Pi}"'])[*_](?=[^\s*_])/gu;

/**
 * A single `*` or `_` closing emphasis: after text, before a space, a line break or punctuation.
 * One between two letters (`my_setting`, `5*3`) or between two spaces (`2 * 3`) is kept, and so is
 * one at the end of a chunk, which the next chunk may continue.
 */
const CLOSING_EMPHASIS = /(?<=[^\s*_])[*_](?=[\s\p{Pe}\p{Pf}\p{Po}])/gu;

/** A single `*` or `_` closing emphasis at the very end of a whole text. */
const FINAL_CLOSING_EMPHASIS = /(?<=[^\s*_])[*_]$/u;

const INLINE_CODE = /`+/gu;

/** Where a piece of text sits in the reply it comes from. */
export interface SpeechPosition {
  /** The text starts a line of the reply: the reply's start, or right after a line break. */
  startsLine: boolean;
  /** No more text follows, so the end of the text closes an emphasis still open. */
  final: boolean;
}

const WHOLE_TEXT: SpeechPosition = { startsLine: true, final: true };

/** Text, with where each of its characters came from in the text it was cut out of. */
export interface SourcedText {
  text: string;
  /** `source[i]` is the index, in the original text, of character (UTF-16 unit) `i`. */
  source: number[];
}

/**
 * `mapped` without `pattern`'s matches, each removed whole except its group `keptGroup` (which
 * needs the pattern's `d` flag), as `String.prototype.replace` would remove them.
 */
const removeMatches = (mapped: SourcedText, pattern: RegExp, keptGroup?: number): SourcedText => {
  const parts: string[] = [];
  const source: number[] = [];
  const keep = (from: number, to: number): void => {
    parts.push(mapped.text.slice(from, to));
    source.push(...mapped.source.slice(from, to));
  };
  const matches = pattern.global ? [...mapped.text.matchAll(pattern)] : [mapped.text.match(pattern)].filter((match) => match !== null);
  let cursor = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    keep(cursor, start);
    const group = keptGroup === undefined ? undefined : match.indices?.[keptGroup];
    if (group) {
      keep(group[0], group[1]);
    }
    cursor = start + match[0].length;
  }
  keep(cursor, mapped.text.length);
  return { text: parts.join(""), source };
};

/**
 * The text a caller hears, with where each of its characters stands in `text`: assertion markers
 * and markdown syntax (emphasis, inline code, heading and list markers at a line start, links)
 * removed, the words kept. "la **versione open-source**" becomes "la versione open-source";
 * hyphens, apostrophes, decimals and ellipses stay. Structure only, so it reads any language the
 * same way. For a streamed piece, `position` says whether it starts a line and whether more text
 * follows; applied again to its own output with more text appended it changes nothing already
 * decided, so a delimiter split across chunks is removed once the chunk that completes it arrives.
 */
export const sourcedSpokenText = (text: string, position: SpeechPosition = WHOLE_TEXT): SourcedText => {
  const steps: Array<[RegExp, number?]> = [
    [MARKDOWN_LINK, 1],
    [ASSERTION_MARKER_RUN],
    [LINE_START_MARKER],
    ...(position.startsLine ? [[TEXT_START_MARKER] as [RegExp]] : []),
    [DOUBLE_EMPHASIS],
    [OPENING_EMPHASIS],
    [CLOSING_EMPHASIS],
    ...(position.final ? [[FINAL_CLOSING_EMPHASIS] as [RegExp]] : []),
    [INLINE_CODE],
  ];
  return steps.reduce<SourcedText>(
    (mapped, [pattern, keptGroup]) => removeMatches(mapped, pattern, keptGroup),
    { text, source: [...Array(text.length).keys()] },
  );
};

/** The text a caller hears; see {@link sourcedSpokenText}. */
export const spokenText = (text: string, position: SpeechPosition = WHOLE_TEXT): string => sourcedSpokenText(text, position).text;

/** Spoken text as two renderings of it agree on: zero-width spaces dropped, whitespace single, ends trimmed. */
export const comparableSpeech = (text: string): string => text.replace(/\u200B/gu, "").replace(/\s+/gu, " ").trim();

/** The length of spoken text in characters (code points), as the caller's runtime renders it. */
export const spokenLength = (text: string): number => Array.from(comparableSpeech(text)).length;

/** What is left after a heard prefix carries no words: only punctuation and whitespace. */
const WORDLESS = /^[\p{P}\s]*$/u;

/** Whether spoken text holds anything to say: more than punctuation and whitespace. */
export const hasSpokenWords = (text: string): boolean => !WORDLESS.test(text);
