import sanitizeHtml from "sanitize-html";

/**
 * Quoted-history and signature stripping (research A10). Every signal is format syntax: HTML
 * quote markup that mail clients emit, the RFC 3676 quote prefix and sig-dash, and a verbatim
 * match of text Radioso itself sent. No signal reads words, so the stripper behaves the same in
 * every language. Stripping is `confident` only when a signal matched and text remains; otherwise
 * the full text is kept, so the agent sees more, never less.
 */

export type StripConfidence = "confident" | "full_text";

type QuotedHistorySignal =
  | "quote_container"
  | "quote_prefix_block"
  | "signature_separator"
  | "prior_outbound_text";

interface QuotedHistoryResult {
  text: string;
  confidence: StripConfidence;
  /** The signals that produced `text`; empty when the full text is kept. */
  signals: readonly QuotedHistorySignal[];
}

interface QuotedHistoryInput {
  /** The text to strip. For an HTML body, the text after `removeQuoteContainers`. */
  text: string;
  /** What to keep when stripping is not confident. Defaults to `text`. */
  fullText?: string;
  /** Signals already applied upstream, such as HTML quote containers. */
  signals?: readonly QuotedHistorySignal[];
  /** Plain text of messages Radioso sent on this thread. */
  priorOutboundTexts: readonly string[];
}

/** Shorter prior messages ("Thanks!") are too common to prove the rest of the body is history. */
const MIN_PRIOR_OUTBOUND_MATCH_LENGTH = 20;

const SIGNATURE_SEPARATOR = "-- ";

/** Quote containers that clients wrap around the attribution and the quoted message. */
const QUOTE_CONTAINER_CLASSES = new Set(["gmail_quote", "yahoo_quoted", "moz-cite-prefix"]);

/** Outlook markers: everything from the marker to the end of the document is the history. */
const HISTORY_MARKER_IDS = new Set(["divRplyFwdMsg", "appendonsend"]);

const HISTORY_MARK_ATTRIBUTE = "data-radioso-quoted-history";

export const stripQuotedHistory = (input: QuotedHistoryInput): QuotedHistoryResult => {
  const text = normalizeLineBreaks(input.text);
  const fullText = normalizeLineBreaks(input.fullText ?? input.text).trim();
  const signals: QuotedHistorySignal[] = [...(input.signals ?? [])];

  let lines = text.split("\n");
  const priorLine = priorOutboundStartLine(text, input.priorOutboundTexts);
  if (priorLine !== null) {
    lines = lines.slice(0, priorLine);
    signals.push("prior_outbound_text");
  }
  const signatureLine = lines.indexOf(SIGNATURE_SEPARATOR);
  if (signatureLine !== -1) {
    lines = lines.slice(0, signatureLine);
    signals.push("signature_separator");
  }
  const withoutQuote = removeTrailingQuoteBlock(lines);
  if (withoutQuote) {
    lines = withoutQuote;
    signals.push("quote_prefix_block");
  }

  const stripped = lines.join("\n").trim();
  if (signals.length > 0 && stripped.length > 0) {
    return { text: stripped, confidence: "confident", signals };
  }
  return { text: fullText, confidence: "full_text", signals: [] };
};

/** Signal 1: removes the HTML quote markup that mail clients emit around quoted history. */
export const removeQuoteContainers = (
  html: string,
): { html: string; signals: readonly QuotedHistorySignal[] } => {
  let matched = false;
  let historyStarted = false;
  const result = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      "*": (tagName, attribs) => {
        const { [HISTORY_MARK_ATTRIBUTE]: _ignored, ...ownAttribs } = attribs;
        if (!historyStarted && HISTORY_MARKER_IDS.has(ownAttribs.id ?? "")) {
          historyStarted = true;
          matched = true;
        }
        return {
          tagName,
          attribs: historyStarted ? { ...ownAttribs, [HISTORY_MARK_ATTRIBUTE]: "" } : ownAttribs,
        };
      },
    },
    exclusiveFilter: (frame) => {
      if (HISTORY_MARK_ATTRIBUTE in frame.attribs) {
        return true;
      }
      if (isQuoteContainer(frame.tag, frame.attribs)) {
        matched = true;
        return true;
      }
      return false;
    },
    textFilter: (text) => (historyStarted ? "" : text),
  });
  return { html: result, signals: matched ? ["quote_container"] : [] };
};

