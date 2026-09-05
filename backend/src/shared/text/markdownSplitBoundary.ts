/**
 * Where a markdown string may be cut in two without breaking it.
 *
 * A consumer that slices markdown at computed offsets and renders each slice through its
 * own markdown pass (streaming chunkers, segmenters, exporters) corrupts the output when a
 * cut lands inside a construct: half a `**strong**` span or half a `[label](dest)` link
 * renders as literal text on both sides, and a cut inside a table orphans its remaining
 * rows. This module answers one question — given a candidate offset, what is the nearest
 * offset at or after it that divides no construct?
 *
 * It knows markdown syntax and nothing else. Callers that slice for their own reasons
 * (citation anchors, sentence boundaries) describe the spans that are not markdown content
 * through `ignoredRanges`; this module never learns why those spans exist.
 *
 * The scanner is deliberately conservative rather than spec-exact: over-protecting moves a
 * split slightly further right, which is harmless, while under-protecting reintroduces the
 * broken render. There is no markdown parser dependency in the backend and this does not
 * add one.
 */

export interface MarkdownRange {
  readonly start: number;
  readonly end: number;
}

export type MarkdownConstruct =
  | "code_fence"
  | "table"
  | "code_span"
  | "autolink"
  | "image"
  | "link"
  | "emphasis";

export interface SafeSplitOffset {
  /** The nearest offset at or after the candidate that divides no markdown construct. */
  readonly offset: number;
  /**
   * The construct that forced the move — the outermost one when constructs nest. Absent
   * when the candidate offset was already safe.
   */
  readonly relocatedPast?: MarkdownConstruct;
}

export interface MarkdownSplitBoundaries {
  resolve(candidateOffset: number): SafeSplitOffset;
}

interface ProtectedRange extends MarkdownRange {
  readonly construct: MarkdownConstruct;
}

interface SourceLine {
  /** Offset of the first character of the line. */
  readonly start: number;
  /** Offset just past the last character, excluding the line break. */
  readonly end: number;
  /** Offset of the first character of the next line. */
  readonly next: number;
  readonly text: string;
}

const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WHITESPACE = /\s/;
// CommonMark's flanking rules classify by Unicode punctuation and symbols, not by script.
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// A GFM delimiter row: optional leading/trailing pipes around `---`/`:--`/`--:` cells. A
// bare `---` also matches this shape, so a pipe is required separately to keep thematic
// breaks and setext underlines out.
const TABLE_DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^\s<>@]+@[^\s<>]+)>/y;
const BLANK_LINE = /\r?\n[ \t]*\r?\n/g;

const isWhitespaceChar = (char: string | undefined): boolean =>
  char === undefined || WHITESPACE.test(char);

const isPunctuationChar = (char: string | undefined): boolean =>
  char !== undefined && UNICODE_PUNCTUATION.test(char);

const clamp = (value: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return value > 0 ? max : 0;
  }
  return Math.min(Math.max(Math.trunc(value), 0), max);
};

/** Sorts, clamps, drops empty, and merges overlapping caller-supplied ranges. */
const normalizeIgnoredRanges = (
  ranges: ReadonlyArray<MarkdownRange> | undefined,
  length: number,
): MarkdownRange[] => {
  if (!ranges || ranges.length === 0) {
    return [];
  }

  const cleaned = ranges
    .map((range) => ({
      start: clamp(Math.min(range.start, range.end), length),
      end: clamp(Math.max(range.start, range.end), length),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);

  const merged: MarkdownRange[] = [];
  for (const range of cleaned) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
      continue;
    }
    merged.push(range);
  }

  return merged;
};

const splitLines = (markdown: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start <= markdown.length) {
    const breakIndex = markdown.indexOf("\n", start);
    if (breakIndex < 0) {
      lines.push({
        start,
        end: markdown.length,
        next: markdown.length + 1,
        text: markdown.slice(start),
      });
      break;
    }

    const end = breakIndex > start && markdown[breakIndex - 1] === "\r" ? breakIndex - 1 : breakIndex;
    lines.push({ start, end, next: breakIndex + 1, text: markdown.slice(start, end) });
    start = breakIndex + 1;
  }

  return lines;
};

