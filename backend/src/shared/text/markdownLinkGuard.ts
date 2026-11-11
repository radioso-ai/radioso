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
 * text joins to exactly what the whole text guards to: link text stays on one line and
 * within a bound, a code span closes on its own line, and indented code and reference links
 * are read as text. Callers that hold spans which are not Markdown content (citation markers,
 * say) declare them through `ignoredRanges`; they are carried through untouched and never
 * open or close a construct.
 */

export interface MarkdownRange {
  readonly start: number;
  readonly end: number;
}

/** Whether a link stays, or why it becomes its text. */
export type LinkDestinationVerdict<Reason extends string> =
  | { readonly kind: "keep" }
  | { readonly kind: "unwrap"; readonly reason: Reason };

export type LinkDestinationPolicy<Reason extends string> = (destination: string) => LinkDestinationVerdict<Reason>;

export interface GuardedMarkdown<Reason extends string> {
  readonly text: string;
  /** Why each unwrapped link was unwrapped, in text order. */
  readonly unwrapped: readonly Reason[];
}

/** Link text longer than this, or a destination longer than its bound, is read as text. */
const MARKDOWN_LINK_BOUNDS = {
  textMaxLength: 1000,
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
const FENCE_PREFIX = /^ {0,3}(?:`+|~+)?$/;
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

class LinkScanner<Reason extends string> {
  private output = "";
  private readonly unwrapped: Reason[] = [];

  constructor(
    private readonly text: string,
    private readonly ranges: ReadonlyArray<MarkdownRange>,
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

  /** The end of the declared range `index` falls in, or `index` when none. */
  private rangeEnd(index: number): number {
    return this.ranges.find((range) => range.start <= index && index < range.end)?.end ?? index;
  }

  /** At a line start: fence lines are emitted whole; other lines go on to inline scanning. */
  private lineStart(index: number): number | null {
    const lineBreak = this.text.indexOf("\n", index);
    const lineEnd = lineBreak < 0 ? this.text.length : lineBreak;
    const line = this.text.slice(index, lineEnd).replace(/\r$/, "");
    const complete = lineBreak >= 0 || this.final;
    const fence = this.state.fence;
    if (fence) {
      if (!complete) {
        return null;
      }
      const closing = FENCE_CLOSING.exec(line);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        this.state.fence = null;
      }
      return this.endLine(index, lineBreak);
    }
    if (!complete && FENCE_PREFIX.test(line)) {
      return null;
    }
    const opening = FENCE_OPENING.exec(line);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      if (!complete) {
        return null;
      }
      this.state.fence = { marker: opening[1][0], length: opening[1].length };
      return this.endLine(index, lineBreak);
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
    const rangeEnd = this.rangeEnd(index);
    if (rangeEnd > index) {
      return this.emit(index, rangeEnd);
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
    const special = SPECIAL.exec(this.text)?.index ?? this.text.length;
    const nextRange = this.ranges.find((range) => range.start > index)?.start ?? this.text.length;
    return this.emit(index, Math.min(special, nextRange));
  }

  /**
   * Where the code span opening at `index` ends, or the end of its backtick run when no run
   * of the same length closes it on its line; `null` while that is still open.
   */
  private codeSpanEnd(index: number): number | null {
    let runEnd = index;
    while (this.text[runEnd] === "`") {
      runEnd += 1;
    }
    if (runEnd === this.text.length && !this.final) {
      return null;
    }
    const length = runEnd - index;
    let cursor = runEnd;
    while (cursor < this.text.length && this.text[cursor] !== "\n") {
      if (this.text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let closeEnd = cursor;
      while (this.text[closeEnd] === "`") {
        closeEnd += 1;
      }
      if (closeEnd === this.text.length && !this.final) {
        return null;
      }
      if (closeEnd - cursor === length) {
        return closeEnd;
      }
      cursor = closeEnd;
    }
    return cursor === this.text.length && !this.final ? null : runEnd;
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
    const label = this.guardSpan(open + 1, match.textEnd);
    const { destination, carried } = this.destinationOf(match.destinationStart, match.end - 1);
    const verdict = this.policy(readDestination(destination));
    if (verdict.kind === "keep") {
      this.output += `${image ? "!" : ""}[${label}]${this.text.slice(match.textEnd + 1, match.end)}`;
    } else {
      this.unwrapped.push(verdict.reason);
      this.output += `${label}${carried}`;
    }
    return match.end;
  }

  /** The link text, guarded on its own: it may hold an image or another link. */
  private guardSpan(start: number, end: number): string {
    const ranges = this.ranges
      .filter((range) => range.start >= start && range.end <= end)
      .map((range) => ({ start: range.start - start, end: range.end - start }));
    const inner = new LinkScanner(this.text.slice(start, end), ranges, this.policy, true, {
      fence: null,
      atLineStart: false,
    }).run();
    this.unwrapped.push(...inner.unwrapped);
    return inner.output;
  }

  /** The destination with declared ranges taken out, and those ranges' text to carry on. */
  private destinationOf(start: number, end: number): { destination: string; carried: string } {
    let destination = "";
    let carried = "";
    let cursor = start;
    for (const range of this.ranges.filter((candidate) => candidate.start >= start && candidate.end <= end)) {
      destination += this.text.slice(cursor, range.start);
      carried += this.text.slice(range.start, range.end);
      cursor = range.end;
    }
    return { destination: destination + this.text.slice(cursor, end), carried };
  }

  /** Reads `[text](destination)` from the `[` at `open`. */
  private matchLink(open: number): LinkMatch {
    let depth = 0;
    let cursor = open;
    let textEnd = -1;
    while (cursor < this.text.length) {
      if (cursor - open > MARKDOWN_LINK_BOUNDS.textMaxLength) {
        return { kind: "text" };
      }
      const rangeEnd = this.rangeEnd(cursor);
      if (rangeEnd > cursor) {
        cursor = rangeEnd;
        continue;
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
      const rangeEnd = this.rangeEnd(cursor);
      if (rangeEnd > cursor) {
        cursor = rangeEnd - 1;
        continue;
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

const scan = <Reason extends string>(
  text: string,
  policy: LinkDestinationPolicy<Reason>,
  state: ScanState,
  { final, ignoredRanges = [] }: { final: boolean; ignoredRanges?: ReadonlyArray<MarkdownRange> },
) => {
  const ranges = [...ignoredRanges]
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  return new LinkScanner(text, ranges, policy, final, state).run();
};

export const guardMarkdownLinks = <Reason extends string>(
  markdown: string,
  policy: LinkDestinationPolicy<Reason>,
  options: { ignoredRanges?: ReadonlyArray<MarkdownRange> } = {},
): GuardedMarkdown<Reason> => {
  const { output, unwrapped } = scan(markdown, policy, { fence: null, atLineStart: true }, { final: true, ...options });
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
  private readonly state: ScanState = { fence: null, atLineStart: true };
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
    const { output, consumed, unwrapped } = scan(text, this.policy, this.state, { final });
    this.held = text.slice(consumed);
    this.reasons.push(...unwrapped);
    return output;
  }
}
