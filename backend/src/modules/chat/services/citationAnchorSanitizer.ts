const COMPLETE_ANCHOR = /\[\[\d+\]\]/g;
const ANY_BRACKET_ANCHOR = /\[\[[^\]]*?\]\]/g;

const stripCompleteAnchors = (text: string): string =>
  text
    .replace(COMPLETE_ANCHOR, "")
    .replace(ANY_BRACKET_ANCHOR, ""); // defensive: drop malformed anchors too

// Streaming-safe sanitizer. Keeps a small carry buffer so we don't emit partial anchors like "[[".
export class CitationAnchorSanitizer {
  private carry = "";

  push(chunk: string): string {
    const combined = `${this.carry}${chunk ?? ""}`;
    this.carry = "";

    const stripped = stripCompleteAnchors(combined);

    // Keep a possible start of an anchor in the carry buffer to avoid emitting it mid-stream.
    const suffixMatch = stripped.match(/\[\[[^\]]*$/);
    if (suffixMatch && suffixMatch.index !== undefined) {
      const start = suffixMatch.index;
      this.carry = stripped.slice(start).slice(-32);
      return stripped.slice(0, start);
    }

    // Also avoid emitting a single trailing "[" which could become "[[" across chunk boundaries.
    if (stripped.endsWith("[")) {
      this.carry = "[";
      return stripped.slice(0, -1);
    }

    return stripped;
  }

  flush(): string {
    // Drop any dangling partial anchor syntax rather than emitting it.
    this.carry = "";
    return "";
  }
}

