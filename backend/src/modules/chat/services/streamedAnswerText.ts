import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";

/** Streamed text that may hold some back: what `push` holds comes out of a later `push` or `flush`. */
interface HeldTextStream {
  push(text: string): string;
  flush(): string;
}

/**
 * Holds streamed answer text until it carries more than whitespace. A decline committed
 * with a blank answer is replaced by a composed one once the stream ends, so whitespace
 * alone must neither reach the client ahead of that decline nor mark the turn as
 * already answering. Held whitespace is released with the first text that follows it.
 */
class LeadingWhitespaceHold {
  private held = "";
  private releasing = false;

  push(text: string): string {
    if (this.releasing) {
      return text;
    }
    this.held += text;
    if (!this.held.trim()) {
      return "";
    }
    this.releasing = true;
    const released = this.held;
    this.held = "";
    return released;
  }
}

/**
 * The visible text of a streamed grounded answer, from the decoded `answer` field on: its
 * citation markers removed, each link held until its address is checked, and leading
 * whitespace held until text follows it. Joined with `flush()`, what it releases is the
 * finished answer as its presentation shows it. Callers must emit `flush()` when the
 * stream ends: held text comes back from it.
 */
export class StreamedAnswerText {
  private readonly citations = new CitationAnchorSanitizer();
  private readonly leadingWhitespace = new LeadingWhitespaceHold();

  constructor(private readonly links: HeldTextStream) {}

  push(text: string): string {
    return this.leadingWhitespace.push(this.links.push(this.citations.push(text)));
  }

  flush(): string {
    const citationTail = this.links.push(this.citations.flush());
    return this.leadingWhitespace.push(citationTail + this.links.flush());
  }
}
