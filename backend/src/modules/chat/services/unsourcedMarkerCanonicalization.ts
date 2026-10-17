// The grounded-answer protocol spells the unsupported-claim marker `[[?]]`; the model
// sometimes writes it with single brackets (#1502). Model answer text is read through
// `canonicalizeUnsourcedMarkers` where it enters each consumer, so the one `[[?]]` grammar
// (assertion parsing, residual-syntax cleanup, streaming holdback) covers both spellings.
//
// Only `[?]` is rewritten. A single-bracket number (`[1]`, `[2024]`, `arr[0]`) is ordinary
// answer text far more often than a marker, so it is never touched.

// Not preceded by `[`, so the inner `[?]` of a `[[?]]` is left as it is. Nothing after the
// marker is consulted: a following `]` or `(` stays as the model wrote it, for the `[[?]]`
// handling to treat exactly as it treats the same text after `[[?]]`. Module-private and
// only used with `String.prototype.replace`, which resets `lastIndex`.
const SINGLE_BRACKET_UNSOURCED_MARKER = /(?<!\[)\[\?\]/g;
const UNSOURCED_MARKER = "[[?]]";

// Inline code is content: `[?]` in a regex or glob example stays. A backtick opens a code
// span that runs to the next backtick on the same line, or to the end of the line when none
// follows. That errs toward leaving text alone, and it is decidable chunk by chunk, so a
// streaming caller carries it across chunk boundaries as one boolean. Fenced code blocks
// are not recognised: a `[?]` on a fenced line with no backticks of its own reads as a
// marker.
const INLINE_CODE_BOUNDARY = /([`\n])/;

export const canonicalizeUnsourcedMarkers = (text: string, startsInInlineCode = false): string => {
  let inInlineCode = startsInInlineCode;
  return text
    .split(INLINE_CODE_BOUNDARY)
    .map((part) => {
      if (part === "`" || part === "\n") {
        inInlineCode = part === "`" && !inInlineCode;
        return part;
      }
      return inInlineCode ? part : part.replace(SINGLE_BRACKET_UNSOURCED_MARKER, UNSOURCED_MARKER);
    })
    .join("");
};

/** Whether `text`, read from `startsInInlineCode`, leaves an inline code span open. */
export const endsInInlineCode = (text: string, startsInInlineCode = false): boolean => {
  const lastLineStart = text.lastIndexOf("\n") + 1;
  const backticks = text.slice(lastLineStart).split("`").length - 1;
  const lineStartsInInlineCode = lastLineStart === 0 && startsInInlineCode;
  return lineStartsInInlineCode !== (backticks % 2 === 1);
};
