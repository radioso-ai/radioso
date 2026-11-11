/**
 * Turns Markdown links whose destination a caller rejects into their plain text.
 *
 * It knows inline Markdown link syntax, `[text](destination)` and `![alt](source)`, and the
 * constructs that make brackets literal (code spans, fenced code, backslash escapes), and
 * nothing about what makes a destination acceptable: the caller's policy decides each one.
 * A link the policy keeps stays byte for byte; one it rejects becomes its text, which is
 * guarded the same way.
 *
 * A destination is read the way a reader sees it: between the parentheses, without an
 * optional title or angle brackets. One that is not a single address, such as a page title
 * with spaces, still goes to the policy as written, because a renderer shows that span as
 * raw brackets and the policy can reject it.
 *
 * The grammar is narrower than CommonMark, and the same in both entry points, so a streamed
 * text joins to exactly what the whole text guards to: link text, a code span, and a fence
 * line each stay on one line and within {@link MARKDOWN_LINK_BOUNDS}, and indented code and
 * reference links are read as text. The bounds also cap how much a stream holds back.
 */

/** Whether a link stays, or why it becomes its text. */
export type LinkDestinationVerdict<Reason extends string> =
  | { readonly kind: "keep" }
  | { readonly kind: "unwrap"; readonly reason: Reason };

export type LinkDestinationPolicy<Reason extends string> = (destination: string) => LinkDestinationVerdict<Reason>;

interface GuardedMarkdown<Reason extends string> {
  readonly text: string;
  /** Why each unwrapped link was unwrapped, in text order. */
  readonly unwrapped: readonly Reason[];
}

/**
 * Link text, a code span, or a fence line that runs past `spanMaxLength`, or a destination
 * that runs past `destinationMaxLength`, is read as plain text.
 */
const MARKDOWN_LINK_BOUNDS = {
  spanMaxLength: 1000,
  destinationMaxLength: 4096,
} as const;

interface Fence {
  readonly marker: string;
  readonly length: number;
}

interface ScanState {
  fence: Fence | null;
  atLineStart: boolean;
}

type LinkMatch =
  | { readonly kind: "pending" }
  | { readonly kind: "text" }
  | {
    readonly kind: "link";
    readonly textEnd: number;
    readonly destinationStart: number;
    readonly end: number;
  };

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// A line start that more characters could still turn into a fence opening.
const FENCE_OPENING_PREFIX = /^ {0,3}(?:`+|~+)?$/;
// A line start that more characters could still turn into a fence closing.
const FENCE_CLOSING_PREFIX = /^ {0,3}(?:(?:`+|~+)[ \t]*)?$/;
const SPECIAL = /[\n\\`![]/g;
const TITLE = /^(?:"[^"]*"|'[^']*'|\([^()]*\))$/;
const WHITESPACE_RUN = /\s+/;

/** What a reader sees as the destination inside `(…)`: no title, no angle brackets. */
const readDestination = (raw: string): string => {
  const inner = raw.trim();
  if (inner.startsWith("<")) {
    const close = inner.indexOf(">");
    if (close > 0 && (close === inner.length - 1 || TITLE.test(inner.slice(close + 1).trim()))) {
      return inner.slice(1, close);
    }
  }
  const [first, ...rest] = inner.split(WHITESPACE_RUN);
  return rest.length > 0 && TITLE.test(inner.slice(first.length).trim()) ? first : inner;
};

/**
 * The fence a line opens. A tilde fence opens on its run alone; a backtick fence needs its
 * whole line within the bound, with no backtick in its info string.
 */
const fenceOpening = (line: string): Fence | null => {
  const opening = FENCE_OPENING.exec(line);
  if (!opening) {
    return null;
  }
  const marker = opening[1][0];
  const backtickLineRejected = marker === "`"
    && (opening[2].includes("`") || line.length > MARKDOWN_LINK_BOUNDS.spanMaxLength);
  return backtickLineRejected ? null : { marker, length: opening[1].length };
};

const closesFence = (line: string, fence: Fence): boolean => {
  const closing = FENCE_CLOSING.exec(line);
  return closing !== null
    && line.length <= MARKDOWN_LINK_BOUNDS.spanMaxLength
    && closing[1][0] === fence.marker
    && closing[1].length >= fence.length;
};

class LinkScanner<Reason extends string> {
  private output = "";
  private readonly unwrapped: Reason[] = [];

  constructor(
    private readonly text: string,
    private readonly policy: LinkDestinationPolicy<Reason>,
    private readonly final: boolean,
    private readonly state: ScanState,
  ) {}

