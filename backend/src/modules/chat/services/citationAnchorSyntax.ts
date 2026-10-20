// The grounded-answer protocol marks a claim's source with a citation anchor, `[[<n>]]` for
// a result number or `[[?]]` for an explicitly unsourced claim. This module is the one
// definition of what counts as anchor syntax in model text. A finished answer reads through
// it in assertion grouping and residual cleanup (`citationAnchorParser.ts`) and in the
// decline composer; the streaming holdback (`citationAnchorSanitizer.ts`) reads the same
// answer chunk by chunk. One grammar is what makes a streamed answer, joined, equal the
// finished one.

/**
 * The longest span, brackets included, read as anchor syntax. The model's anchors hold a
 * one- or two-digit result number or `?`, and the malformed ones it writes stay short too:
 * `[[1, 3]]`, `[[12xyz]]`, a page title such as `[[Example Page]]`. 64 characters covers a
 * title-length label and bounds how long the stream holds back a literal `[[` that never
 * closes, about 16 tokens, before releasing it as text.
 */
export const CITATION_ANCHOR_MAX_LENGTH = 64;

const MAX_CONTENT_LENGTH = CITATION_ANCHOR_MAX_LENGTH - "[[]]".length;
// What a span holds between its brackets. No bracket, so spans never nest or overlap and the
// first `[[` decides; no line break, because an anchor is inline; no backtick, so removing a
// span never changes which text is inline code.
const SPAN_CONTENT = "[^\\[\\]\\r\\n`]";
const MARKER = `(?:\\d{1,${MAX_CONTENT_LENGTH}}|\\?)`;
const SPAN = `\\[\\[${SPAN_CONTENT}{0,${MAX_CONTENT_LENGTH}}\\]\\]`;
// One `]` short of a complete anchor (#1517): `[[?]`, `[[12]`.
const UNDER_CLOSED = `\\[\\[${MARKER}\\](?!\\])`;
// An anchor the answer ends inside: `[[`, `[[12`, `[[?`, then only whitespace.
const CUT_SHORT = `\\[\\[${MARKER}?\\s*$`;

// One left-to-right pass: a removal never joins its neighbours into a new match, so text that
// is literal in the whole answer stays literal however the stream split it.
const ANCHOR_SYNTAX = new RegExp(`${SPAN}|${UNDER_CLOSED}`, "g");
const ANCHOR_SYNTAX_AT_ANSWER_END = new RegExp(`${SPAN}|${UNDER_CLOSED}|${CUT_SHORT}`, "g");
const COMPLETE_ANCHOR = new RegExp(`\\[\\[(${MARKER})\\]\\]`, "g");

/** Pattern source for one complete anchor, `[[<n>]]` or `[[?]]`, to place in a wider pattern. */
export const COMPLETE_CITATION_ANCHOR_SOURCE = `\\[\\[${MARKER}\\]\\]`;
// A `[[` that more text could still turn into anchor syntax: a span within the bound that has
// not closed yet (`[[Exam`, `[[12]`), or a cut-short anchor followed only by whitespace so far.
const PENDING_ANCHOR = new RegExp(`\\[\\[(?:${SPAN_CONTENT}{0,${MAX_CONTENT_LENGTH}}\\]?|${MARKER}?\\s*)$`);

interface CitationAnchor {
  start: number;
  end: number;
  /** `null` for the unsourced `[[?]]`. */
  resultNumber: number | null;
}

/** The complete anchors in `text`, `[[<n>]]` and `[[?]]`, in order. */
export const findCitationAnchors = (text: string): CitationAnchor[] =>
  [...text.matchAll(COMPLETE_ANCHOR)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    resultNumber: match[1] === "?" ? null : Number(match[1]),
  }));

/**
 * Removes the anchor syntax in `text`: every bracketed span within the length bound,
 * complete anchors included, and every under-closed anchor. With `endsAnswer`, nothing
 * follows `text`, so an anchor it ends inside goes too. Any other `[[` is literal text and
 * stays, brackets included.
 */
export const stripCitationAnchorSyntax = (text: string, { endsAnswer }: { endsAnswer: boolean }): string =>
  text.replace(endsAnswer ? ANCHOR_SYNTAX_AT_ANSWER_END : ANCHOR_SYNTAX, "");

/**
 * Splits streamed text into the part already settled and a trailing `[[` candidate still
 * pending. The settled part strips the same way whatever arrives next: no span reaches into
 * the candidate, whose `[[` is a bracket no span holds. The candidate stays pending only
 * while it can still become anchor syntax within the bound, so it is never longer than
 * {@link CITATION_ANCHOR_MAX_LENGTH} apart from trailing whitespace.
 */
export const splitPendingCitationAnchor = (text: string): { settled: string; pending: string } => {
  const start = text.search(PENDING_ANCHOR);
  return start < 0
    ? { settled: text, pending: "" }
    : { settled: text.slice(0, start), pending: text.slice(start) };
};
