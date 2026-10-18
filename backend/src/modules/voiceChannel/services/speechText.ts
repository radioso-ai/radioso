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

/** One removal speech makes: every match of `pattern` goes, except its group `keptGroup` (a link's text). */
interface SpeechRemoval {
  pattern: RegExp;
  keptGroup?: number;
}

/**
 * The removals that turn text into speech, in order: links to their text, assertion markers,
 * heading and list markers at a line start (at the text's start only when it starts a line),
 * bold and underline runs, single emphasis delimiters (one still open at the end only once the
 * text is final), and inline code backticks. Structure only, so it reads any language the same way.
 */
export const speechRemovals = (position: SpeechPosition): readonly SpeechRemoval[] => [
  { pattern: MARKDOWN_LINK, keptGroup: 1 },
  { pattern: ASSERTION_MARKER_RUN },
  { pattern: LINE_START_MARKER },
  ...(position.startsLine ? [{ pattern: TEXT_START_MARKER }] : []),
  { pattern: DOUBLE_EMPHASIS },
  { pattern: OPENING_EMPHASIS },
  { pattern: CLOSING_EMPHASIS },
  ...(position.final ? [{ pattern: FINAL_CLOSING_EMPHASIS }] : []),
  { pattern: INLINE_CODE },
];

/**
 * The text a caller hears: assertion markers and markdown syntax (emphasis, inline code, heading
 * and list markers at a line start, links) removed, the words kept. "la **versione open-source**"
 * becomes "la versione open-source"; hyphens, apostrophes, decimals and ellipses stay. For a
 * streamed piece, `position` says whether it starts a line and whether more text follows; applied
 * again to its own output with more text appended it changes nothing already decided, so a
 * delimiter split across chunks is removed once the chunk that completes it arrives.
 */
export const spokenText = (text: string, position: SpeechPosition = WHOLE_TEXT): string =>
  speechRemovals(position).reduce(
    (spoken, { pattern, keptGroup }) => spoken.replace(pattern, keptGroup === undefined ? "" : `$${keptGroup}`),
    text,
  );

/** Spoken text as two renderings of it agree on: zero-width spaces dropped, whitespace single, ends trimmed. */
export const comparableSpeech = (text: string): string => text.replace(/\u200B/gu, "").replace(/\s+/gu, " ").trim();

/** The length of spoken text in characters (code points), as the caller's runtime renders it. */
export const spokenLength = (text: string): number => Array.from(comparableSpeech(text)).length;

/** What is left after a heard prefix carries no words: only punctuation and whitespace. */
const WORDLESS = /^[\p{P}\s]*$/u;

/** Whether spoken text holds anything to say: more than punctuation and whitespace. */
export const hasSpokenWords = (text: string): boolean => !WORDLESS.test(text);