const isQuoteContainer = (tag: string, attribs: Readonly<Record<string, string>>): boolean => {
  if (tag === "blockquote" && attribs.type?.trim().toLowerCase() === "cite") {
    return true;
  }
  const classes = (attribs.class ?? "").split(/\s+/);
  return classes.some((className) => QUOTE_CONTAINER_CLASSES.has(className));
};

const normalizeLineBreaks = (text: string): string => text.replace(/\r\n?/g, "\n");

const isQuoteLine = (line: string): boolean => line.startsWith(">");

const isBlank = (line: string): boolean => line.trim().length === 0;

/**
 * Signal 2: a single `>`-prefixed block (blank lines inside it allowed), plus the line directly
 * before it when that line ends in `:`. Two or more blocks are an interleaved reply and stay.
 */
const removeTrailingQuoteBlock = (lines: readonly string[]): string[] | null => {
  const blocks = quoteBlocks(lines);
  const block = blocks.length === 1 ? blocks[0] : undefined;
  if (!block) {
    return null;
  }
  const attribution = lines[block.start - 1];
  const start =
    attribution !== undefined && !isBlank(attribution) && attribution.trimEnd().endsWith(":")
      ? block.start - 1
      : block.start;
  return joinAroundCut(lines.slice(0, start), lines.slice(block.end + 1));
};

const quoteBlocks = (lines: readonly string[]): { start: number; end: number }[] => {
  const blocks: { start: number; end: number }[] = [];
  let start = -1;
  let end = -1;
  for (const [index, line] of lines.entries()) {
    if (isQuoteLine(line)) {
      start = start === -1 ? index : start;
      end = index;
    } else if (start !== -1 && !isBlank(line)) {
      blocks.push({ start, end });
      start = -1;
    }
  }
  if (start !== -1) {
    blocks.push({ start, end });
  }
  return blocks;
};

/** Keeps one blank line where the cut left two, so the seam reads like the original spacing. */
const joinAroundCut = (before: readonly string[], after: readonly string[]): string[] => {
  const last = before[before.length - 1];
  const first = after[0];
  if (last !== undefined && first !== undefined && isBlank(last) && isBlank(first)) {
    return [...before, ...after.slice(1)];
  }
  return [...before, ...after];
};

/**
 * Signal 4: the first line where a prior Radioso message begins, matched verbatim with whitespace
 * runs collapsed (clients rewrap quoted text). The match must start a line.
 */
const priorOutboundStartLine = (text: string, priorTexts: readonly string[]): number | null => {
  const body = collapseWhitespace(text);
  let earliest: number | null = null;
  for (const prior of priorTexts) {
    const needle = collapseWhitespace(prior).chars.trim();
    if (needle.length < MIN_PRIOR_OUTBOUND_MATCH_LENGTH) {
      continue;
    }
    for (let at = body.chars.indexOf(needle); at !== -1; at = body.chars.indexOf(needle, at + 1)) {
      const offset = body.origin[at] ?? 0;
      const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
      if (text.slice(lineStart, offset).trim().length === 0) {
        earliest = Math.min(earliest ?? offset, offset);
        break;
      }
    }
  }
  return earliest === null ? null : text.slice(0, earliest).split("\n").length - 1;
};

/** Whitespace runs become one space; `origin[i]` is the source offset of collapsed character i. */
const collapseWhitespace = (text: string): { chars: string; origin: number[] } => {
  let chars = "";
  const origin: number[] = [];
  let previousWasSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const isSpace = /\s/.test(character);
    if (isSpace && previousWasSpace) {
      continue;
    }
    chars += isSpace ? " " : character;
    origin.push(index);
    previousWasSpace = isSpace;
  }
  return { chars, origin };
};
