import { removeDetachedPunctuationSpacing, STRANDABLE_PUNCTUATION } from "./citationTextNormalization.js";

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

  push(chunk: string): string {
    let combined = `${this.carry}${chunk ?? ""}`;
    this.carry = "";

    if (this.pendingLineBreak) {
      const heldLineBreak = this.pendingLineBreak;
      this.pendingLineBreak = "";
      if (!STRANDABLE_PUNCTUATION.test(combined)) {
        combined = `${heldLineBreak}${combined}`;
      }
    }

    const reflowed = combined.replace(DETACHED_ANCHOR_BEFORE_PUNCTUATION, "");
    const stripped = stripCompleteAnchors(reflowed);

    const suffixMatch = stripped.match(/\[\[[^\]]*$/);
    if (suffixMatch && suffixMatch.index !== undefined) {
      const start = suffixMatch.index;
      this.carry = stripped.slice(start).slice(-32);
      return stripped.slice(0, start);
    }

    if (stripped.endsWith("[")) {
      this.carry = "[";
      return stripped.slice(0, -1);
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
    this.carry = "";
    this.pendingLineBreak = "";
    return "";
  }
}
