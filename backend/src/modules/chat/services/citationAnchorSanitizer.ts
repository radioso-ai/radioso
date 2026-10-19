import { removeDetachedPunctuationSpacing, STRANDABLE_PUNCTUATION } from "./citationTextNormalization.js";
import { canonicalizeUnsourcedMarkers, endsInInlineCode } from "./unsourcedMarkerCanonicalization.js";
import { isUnderClosedAnchorAttempt, removeLockedInUnderClosedCitationAnchors } from "./underClosedCitationAnchor.js";

const COMPLETE_ANCHOR = /\[\[\d+\]\]/g;
const ANY_BRACKET_ANCHOR = /\[\[[^\]]*?\]\]/g;
// A citation anchor the model detached onto its own line, sitting right before the
// punctuation that closes the claim (`claim\n\n[[1]].`). When the punctuation is in the
// same buffer we can drop the line break and the anchor together in one pass.
const DETACHED_ANCHOR_BEFORE_PUNCTUATION = /[ \t]*\r?\n\s*\[\[\d+\]\][ \t]*(?=[.,;:!?])/g;
// The same shape when it lands at a chunk boundary: the detached anchor ends one chunk
// and its punctuation opens the next, so the line break must be held back to decide.
const TRAILING_DETACHED_ANCHOR = /\r?\n[ \t\r\n]*\[\[\d+\]\][ \t]*$/;

const stripCompleteAnchors = (text: string): string =>
  removeDetachedPunctuationSpacing(text
    .replace(COMPLETE_ANCHOR, "")
    .replace(ANY_BRACKET_ANCHOR, ""));

export class CitationAnchorSanitizer {
  private carry = "";
  // A line break left behind by a detached trailing anchor. Held back so the next chunk
  // can decide: drop it if punctuation follows (the anchor stranded it), keep it
  // otherwise (it was a genuine paragraph break).
  private pendingLineBreak = "";
  // Whether the text released so far left an inline code span open on its last line, so
  // a `[?]` the next chunk carries inside that span is read as content, not a marker.
  private inInlineCode = false;

  push(chunk: string): string {
    const released = this.release(chunk);
    this.inInlineCode = endsInInlineCode(released, this.inInlineCode);
    return released;
  }

  private release(chunk: string): string {
    let combined = `${this.carry}${chunk ?? ""}`;
    this.carry = "";

    if (this.pendingLineBreak) {
      const heldLineBreak = this.pendingLineBreak;
      this.pendingLineBreak = "";
      if (!STRANDABLE_PUNCTUATION.test(combined)) {
        combined = `${heldLineBreak}${combined}`;
      }
    }

    combined = canonicalizeUnsourcedMarkers(combined, this.inInlineCode);
    const reflowed = combined.replace(DETACHED_ANCHOR_BEFORE_PUNCTUATION, "");
    // A marker closed by one `]` instead of two (#1517) can never complete once a
    // received character after it is confirmed not to be `]`. Resolving that the moment
    // it is known — however far into the buffer — means the carry cap below never has to
    // hold, and potentially drop, the answer text that follows the marker.
    const stripped = removeLockedInUnderClosedCitationAnchors(stripCompleteAnchors(reflowed));

    const suffixMatch = stripped.match(/\[\[(?:(?!\]\]).)*$/s);
    if (suffixMatch && suffixMatch.index !== undefined) {
      const start = suffixMatch.index;
      const open = stripped.slice(start);
      // An in-progress or under-closed anchor attempt holds nothing but the token
      // itself (the step above already released everything after a resolved one), so
      // capping it could only ever discard token characters, never answer text. Leave
      // it uncapped: a later chunk, or flush(), resolves it correctly regardless of how
      // long the model's citation number runs.
      this.carry = isUnderClosedAnchorAttempt(open) ? open : open.slice(-32);
      return stripped.slice(0, start);
    }

    // A trailing `[` or `[?` may open an anchor or a single-bracket `[?]` the next chunk
    // completes.
    const openBracketTail = stripped.match(/\[\??$/)?.[0];
    if (openBracketTail) {
      this.carry = openBracketTail;
      return stripped.slice(0, -openBracketTail.length);
    }

    // The combined buffer ended with a detached anchor whose punctuation, if any, will
    // arrive in the next chunk. Hold the line break it left behind rather than emitting
    // it, so a punctuation-leading next chunk can collapse it onto the prior line.
    if (TRAILING_DETACHED_ANCHOR.test(combined)) {
      const lineBreak = stripped.match(/\r?\n\s*$/)?.[0];
      if (lineBreak) {
        this.pendingLineBreak = lineBreak;
        return stripped.slice(0, -lineBreak.length);
      }
    }

    const trailingWhitespace = stripped.match(/[ \t]+$/)?.[0];
    if (trailingWhitespace) {
      this.carry = trailingWhitespace;
      return stripped.slice(0, -trailingWhitespace.length);
    }

    return stripped;
  }

  flush(): string {
    // Nothing discarded here is ever answer text: `release()` only ever leaves an
    // in-progress or under-closed anchor attempt in `carry` — never that plus
    // whatever followed it, since the locked-in removal above already released that
    // part as soon as it was confirmed. The stream is over, so this attempt cannot
    // complete either way; removing it here matches how every other anchor shape
    // (complete or malformed) stays invisible to the visitor.
    this.carry = "";
    this.pendingLineBreak = "";
    this.inInlineCode = false;
    return "";
  }
}
