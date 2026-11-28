/**
 * Removes the clickable addresses a caller rejects from Markdown: unwraps links, drops bare addresses.
 *
 * It knows the ways a renderer makes an address clickable: inline links, `[text](destination)`
 * and `![alt](source)`; link reference definitions, `[ref]: destination`; angle-bracket
 * autolinks, `<https://…>`; and bare addresses GFM links on its own, `https://…` and `www.…`.
 * It knows the constructs that make brackets literal (code spans, fenced code, backslash
 * escapes), and nothing about what makes a destination acceptable: the caller's policy decides
 * each one. A link the policy keeps stays byte for byte; an inline link it rejects becomes its
 * text, which is guarded the same way. A rejected bare address, autolink, or reference
 * definition is removed: its address is the whole of what it shows, and an address nobody gave
 * is misinformation as plain text too. The uses of a removed definition, `[name][ref]`, stay
 * literal text, which no renderer links.
 *
 * A destination is read the way a reader sees it: between the parentheses, without an
 * optional title or angle brackets, backslash escapes and character references decoded. One
 * that is not a single address, such as a page title with spaces, still goes to the policy as
 * written, because a renderer shows that span as raw brackets and the policy can reject it.
 *
 * The grammar is narrower than CommonMark, and the same in both entry points, so a streamed
 * text joins to exactly what the whole text guards to: link text and a destination may
 * continue over a soft line break but not a blank line, a code span and a fence line stay on
 * one line, and each stays within {@link MARKDOWN_LINK_BOUNDS}; indented code is read as text.
 * The bounds also cap how much a stream holds back. Link text that runs past its bound is
 * released as text, and the destination that later closes it, `](destination)`, is checked on
 * its own, so a long label never carries an unchecked address. A construct a stream is still
 * reading resumes where the last chunk ended, so reading a stream is linear in its length.
 */

import { asciiAddressEnd, bareAddressEnd, readDefinitionDestination, readDestination } from "./markdownDestination.js";

/** Whether an address stays, or why it is removed. */
export type LinkDestinationVerdict<Reason extends string> =
  | { readonly kind: "keep" }
  | { readonly kind: "unwrap"; readonly reason: Reason };

export type LinkDestinationPolicy<Reason extends string> = (destination: string) => LinkDestinationVerdict<Reason>;

interface GuardedMarkdown<Reason extends string> {
  readonly text: string;
  /** Why each address was removed, in text order. */
  readonly unwrapped: readonly Reason[];
}

/**
 * Link text, a code span, or a fence line that runs past `spanMaxLength`, or a destination
 * or bare address that runs past `destinationMaxLength`, is read as plain text.
 */
const MARKDOWN_LINK_BOUNDS = {
  spanMaxLength: 1000,
  destinationMaxLength: 4096,
} as const;

interface Fence {
  readonly marker: string;
  readonly length: number;
}

/** Where a construct that needs more text stopped reading, relative to where the construct starts. */
interface ConstructProgress {
  readonly kind: "label" | "destination" | "definition" | "address";
  readonly cursor: number;
  readonly depth: number;
  readonly textEnd: number;
}

interface CodeSpanProgress {
  readonly offset: number;
  readonly runEnd: number;
  readonly cursor: number;
}

interface ScanState {
  fence: Fence | null;
  atLineStart: boolean;
  /** Only indentation precedes the held text on its line. */
  lineLead: boolean;
  /** The source character before the held text. */
  previous: string;
  /** Link text abandoned at its bound whose closing `](destination)` has not been read. */
  abandoned: number;
  resume: ConstructProgress | null;
  span: CodeSpanProgress | null;
  /** Characters read while looking for the end of a construct, counting each read. */
  scanned: number;
}

interface MatchedSpan {
  readonly textEnd: number;
  readonly destinationStart: number;
  readonly end: number;
}