const isTableRowCandidate = (text: string): boolean => text.trim().length > 0 && text.includes("|");

const isDelimiterRow = (text: string): boolean =>
  text.includes("|") && TABLE_DELIMITER_ROW.test(text);

/**
 * Block-level constructs: fenced code and GFM tables. Both must be crossed whole — a table
 * in particular, because a cut between two rows leaves the remainder rendering as loose
 * text rather than as part of the table.
 */
const findBlockRanges = (markdown: string): ProtectedRange[] => {
  const lines = splitLines(markdown);
  const ranges: ProtectedRange[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = FENCE_OPEN.exec(line.text);

    if (fence) {
      const marker = fence[1];
      let close = index + 1;
      while (close < lines.length) {
        const candidate = FENCE_CLOSE.exec(lines[close].text);
        if (candidate && candidate[1][0] === marker[0] && candidate[1].length >= marker.length) {
          break;
        }
        close += 1;
      }

      const last = lines[Math.min(close, lines.length - 1)];
      ranges.push({ start: line.start, end: last.end, construct: "code_fence" });
      index = close + 1;
      continue;
    }

    const delimiter = lines[index + 1];
    if (delimiter && isDelimiterRow(delimiter.text) && isTableRowCandidate(line.text)) {
      let last = index + 1;
      while (last + 1 < lines.length) {
        const body = lines[last + 1];
        if (body.text.trim().length === 0 || FENCE_OPEN.test(body.text)) {
          break;
        }
        last += 1;
      }

      ranges.push({ start: line.start, end: lines[last].end, construct: "table" });
      index = last + 1;
      continue;
    }

    index += 1;
  }

  return ranges;
};

class InlineScanner {
  private readonly ranges: ProtectedRange[] = [];

  constructor(
    private readonly markdown: string,
    private readonly ignored: ReadonlyArray<MarkdownRange>,
  ) {}

  scanParagraph(start: number, end: number): void {
    const emphasis: Array<{ char: string; start: number }> = [];
    let index = start;

    while (index < end) {
      const skipped = this.skipIgnored(index);
      if (skipped > index) {
        index = skipped;
        continue;
      }

      const char = this.markdown[index];

      if (char === "\\") {
        index += ASCII_PUNCTUATION.test(this.markdown[index + 1] ?? "") ? 2 : 1;
        continue;
      }

      if (char === "`") {
        const runEnd = this.runEnd(index, "`", end);
        const close = this.findBacktickClose(runEnd, runEnd - index, end);
        if (close > 0) {
          this.ranges.push({ start: index, end: close, construct: "code_span" });
          index = close;
          continue;
        }
        index = runEnd;
        continue;
      }

      if (char === "<") {
        AUTOLINK.lastIndex = index;
        const match = AUTOLINK.exec(this.markdown);
        if (match && index + match[0].length <= end) {
          const close = index + match[0].length;
          this.ranges.push({ start: index, end: close, construct: "autolink" });
          index = close;
          continue;
        }
        index += 1;
        continue;
      }

      if (char === "!" && this.markdown[index + 1] === "[") {
        const close = this.matchLink(index + 1, end);
        if (close > 0) {
          this.ranges.push({ start: index, end: close, construct: "image" });
          index = close;
          continue;
        }
        index += 1;
        continue;
      }

      if (char === "[") {
        const close = this.matchLink(index, end);
        if (close > 0) {
          this.ranges.push({ start: index, end: close, construct: "link" });
          index = close;
          continue;
        }
        index += 1;
        continue;
      }

      if (char === "*" || char === "_") {
        index = this.scanEmphasisRun(index, start, end, char, emphasis);
        continue;
      }

      index += 1;
    }
  }

  collect(): ProtectedRange[] {
    return this.ranges;
  }

