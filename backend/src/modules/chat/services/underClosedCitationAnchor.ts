// The grounded-answer protocol spells a citation anchor `[[<digits>]]`, or `[[?]]` for
// the explicitly-unsourced marker (see `citationAnchorParser.ts`'s `ANCHOR_PATTERN` and
// `unsourcedMarkerCanonicalization.ts`). The model sometimes drops the final `]`,
// leaving that same content closed by one bracket instead of two — `[[?]`, `[[12]`
// (#1517). The three consumers that read raw model text for this shape — the streaming
// holdback, the presentation cleanup, and the fallback-decline cleanup — all import this
// module instead of repeating the character class: the token disappears, nothing else
// is touched.
const ANCHOR_CONTENT = "(?:\\d+|\\?)";
const UNDER_CLOSED_ANCHOR_CORE = `\\[\\[${ANCHOR_CONTENT}\\]`;

// Static text — the final answer, a decline reply — has no more chunks coming, so a
// match sitting at the very end of the string is already final: nothing can still
// arrive to turn it into a complete `]]`. `(?!\])` alone is enough to rule out an
// adjacent `]` that would make it a complete anchor (already removed upstream).
const UNDER_CLOSED_CITATION_ANCHOR = new RegExp(`${UNDER_CLOSED_ANCHOR_CORE}(?!\\])`, "g");

export const stripUnderClosedCitationAnchors = (text: string): string =>
  text.replace(UNDER_CLOSED_CITATION_ANCHOR, "");

// Streaming text keeps arriving, so a match sitting at the very end of the *current*
// buffer is still ambiguous — the next chunk could still bring the second `]`. Only a
// match with an already-received character after it, and that character is not `]`, is
// locked in as under-closed: nothing later can make it valid.
const LOCKED_IN_UNDER_CLOSED_CITATION_ANCHOR = new RegExp(`${UNDER_CLOSED_ANCHOR_CORE}(?=[^\\]])`, "g");

/**
 * Removes every under-closed anchor in `text` that is already confirmed un-completable
 * because a real, received character — not `]` — follows it. Safe to call on a growing
 * streaming buffer as each chunk arrives: a marker still sitting at the buffer's end is
 * left alone, because the very next chunk could still complete it.
 */
export const removeLockedInUnderClosedCitationAnchors = (text: string): string =>
  text.replace(LOCKED_IN_UNDER_CLOSED_CITATION_ANCHOR, "");

// Whether `text` is nothing but an in-progress or under-closed anchor attempt — `[[`,
// `[[12`, `[[?`, `[[12]`, `[[?]` — with no other content before or after it. A streaming
// carry buffer this shape holds nothing but the token itself, so it is never worth
// capping: capping it could only ever discard token characters, never answer text, and
// leaving it uncapped lets a later chunk, or `flush()`, resolve it correctly no matter
// how long the model's citation number runs.
const isUnderClosedAnchorAttempt = (text: string): boolean =>
  /^\[\[(?:\d+|\?)?\]?$/.test(text);

// The longest prefix of a still-open `[[` candidate that could still become a complete
// or under-closed anchor: the brackets, then optionally its content (digits or `?`),
// then optionally the one closing bracket that would make it under-closed. Always
// matches at least `[[` itself.
const OPEN_ANCHOR_ATTEMPT_PREFIX = /^\[\[(?:\d+|\?)?\]?/;

/**
 * Splits a still-open `[[` candidate — the sanitizer's unresolved suffix, carrying no
 * `]]` anywhere in it — into the part that could still become a complete or
 * under-closed anchor (`carry`) and the part already confirmed to never complete
 * (`release`, meant to rejoin the visible stream). A character outside the anchor
 * grammar (anything but a digit, `?`, or the one closing bracket) proves `open` was
 * never an anchor at all: unlike the locked-in check for an already-closed marker, that
 * is decidable the instant the disqualifying character is read, with no need to wait
 * for one more. Holding it any longer, or dropping it at a carry cap, would discard
 * real answer text — so once confirmed dead, the whole candidate releases, and nothing
 * is held.
 */
export const splitOpenAnchorAttempt = (open: string): { carry: string; release: string } => {
  if (isUnderClosedAnchorAttempt(open)) {
    return { carry: open, release: "" };
  }
  const deadPrefixLength = open.match(OPEN_ANCHOR_ATTEMPT_PREFIX)?.[0].length ?? 0;
  return { carry: "", release: open.slice(deadPrefixLength) };
};