  /** Guards as much of the text as is settled; `consumed` is where held text begins. */
  run(): { output: string; consumed: number; unwrapped: Reason[] } {
    let index = 0;
    while (index < this.text.length) {
      const next = this.state.atLineStart ? this.lineStart(index) : this.inline(index);
      if (next === null) {
        break;
      }
      index = next;
    }
    return { output: this.output, consumed: index, unwrapped: this.unwrapped };
  }

  private emit(from: number, to: number): number {
    this.output += this.text.slice(from, to);
    return to;
  }

  /**
   * At a line start, decides whether the line opens or closes a fence. A line that does is
   * emitted whole; any other line goes on to inline scanning, or to fenced content inside a
   * fence. `null` while the line so far could still go either way.
   */
  private lineStart(index: number): number | null {
    const lineBreak = this.text.indexOf("\n", index);
    const lineEnd = lineBreak < 0 ? this.text.length : lineBreak;
    const line = this.text.slice(index, lineEnd).replace(/\r$/, "");
    const complete = lineBreak >= 0 || this.final;
    const withinBound = line.length <= MARKDOWN_LINK_BOUNDS.spanMaxLength;
    const fence = this.state.fence;
    if (fence) {
      if (!complete && withinBound && FENCE_CLOSING_PREFIX.test(line)) {
        return null;
      }
      if (complete && closesFence(line, fence)) {
        this.state.fence = null;
        return this.endLine(index, lineBreak);
      }
      this.state.atLineStart = false;
      return index;
    }
    if (!complete && withinBound && FENCE_OPENING_PREFIX.test(line)) {
      return null;
    }
    const opening = FENCE_OPENING.exec(line);
    // A backtick fence needs its whole line: a backtick later in it means no fence at all.
    if (opening && !complete && withinBound && opening[1][0] === "`" && !opening[2].includes("`")) {
      return null;
    }
    const opened = opening && (complete || opening[1][0] === "~") ? fenceOpening(line) : null;
    if (opened) {
      this.state.fence = opened;
    }
    this.state.atLineStart = false;
    return index;
  }

  private endLine(index: number, lineBreak: number): number {
    if (lineBreak < 0) {
      return this.emit(index, this.text.length);
    }
    this.state.atLineStart = true;
    return this.emit(index, lineBreak + 1);
  }

  private inline(index: number): number | null {
    if (this.state.fence) {
      return this.endLine(index, this.text.indexOf("\n", index));
    }
    const char = this.text[index];
    if (char === "\n") {
      this.state.atLineStart = true;
      return this.emit(index, index + 1);
    }
    if (char === "\\") {
      const escaped = this.text[index + 1];
      if (escaped === undefined && !this.final) {
        return null;
      }
      return this.emit(index, escaped === undefined || escaped === "\n" ? index + 1 : index + 2);
    }
    if (char === "`") {
      const close = this.codeSpanEnd(index);
      return close === null ? null : this.emit(index, close);
    }
    if (char === "!" || char === "[") {
      return this.link(index);
    }
    SPECIAL.lastIndex = index;
    return this.emit(index, SPECIAL.exec(this.text)?.index ?? this.text.length);
  }