  /** If `index` falls at or inside an ignored range, the offset just past that range. */
  private skipIgnored(index: number): number {
    let low = 0;
    let high = this.ignored.length - 1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      const range = this.ignored[middle];
      if (index < range.start) {
        high = middle - 1;
      } else if (index >= range.end) {
        low = middle + 1;
      } else {
        return range.end;
      }
    }

    return index;
  }

  private runEnd(index: number, char: string, limit: number): number {
    let end = index;
    while (end < limit && this.markdown[end] === char) {
      end += 1;
    }
    return end;
  }

  private findBacktickClose(from: number, length: number, limit: number): number {
    let index = from;

    while (index < limit) {
      const skipped = this.skipIgnored(index);
      if (skipped > index) {
        index = skipped;
        continue;
      }

      if (this.markdown[index] === "`") {
        const runEnd = this.runEnd(index, "`", limit);
        if (runEnd - index === length) {
          return runEnd;
        }
        index = runEnd;
        continue;
      }

      index += 1;
    }

    return -1;
  }

  /**
   * Matches `[label](dest)`, `[label][ref]`, and `[label][]` starting at the opening
   * bracket. Returns the offset just past the construct, or -1 when the brackets do not
   * form a link (`arr[0]`, `[2024]`).
   */
  private matchLink(open: number, limit: number): number {
    let depth = 0;
    let index = open;
    let labelEnd = -1;

    while (index < limit) {
      const skipped = this.skipIgnored(index);
      if (skipped > index) {
        index = skipped;
        continue;
      }

      const char = this.markdown[index];

      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === "`") {
        const runEnd = this.runEnd(index, "`", limit);
        const close = this.findBacktickClose(runEnd, runEnd - index, limit);
        index = close > 0 ? close : runEnd;
        continue;
      }

      if (char === "[") {
        depth += 1;
        index += 1;
        continue;
      }

      if (char === "]") {
        depth -= 1;
        index += 1;
        if (depth === 0) {
          labelEnd = index;
          break;
        }
        continue;
      }

      index += 1;
    }

    if (labelEnd < 0 || labelEnd >= limit) {
      return -1;
    }

    const next = this.markdown[labelEnd];
    if (next === "(") {
      return this.matchBalanced(labelEnd, "(", ")", limit);
    }
    if (next === "[") {
      return this.matchReference(labelEnd, limit);
    }

    return -1;
  }

  private matchBalanced(open: number, openChar: string, closeChar: string, limit: number): number {
    let depth = 0;
    let index = open;

    while (index < limit) {
      const skipped = this.skipIgnored(index);
      if (skipped > index) {
        index = skipped;
        continue;
      }

      const char = this.markdown[index];

      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === openChar) {
        depth += 1;
        index += 1;
        continue;
      }

      if (char === closeChar) {
        depth -= 1;
        index += 1;
        if (depth === 0) {
          return index;
        }
        continue;
      }

      index += 1;
    }

    return -1;
  }

  private matchReference(open: number, limit: number): number {
    let index = open + 1;

    while (index < limit) {
      const skipped = this.skipIgnored(index);
      if (skipped > index) {
        index = skipped;
        continue;
      }

      const char = this.markdown[index];

      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === "]") {
        return index + 1;
      }

      if (char === "[") {
        return -1;
      }

      index += 1;
    }

    return -1;
  }

  /**
   * CommonMark's left/right-flanking delimiter-run rules, applied with a stack. Unmatched
   * openers are discarded at the paragraph boundary, so a stray `*` protects nothing.
   */
  private scanEmphasisRun(
    index: number,
    paragraphStart: number,
    paragraphEnd: number,
    char: string,
    stack: Array<{ char: string; start: number }>,
  ): number {
    const runEnd = this.runEnd(index, char, paragraphEnd);
    const previousChar = index > paragraphStart ? this.markdown[index - 1] : undefined;
    const nextChar = runEnd < paragraphEnd ? this.markdown[runEnd] : undefined;

    const leftFlanking =
      !isWhitespaceChar(nextChar) &&
      (!isPunctuationChar(nextChar) || isWhitespaceChar(previousChar) || isPunctuationChar(previousChar));
    const rightFlanking =
      !isWhitespaceChar(previousChar) &&
      (!isPunctuationChar(previousChar) || isWhitespaceChar(nextChar) || isPunctuationChar(nextChar));

    const canOpen =
      char === "*" ? leftFlanking : leftFlanking && (!rightFlanking || isPunctuationChar(previousChar));
    const canClose =
      char === "*" ? rightFlanking : rightFlanking && (!leftFlanking || isPunctuationChar(nextChar));

    if (canClose) {
      let depth = stack.length - 1;
      while (depth >= 0 && stack[depth].char !== char) {
        depth -= 1;
      }

      if (depth >= 0) {
        this.ranges.push({ start: stack[depth].start, end: runEnd, construct: "emphasis" });
        stack.length = depth;
        return runEnd;
      }
    }

    if (canOpen) {
      stack.push({ char, start: index });
    }

    return runEnd;
  }
};

