import {
  COMPLETE_CITATION_ANCHOR_SOURCE,
  splitPendingCitationAnchor,
  stripCitationAnchorSyntax,
} from "./citationAnchorSyntax.js";
import { removeDetachedPunctuationSpacing, STRANDABLE_PUNCTUATION } from "./citationTextNormalization.js";
import { canonicalizeUnsourcedMarkers, endsInInlineCode } from "./unsourcedMarkerCanonicalization.js";

// Citation anchors the model detached onto their own line, sitting right before the
// punctuation that closes the claim (`claim\n\n[[1]].`, `claim\n\n[[1]][[2]].`). When the
// punctuation is in the same buffer we can drop the line break and the anchors together in
// one pass, deciding with the same `STRANDABLE_PUNCTUATION` check the chunk-boundary case
// below uses.
const DETACHED_ANCHORS = `\\r?\\n\\s*(?:${COMPLETE_CITATION_ANCHOR_SOURCE}[ \\t]*)+`;
const DETACHED_ANCHOR = new RegExp(`[ \\t]*${DETACHED_ANCHORS}`, "g");
const removeDetachedAnchorsBeforePunctuation = (text: string): string =>
  text.replace(DETACHED_ANCHOR, (anchors: string, offset: number) =>
    STRANDABLE_PUNCTUATION.test(text.slice(offset + anchors.length)) ? "" : anchors);
// The same shape when it lands at a chunk boundary: the detached anchors end one chunk
// and their punctuation opens the next, so the line break must be held back to decide.
const TRAILING_DETACHED_ANCHOR = new RegExp(`${DETACHED_ANCHORS}$`);

const stripAnchorSyntax = (text: string, endsAnswer: boolean): string =>
  removeDetachedPunctuationSpacing(stripCitationAnchorSyntax(text, { endsAnswer }));

/**
 * Removes citation anchor syntax from an answer streamed in chunks. Whatever the chunking,
 * the joined output equals the answer stripped whole through the same grammar
 * (`citationAnchorSyntax.ts`), which is what the finished answer's presentation applies.
 * Callers must emit `flush()` when the stream ends: text held behind a `[[` that never
 * became anchor syntax comes back from it.
 */
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
      // Nothing but whitespace yet, so whether punctuation follows is still open.
      if (!combined.trim()) {
        this.carry = combined;
        return "";
      }
      const heldLineBreak = this.pendingLineBreak;
      this.pendingLineBreak = "";
      // Punctuation follows, so the detached anchors stranded the line break: it goes, and
      // so do the spaces before the punctuation, as in the same-buffer case.
      combined = STRANDABLE_PUNCTUATION.test(combined)
        ? combined.replace(/^[ \t]+/, "")
        : `${heldLineBreak}${combined}`;
    }

    combined = canonicalizeUnsourcedMarkers(combined, this.inInlineCode);
    const reflowed = removeDetachedAnchorsBeforePunctuation(combined);
    // A trailing `[[` that can still become anchor syntax within the length bound is held
    // as it arrived; everything before it is settled and strips the same whatever follows.
    // Once the candidate can no longer become anchor syntax, a later push settles it and it
    // is released as the literal text it is, `[[` included.
    const { settled, pending } = splitPendingCitationAnchor(reflowed);
    // Otherwise a trailing `[` or `[?` may open an anchor, or a single-bracket `[?]` the next
    // chunk completes.
    const openBracket = pending ? "" : (settled.match(/\[\??$/)?.[0] ?? "");
    const held = pending || openBracket;
    const stripped = stripAnchorSyntax(settled.slice(0, settled.length - openBracket.length), false);

    if (held) {
      // The whitespace before what is held meets whatever follows it if the held text turns
      // out to be anchor syntax and goes (a space before punctuation, a line break before
      // a detached anchor), so it waits too.
      const whitespace = stripped.match(/\s+$/)?.[0] ?? "";
      this.carry = `${whitespace}${held}`;
      return stripped.slice(0, stripped.length - whitespace.length);
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

    // Trailing whitespace, line breaks included, waits for the next chunk: a space may meet
    // punctuation, and a line break may turn out to sit before a detached anchor.
    const trailingWhitespace = stripped.match(/\s+$/)?.[0];
    if (trailingWhitespace) {
      this.carry = trailingWhitespace;
      return stripped.slice(0, -trailingWhitespace.length);
    }

    return stripped;
  }

  /**
   * Ends the stream and returns what was still held: nothing for an anchor the answer ended
   * inside, the literal text of a `[[` that never became one. Trailing whitespace is dropped,
   * as the finished answer drops it.
   */
  flush(): string {
    const held = this.carry;
    this.carry = "";
    this.pendingLineBreak = "";
    this.inInlineCode = false;
    return stripAnchorSyntax(held, true).trimEnd();
  }
}