  /**
   * Where the code span opening at `index` ends, or the end of its backtick run when no run of
   * the same length closes it on its line within the bound; `null` while that is still open.
   */
  private codeSpanEnd(index: number): number | null {
    const runEnd = this.backtickRunEnd(index);
    if (runEnd === null) {
      return null;
    }
    const length = runEnd - index;
    let cursor = runEnd;
    while (cursor < this.text.length && this.text[cursor] !== "\n") {
      if (cursor - runEnd > MARKDOWN_LINK_BOUNDS.spanMaxLength) {
        return runEnd;
      }
      if (this.text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      const closeEnd = this.backtickRunEnd(cursor);
      if (closeEnd === null) {
        return null;
      }
      if (closeEnd - cursor === length) {
        return closeEnd;
      }
      cursor = closeEnd;
    }
    return cursor === this.text.length && !this.final ? null : runEnd;
  }

  /** The end of the backtick run at `index`; `null` while more text could lengthen it. */
  private backtickRunEnd(index: number): number | null {
    let runEnd = index;
    while (this.text[runEnd] === "`") {
      runEnd += 1;
    }
    return runEnd === this.text.length && !this.final ? null : runEnd;
  }

  private link(index: number): number | null {
    const image = this.text[index] === "!";
    if (image && this.text[index + 1] === undefined && !this.final) {
      return null;
    }
    if (image && this.text[index + 1] !== "[") {
      return this.emit(index, index + 1);
    }
    const open = image ? index + 1 : index;
    const match = this.matchLink(open);
    if (match.kind === "pending") {
      return null;
    }
    if (match.kind === "text") {
      return this.emit(index, open + 1);
    }
    const label = this.guardLabel(open + 1, match.textEnd);
    const verdict = this.policy(readDestination(this.text.slice(match.destinationStart, match.end - 1)));
    if (verdict.kind === "keep") {
      this.output += `${image ? "!" : ""}[${label}]${this.text.slice(match.textEnd + 1, match.end)}`;
    } else {
      this.unwrapped.push(verdict.reason);
      this.output += label;
    }
    return match.end;
  }

  /** The link text, guarded on its own: it may hold an image or another link. */
  private guardLabel(start: number, end: number): string {
    const inner = new LinkScanner(this.text.slice(start, end), this.policy, true, {
      fence: null,
      atLineStart: false,
    }).run();
    this.unwrapped.push(...inner.unwrapped);
    return inner.output;
  }

  /** Reads `[text](destination)` from the `[` at `open`. */
  private matchLink(open: number): LinkMatch {
    let depth = 0;
    let cursor = open;
    let textEnd = -1;
    while (cursor < this.text.length) {
      if (cursor - open > MARKDOWN_LINK_BOUNDS.spanMaxLength) {
        return { kind: "text" };
      }
      const char = this.text[cursor];
      if (char === "\n") {
        return { kind: "text" };
      }
      if (char === "\\") {
        cursor += this.text[cursor + 1] === "\n" ? 1 : 2;
        continue;
      }
      if (char === "`") {
        const close = this.codeSpanEnd(cursor);
        if (close === null) {
          return { kind: "pending" };
        }
        cursor = close;
        continue;
      }
      if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          textEnd = cursor;
          break;
        }
      }
      cursor += 1;
    }
    if (textEnd < 0 || textEnd + 1 >= this.text.length) {
      return this.final ? { kind: "text" } : { kind: "pending" };
    }
    if (this.text[textEnd + 1] !== "(") {
      return { kind: "text" };
    }
    return this.matchDestination(textEnd);
  }

  private matchDestination(textEnd: number): LinkMatch {
    const destinationStart = textEnd + 2;
    let depth = 1;
    for (let cursor = destinationStart; cursor < this.text.length; cursor += 1) {
      if (cursor - destinationStart > MARKDOWN_LINK_BOUNDS.destinationMaxLength) {
        return { kind: "text" };
      }
      const char = this.text[cursor];
      if (char === "\n") {
        return { kind: "text" };
      }
      if (char === "\\") {
        cursor += 1;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          return { kind: "link", textEnd, destinationStart, end: cursor + 1 };
        }
      }
    }
    return this.final ? { kind: "text" } : { kind: "pending" };
  }
}

const freshState = (): ScanState => ({ fence: null, atLineStart: true });

export const guardMarkdownLinks = <Reason extends string>(
  markdown: string,
  policy: LinkDestinationPolicy<Reason>,
): GuardedMarkdown<Reason> => {
  const { output, unwrapped } = new LinkScanner(markdown, policy, true, freshState()).run();
  return { text: output, unwrapped };
};

/**
 * {@link guardMarkdownLinks} over text that arrives in chunks. A chunk's text is released as
 * soon as nothing after it can change how it reads; a link is held from its `[` until its
 * destination has been checked, so a rejected link is never released, not even in part.
 * Joined, the released text and `flush()` equal the whole text guarded at once. Callers must
 * emit `flush()` when the stream ends: a held `[` that never became a link comes back from it.
 */
export class MarkdownLinkGuardStream<Reason extends string> {
  private held = "";
  private readonly state = freshState();
  private readonly reasons: Reason[] = [];

  constructor(private readonly policy: LinkDestinationPolicy<Reason>) {}

  get unwrapped(): readonly Reason[] {
    return this.reasons;
  }

  push(chunk: string): string {
    return this.release(`${this.held}${chunk}`, false);
  }

  flush(): string {
    return this.release(this.held, true);
  }

  private release(text: string, final: boolean): string {
    const { output, consumed, unwrapped } = new LinkScanner(text, this.policy, final, this.state).run();
    this.held = text.slice(consumed);
    this.reasons.push(...unwrapped);
    return output;
  }
}