type LinkMatch =
  | { readonly kind: "pending" }
  | { readonly kind: "text" }
  | ({ readonly kind: "link" } & MatchedSpan)
  | ({ readonly kind: "definition" } & MatchedSpan);

type ParagraphBreak = "continues" | "blank" | "pending";

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// A line start that more characters could still turn into a fence opening.
const FENCE_OPENING_PREFIX = /^ {0,3}(?:`+|~+)?$/;
// A line start that more characters could still turn into a fence closing.
const FENCE_CLOSING_PREFIX = /^ {0,3}(?:(?:`+|~+)[ \t]*)?$/;
const NEXT_CONSTRUCT = /[\n\\`![<\]]/g;
const BARE_ADDRESS_START = /^(?:https?:\/\/|www\.)/i;
// What more characters could still turn into a bare address start.
const BARE_ADDRESS_PREFIX = /^(?:h(?:t(?:t(?:p(?:s)?(?::\/?)?)?)?)?|w(?:w(?:w)?)?)$/i;
const BARE_ADDRESS_PREFIX_MAX = 8;
const ASCII_LETTER = /[A-Za-z]/;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
// What a GFM email address is made of, local part and host alike.
const EMAIL_CHAR = /[A-Za-z0-9._+-]/;
// GFM caps no part of an email address; these only bound how much text a stream holds back.
const EMAIL_LOCAL_MAX = 1000;
const EMAIL_DOMAIN_MAX = 1000;
const WHITESPACE = /\s/;
const AUTOLINK_URI = /^[a-z][a-z0-9+.-]{1,31}:\S*$/i;
const AUTOLINK_EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;
const INDENTATION = /^ {0,3}$/;

const isBlank = (char: string): boolean => char === " " || char === "\t" || char === "\r";

const startsAddressWord = (char: string): boolean => char === "h" || char === "H" || char === "w" || char === "W";

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
  /** Where the construct being read starts; a construct held from an earlier chunk starts at 0. */
  private stepStart = 0;

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
      this.stepStart = index;
      const next = this.state.atLineStart ? this.lineStart(index) : this.inline(index);
      if (next === null) {
        break;
      }
      this.state.resume = null;
      this.state.span = null;
      index = next;
    }
    this.state.lineLead = this.leadAt(index);
    this.state.previous = index > 0 ? this.text[index - 1] : this.state.previous;
    return { output: this.output, consumed: index, unwrapped: this.unwrapped };
  }

  private emit(from: number, to: number): number {
    this.output += this.text.slice(from, to);
    return to;
  }

  /** The progress of the construct a previous chunk held, when this step is that construct. */
  private resumed(kind: ConstructProgress["kind"]): ConstructProgress | null {
    const progress = this.stepStart === 0 ? this.state.resume : null;
    return progress?.kind === kind ? progress : null;
  }

  /** Holds the construct that started at this step; it resumes at `cursor` with the next chunk. */
  private hold(kind: ConstructProgress["kind"], cursor: number, depth = 0, textEnd = -1): null {
    this.state.resume = {
      kind,
      cursor: cursor - this.stepStart,
      depth,
      textEnd: textEnd < 0 ? textEnd : textEnd - this.stepStart,
    };
    return null;
  }

  private holdMatch(kind: ConstructProgress["kind"], cursor: number, depth = 0, textEnd = -1): LinkMatch {
    this.hold(kind, cursor, depth, textEnd);
    return { kind: "pending" };
  }

  private read(from: number, to: number): void {
    this.state.scanned += Math.max(0, to - from);
  }

  /** Whether only indentation precedes `index` on its line. */
  private leadAt(index: number): boolean {
    const lineBreak = index > 0 ? this.text.lastIndexOf("\n", index - 1) : -1;
    const before = this.text.slice(lineBreak + 1, index);
    return (lineBreak >= 0 || this.state.lineLead) && INDENTATION.test(before);
  }

  private previousChar(index: number): string {
    return index > 0 ? this.text[index - 1] : this.state.previous;
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
    // A blank line ends the paragraph, and with it any link text abandoned at its bound.
    if (complete && line.trim() === "") {
      this.state.abandoned = 0;
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
    switch (this.text[index]) {
      case "\n":
        this.state.atLineStart = true;
        return this.emit(index, index + 1);
      case "\\": {
        const escaped = this.text[index + 1];
        if (escaped === undefined && !this.final) {
          return null;
        }
        // A backslash only escapes ASCII punctuation; before anything else it is a literal character.
        return this.emit(index, escaped !== undefined && ASCII_PUNCTUATION.test(escaped) ? index + 2 : index + 1);
      }
      case "`": {
        const close = this.codeSpanEnd(index);
        return close === null ? null : this.emit(index, close);
      }
      case "!":
      case "[":
        return this.link(index);
      case "<":
        return this.autolink(index);
      case "]":
        return this.closingBracket(index);
      default:
        return this.plain(index);
    }
  }

  /** Ordinary text up to the next construct, a bare address or email among them. */
  private plain(index: number): number | null {
    const address = this.bareAddress(index);
    if (address !== undefined) {
      return address;
    }
    const email = this.emailAddress(index);
    if (email !== undefined) {
      return email;
    }
    NEXT_CONSTRUCT.lastIndex = index + 1;
    const special = NEXT_CONSTRUCT.exec(this.text)?.index ?? this.text.length;
    return this.emit(index, this.nextAddressStart(index, special));
  }

  /**
   * The end of the ordinary text that starts at `index`: the next place an address starts,
   * else `limit`. At the end of a chunk, text that more characters could turn into an address
   * start (the start of `https://`, the word an `@` may follow) is left for the next one.
   */
  private nextAddressStart(index: number, limit: number): number {
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      const char = this.text[cursor];
      if (startsAddressWord(char) && this.startsAddress(cursor)) {
        return cursor;
      }
      if (char === "@") {
        const word = this.wordStart(cursor, index);
        if (word > index && this.text[word - 1] !== "/") {
          return word;
        }
      }
    }
    if (!this.final && limit === this.text.length) {
      const word = this.wordStart(limit, index);
      let stop = limit - word <= EMAIL_LOCAL_MAX ? word : limit;
      for (let cursor = Math.max(index + 1, limit - BARE_ADDRESS_PREFIX_MAX); cursor < limit; cursor += 1) {
        if (startsAddressWord(this.text[cursor]) && (this.partialAddressStart(cursor) || this.startsAddress(cursor))) {
          stop = Math.min(stop, cursor);
          break;
        }
      }
      return stop > index ? stop : limit;
    }
    return limit;
  }

  /** Where the run of characters an email's local part may hold, ending at `end`, starts; never before `floor`. */
  private wordStart(end: number, floor: number): number {
    let start = end;
    while (start > floor && end - start <= EMAIL_LOCAL_MAX && EMAIL_CHAR.test(this.text[start - 1])) {
      start -= 1;
    }
    return start;
  }

  /** Whether `https://` or `www.` starts at `index` where a renderer links it on its own. */
  private startsAddress(index: number): boolean {
    return BARE_ADDRESS_START.test(this.text.slice(index, index + BARE_ADDRESS_PREFIX_MAX))
      && this.addressMayStartAfter(this.text[index], this.previousChar(index));
  }

  private partialAddressStart(index: number): boolean {
    return BARE_ADDRESS_PREFIX.test(this.text.slice(index))
      && this.addressMayStartAfter(this.text[index], this.previousChar(index));
  }

  /**
   * GFM's autolink literal start: `http(s)://` follows anything but an ASCII letter; `www.`
   * follows the start of text, whitespace, or one of `(*_[]~`.
   */
  private addressMayStartAfter(first: string, previous: string): boolean {
    if (first === "h" || first === "H") {
      return !ASCII_LETTER.test(previous);
    }
    return previous === "" || WHITESPACE.test(previous) || "(*_[]~".includes(previous);
  }

  /**
   * Reads a bare address, `https://…` or `www.…`, that starts at `index`: `undefined` when none
   * does, `null` while the text that ends it has not arrived. One the policy rejects is removed.
   */
  private bareAddress(index: number): number | null | undefined {
    if (!startsAddressWord(this.text[index])) {
      return undefined;
    }
    if (!this.final && this.text.length - index <= BARE_ADDRESS_PREFIX_MAX && this.partialAddressStart(index)) {
      return null;
    }
    if (!this.startsAddress(index)) {
      return undefined;
    }
    const resumed = this.resumed("address");
    let cursor = resumed ? resumed.cursor : index;
    const readFrom = cursor;
    const limit = index + MARKDOWN_LINK_BOUNDS.destinationMaxLength;
    while (cursor < this.text.length && cursor < limit && !WHITESPACE.test(this.text[cursor]) && this.text[cursor] !== "<") {
      cursor += 1;
    }
    this.read(readFrom, cursor);
    if (cursor === this.text.length && cursor < limit && !this.final) {
      return this.hold("address", cursor);
    }
    const end = bareAddressEnd(this.text, index, cursor);
    const prefix = BARE_ADDRESS_START.exec(this.text.slice(index, end))?.[0] ?? "";
    if (end - index <= prefix.length) {
      return this.emit(index, index + prefix.length);
    }
    // Prose in another script may follow the address without a space: if the whole run is
    // rejected, the address up to its first non-ASCII character may still be a given one.
    const asciiEnd = asciiAddressEnd(this.text, index, end);
    const ends = asciiEnd !== null && asciiEnd - index > prefix.length ? [end, asciiEnd] : [end];
    return this.checked(index, ends, (stop) => {
      const address = this.text.slice(index, stop);
      return address.toLowerCase().startsWith("www.") ? `http://${address}` : address;
    });
  }

  /**
   * An email address a renderer links on its own, `name@host.tld`: `undefined` when none starts
   * at `index`, `null` while the text that ends it has not arrived. Read as `mailto:`.
   */
  private emailAddress(index: number): number | null | undefined {
    if (!EMAIL_CHAR.test(this.text[index])) {
      return undefined;
    }
    // An address starts where GFM starts it: not inside a longer word, and not after a `/`.
    const before = this.previousChar(index);
    if (before === "/" || EMAIL_CHAR.test(before)) {
      return undefined;
    }
    let local = index;
    while (local < this.text.length && local - index <= EMAIL_LOCAL_MAX && EMAIL_CHAR.test(this.text[local])) {
      local += 1;
    }
    this.read(index, local);
    if (local === this.text.length && !this.final && local - index <= EMAIL_LOCAL_MAX) {
      return null;
    }
    if (this.text[local] !== "@" || local - index > EMAIL_LOCAL_MAX) {
      return undefined;
    }
    let domain = local + 1;
    while (domain < this.text.length && domain - local <= EMAIL_DOMAIN_MAX && EMAIL_CHAR.test(this.text[domain])) {
      domain += 1;
    }
    this.read(local, domain);
    if (domain === this.text.length && !this.final) {
      return null;
    }
    let end = domain;
    while (end > local + 1 && this.text[end - 1] === ".") {
      end -= 1;
    }
    const host = this.text.slice(local + 1, end);
    const labels = host.split(".");
    // A version such as `19.0.0` is not a host: GFM links no address whose last label is only digits.
    if (labels.length < 2 || labels.some((label) => label === "") || /[-_]$/.test(host) || /^\d+$/.test(labels[labels.length - 1])) {
      return undefined;
    }
    return this.checked(index, [end], () => `mailto:${this.text.slice(index, end)}`);
  }

  /**
   * Keeps the address that starts at `start` and ends at the first of `ends` the policy keeps,
   * or removes it, up to the last of `ends`, with the space that set it apart: the prose glued
   * to an address that is only the address's tail is left in place.
   */
  private checked(start: number, ends: readonly number[], destination: (end: number) => string): number | null {
    let rejection: Extract<LinkDestinationVerdict<Reason>, { kind: "unwrap" }> | null = null;
    for (const end of ends) {
      const verdict = this.policy(destination(end));
      if (verdict.kind === "keep") {
        return this.emit(start, end);
      }
      rejection ??= verdict;
    }
    const end = ends[ends.length - 1];
    const before = this.previousChar(start);
    const setApart = before === "" || WHITESPACE.test(before);
    // Whether a space follows is not known until the next chunk arrives.
    if (setApart && end === this.text.length && !this.final) {
      return null;
    }
    if (rejection) {
      this.unwrapped.push(rejection.reason);
    }
    return setApart && this.text[end] === " " ? end + 1 : end;
  }

  /** `<https://…>` and `<name@host>`: removed when the policy rejects the address inside. */
  private autolink(index: number): number | null {
    const resumed = this.resumed("address");
    let cursor = resumed ? resumed.cursor : index + 1;
    const readFrom = cursor;
    const limit = index + MARKDOWN_LINK_BOUNDS.destinationMaxLength;
    while (cursor < this.text.length && cursor < limit) {
      const char = this.text[cursor];
      if (char === ">" || char === "<" || WHITESPACE.test(char)) {
        break;
      }
      cursor += 1;
    }
    this.read(readFrom, cursor);
    if (cursor >= this.text.length && cursor < limit) {
      return this.final ? this.emit(index, index + 1) : this.hold("address", cursor);
    }
    if (this.text[cursor] !== ">") {
      return this.emit(index, index + 1);
    }
    const inner = this.text.slice(index + 1, cursor);
    if (AUTOLINK_URI.test(inner)) {
      return this.checked(index, [cursor + 1], () => inner);
    }
    return AUTOLINK_EMAIL.test(inner) ? this.checked(index, [cursor + 1], () => `mailto:${inner}`) : this.emit(index, index + 1);
  }

  /**
   * A `]` read as text. After link text was abandoned at its bound, the `](destination)` that
   * closes it is read and checked: a rejected destination is dropped and the text stays.
   */
  private closingBracket(index: number): number | null {
    if (this.state.abandoned === 0) {
      return this.emit(index, index + 1);
    }
    if (this.text[index + 1] === undefined && !this.final) {
      return null;
    }
    if (this.text[index + 1] !== "(") {
      return this.emit(index, index + 1);
    }
    const match = this.matchDestination(index);
    if (match.kind === "pending") {
      return null;
    }
    if (match.kind !== "link") {
      return this.emit(index, index + 1);
    }
    this.state.abandoned -= 1;
    const verdict = this.policy(readDestination(this.text.slice(match.destinationStart, match.end - 1)));
    if (verdict.kind === "keep") {
      return this.emit(index, match.end);
    }
    this.unwrapped.push(verdict.reason);
    this.output += "]";
    return match.end;
  }

  /**
   * Where the code span opening at `index` ends, or the end of its backtick run when no run of
   * the same length closes it on its line within the bound; `null` while that is still open.
   */
  private codeSpanEnd(index: number): number | null {
    const progress = this.stepStart === 0 && this.state.span?.offset === index ? this.state.span : null;
    const runEnd = progress ? progress.runEnd : this.backtickRunEnd(index);
    if (runEnd === null) {
      return null;
    }
    const length = runEnd - index;
    let cursor = progress ? progress.cursor : runEnd;
    const readFrom = cursor;
    const settle = (end: number): number => {
      this.read(readFrom, cursor);
      this.state.span = null;
      return end;
    };
    while (cursor < this.text.length && this.text[cursor] !== "\n") {
      if (cursor - runEnd > MARKDOWN_LINK_BOUNDS.spanMaxLength) {
        return settle(runEnd);
      }
      if (this.text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      const closeEnd = this.backtickRunEnd(cursor);
      if (closeEnd === null) {
        return this.holdSpan(index, runEnd, cursor, readFrom);
      }
      if (closeEnd - cursor === length) {
        return settle(closeEnd);
      }
      cursor = closeEnd;
    }
    return cursor === this.text.length && !this.final ? this.holdSpan(index, runEnd, cursor, readFrom) : settle(runEnd);
  }

  private holdSpan(index: number, runEnd: number, cursor: number, readFrom: number): null {
    this.read(readFrom, cursor);
    this.state.span = {
      offset: index - this.stepStart,
      runEnd: runEnd - this.stepStart,
      cursor: cursor - this.stepStart,
    };
    return null;
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
    const match = this.matchLink(open, image);
    if (match.kind === "pending") {
      return null;
    }
    if (match.kind === "text") {
      return this.emit(index, open + 1);
    }
    if (match.kind === "definition") {
      return this.definition(index, match);
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

  /**
   * A link reference definition: kept as written, or removed with its line when the policy
   * rejects its destination. A line whose remainder is not an address and a title is text.
   */
  private definition(index: number, match: Extract<LinkMatch, { kind: "definition" }>): number {
    const destination = readDefinitionDestination(this.text.slice(match.destinationStart, match.end));
    if (destination === null) {
      return this.emit(index, index + 1);
    }
    const verdict = this.policy(destination);
    if (verdict.kind === "keep") {
      return this.emit(index, match.end);
    }
    this.unwrapped.push(verdict.reason);
    return match.end;
  }

  /** The link text, guarded on its own: it may hold an image or another link. */
  private guardLabel(start: number, end: number): string {
    const inner = new LinkScanner(this.text.slice(start, end), this.policy, true, freshState(false)).run();
    this.unwrapped.push(...inner.unwrapped);
    return inner.output;
  }

  /** Whether a line break at `index` ends the paragraph: no construct reaches across a blank line. */
  private paragraphBreakAt(index: number): ParagraphBreak {
    let cursor = index + 1;
    while (cursor < this.text.length && isBlank(this.text[cursor])) {
      cursor += 1;
    }
    if (cursor >= this.text.length) {
      return this.final ? "blank" : "pending";
    }
    return this.text[cursor] === "\n" ? "blank" : "continues";
  }

  /** Reads `[text](destination)` or `[ref]: destination` from the `[` at `open`. */
  private matchLink(open: number, image: boolean): LinkMatch {
    const resumed = this.stepStart === 0 ? this.state.resume : null;
    if (resumed?.kind === "destination") {
      return this.matchDestination(resumed.textEnd);
    }
    if (resumed?.kind === "definition") {
      return this.matchDefinition(resumed.textEnd);
    }
    let depth = resumed?.kind === "label" ? resumed.depth : 0;
    let cursor = resumed?.kind === "label" ? resumed.cursor : open;
    const readFrom = cursor;
    let textEnd = -1;
    while (cursor < this.text.length) {
      if (cursor - open > MARKDOWN_LINK_BOUNDS.spanMaxLength) {
        this.read(readFrom, cursor);
        this.state.abandoned += 1;
        return { kind: "text" };
      }
      const char = this.text[cursor];
      if (char === "\n") {
        const paragraph = this.paragraphBreakAt(cursor);
        if (paragraph !== "continues") {
          this.read(readFrom, cursor);
          return paragraph === "pending" ? this.holdMatch("label", cursor, depth) : { kind: "text" };
        }
        cursor += 1;
        continue;
      }
      if (char === "\\") {
        cursor += this.text[cursor + 1] === "\n" ? 1 : 2;
        continue;
      }
      if (char === "`") {
        const close = this.codeSpanEnd(cursor);
        if (close === null) {
          this.read(readFrom, cursor);
          return this.holdMatch("label", cursor, depth);
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
    this.read(readFrom, cursor);
    if (textEnd < 0 || textEnd + 1 >= this.text.length) {
      if (this.final) {
        return { kind: "text" };
      }
      return textEnd < 0 ? this.holdMatch("label", cursor, depth) : this.holdMatch("label", textEnd, 1);
    }
    const after = this.text[textEnd + 1];
    if (after === "(") {
      return this.matchDestination(textEnd);
    }
    if (after === ":" && !image && this.leadAt(open)) {
      return this.matchDefinition(textEnd);
    }
    return { kind: "text" };
  }

  /** Reads `(destination)` after the text that ends at `textEnd`; the destination may continue over a line break. */
  private matchDestination(textEndOrOffset: number): LinkMatch {
    const resumed = this.stepStart === 0 && this.state.resume?.kind === "destination" ? this.state.resume : null;
    const textEnd = resumed ? resumed.textEnd : textEndOrOffset;
    const destinationStart = textEnd + 2;
    let depth = resumed ? resumed.depth : 1;
    let cursor = resumed ? resumed.cursor : destinationStart;
    const readFrom = cursor;
    for (; cursor < this.text.length; cursor += 1) {
      if (cursor - destinationStart > MARKDOWN_LINK_BOUNDS.destinationMaxLength) {
        this.read(readFrom, cursor);
        return { kind: "text" };
      }
      const char = this.text[cursor];
      if (char === "\n") {
        const paragraph = this.paragraphBreakAt(cursor);
        if (paragraph === "blank") {
          this.read(readFrom, cursor);
          return { kind: "text" };
        }
        if (paragraph === "pending") {
          this.read(readFrom, cursor);
          return this.holdMatch("destination", cursor, depth, textEnd);
        }
      } else if (char === "\\") {
        cursor += 1;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          this.read(readFrom, cursor);
          return { kind: "link", textEnd, destinationStart, end: cursor + 1 };
        }
      }
    }
    this.read(readFrom, cursor);
    return this.final ? { kind: "text" } : this.holdMatch("destination", cursor, depth, textEnd);
  }

  /** Reads what follows `[ref]:` to the end of its line. */
  private matchDefinition(textEndOrOffset: number): LinkMatch {
    const resumed = this.stepStart === 0 && this.state.resume?.kind === "definition" ? this.state.resume : null;
    const textEnd = resumed ? resumed.textEnd : textEndOrOffset;
    const destinationStart = textEnd + 2;
    let cursor = resumed ? resumed.cursor : destinationStart;
    const readFrom = cursor;
    const limit = destinationStart + MARKDOWN_LINK_BOUNDS.destinationMaxLength + MARKDOWN_LINK_BOUNDS.spanMaxLength;
    while (cursor < this.text.length && cursor < limit && this.text[cursor] !== "\n") {
      cursor += 1;
    }
    this.read(readFrom, cursor);
    if (cursor >= limit) {
      return { kind: "text" };
    }
    if (cursor >= this.text.length && !this.final) {
      return this.holdMatch("definition", cursor, 0, textEnd);
    }
    return { kind: "definition", textEnd, destinationStart, end: cursor };
  }
}

const freshState = (lineStart = true): ScanState => ({
  fence: null,
  atLineStart: lineStart,
  lineLead: lineStart,
  previous: "",
  abandoned: 0,
  resume: null,
  span: null,
  scanned: 0,
});

export const guardMarkdownLinks = <Reason extends string>(
  markdown: string,
  policy: LinkDestinationPolicy<Reason>,
): GuardedMarkdown<Reason> => {
  const { output, unwrapped } = new LinkScanner(markdown, policy, true, freshState()).run();
  return { text: output, unwrapped };
};

/**
 * {@link guardMarkdownLinks} over text that arrives in chunks. A chunk's text is released as
 * soon as nothing after it can change how it reads; an address is held from where it starts
 * until its end has been checked, so a rejected address is never released, not even in part.
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

  /** Characters read so far while looking for the end of a held construct; each chunk reads only what is new. */
  get scannedCharacters(): number {
    return this.state.scanned;
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