/** Paragraph sub-ranges of `[start, end)`, split on blank lines. */
const splitParagraphs = (markdown: string, start: number, end: number): MarkdownRange[] => {
  const text = markdown.slice(start, end);
  const paragraphs: MarkdownRange[] = [];
  let cursor = 0;

  BLANK_LINE.lastIndex = 0;
  for (const match of text.matchAll(BLANK_LINE)) {
    paragraphs.push({ start: start + cursor, end: start + match.index });
    cursor = match.index + match[0].length;
  }
  paragraphs.push({ start: start + cursor, end });

  return paragraphs.filter((paragraph) => paragraph.end > paragraph.start);
};

const findProtectedRanges = (
  markdown: string,
  ignored: ReadonlyArray<MarkdownRange>,
): ProtectedRange[] => {
  const blockRanges = findBlockRanges(markdown);
  const scanner = new InlineScanner(markdown, ignored);

  // Inline constructs are only meaningful outside fenced code and tables, so scan the gaps
  // between block ranges. `*` inside a code fence must never open an emphasis span.
  let cursor = 0;
  for (const block of blockRanges) {
    if (block.start > cursor) {
      for (const paragraph of splitParagraphs(markdown, cursor, block.start)) {
        scanner.scanParagraph(paragraph.start, paragraph.end);
      }
    }
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < markdown.length) {
    for (const paragraph of splitParagraphs(markdown, cursor, markdown.length)) {
      scanner.scanParagraph(paragraph.start, paragraph.end);
    }
  }

  return [...blockRanges, ...scanner.collect()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
};

export const findMarkdownSplitBoundaries = (
  markdown: string,
  ignoredRanges?: ReadonlyArray<MarkdownRange>,
): MarkdownSplitBoundaries => {
  const ranges = findProtectedRanges(markdown, normalizeIgnoredRanges(ignoredRanges, markdown.length));

  return {
    resolve(candidateOffset: number): SafeSplitOffset {
      let offset = clamp(candidateOffset, markdown.length);
      let relocatedPast: MarkdownConstruct | undefined;
      let moved = true;

      // Splitting exactly at a construct's start or end is safe — the whole construct lands
      // on one side. Only a strictly interior offset has to move. Iterating to a fixed point
      // handles nesting: the innermost construct is crossed first, then any enclosing one.
      while (moved) {
        moved = false;
        for (const range of ranges) {
          if (range.start < offset && offset < range.end) {
            offset = range.end;
            relocatedPast = range.construct;
            moved = true;
          }
        }
      }

      return relocatedPast === undefined ? { offset } : { offset, relocatedPast };
    },
  };
};

export const resolveSafeSplitOffset = (
  markdown: string,
  candidateOffset: number,
  ignoredRanges?: ReadonlyArray<MarkdownRange>,
): SafeSplitOffset => findMarkdownSplitBoundaries(markdown, ignoredRanges).resolve(candidateOffset);
