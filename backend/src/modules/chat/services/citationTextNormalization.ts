export const removeDetachedPunctuationSpacing = (text: string): string =>
  text
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+(\r?\n)/g, "$1");

// Sentence punctuation that, when a citation anchor was detached onto its own line
// right before it (`claim\n\n[[1]].`), would be stranded on a new line once the anchor
// is removed. Scoped to the anchor-removal seam only — never applied to arbitrary
// answer text, which legitimately starts lines with `:`, `.`, etc. (CSS, filenames).
export const STRANDABLE_PUNCTUATION = /^[ \t]*[.,;:!?]/;
