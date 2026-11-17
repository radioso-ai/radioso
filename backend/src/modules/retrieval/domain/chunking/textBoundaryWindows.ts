interface TextSpan {
  startOffset: number;
  endOffset: number;
}

interface BoundedWindowOptions {
  /** The most UTF-16 code units a window may hold. */
  maxChars: number;
  /** How much of a window's tail the next window repeats, at most. */
  overlapChars: number;
}

/**
 * A window ends at a sentence or line end only when that keeps at least this
 * share of the window; past that, it ends between words instead, so one long
 * sentence does not shrink every chunk around it.
 */
const MIN_FILL_RATIO = 0.5;

const WHITESPACE = /\s/;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6}\s/;

/**
 * Splits text into windows of at most `maxChars` that start and end at
 * Unicode text boundaries (UAX #29, through `Intl.Segmenter`), so the same
 * rules hold for every language and script:
 *
 * - a window ends at the last sentence or line end that keeps it at least half
 *   full, then at the last space, then at the last word boundary (for scripts
 *   written without spaces), and only for a single token longer than the
 *   window at the window's edge, never inside a surrogate pair;
 * - a window that would end just after a Markdown heading ends before it, so
 *   the heading opens the next window with its section;
 * - the next window repeats up to `overlapChars` of the previous one, starting
 *   at a sentence start inside that tail, else at a word start. An overlap is
 *   never more than half the window it repeats, so every window moves forward.
 */
export const splitIntoBoundedWindows = (text: string, options: BoundedWindowOptions): TextSpan[] => {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const overlapChars = Math.max(0, Math.floor(options.overlapChars));
  const boundaries = new TextBoundaries(text);
  const windows: TextSpan[] = [];
  let startOffset = skipWhitespace(text, 0);

  while (startOffset < text.length) {
    const limit = startOffset + maxChars;
    if (limit >= text.length) {
      windows.push({ startOffset, endOffset: text.length });
      break;
    }

    const endOffset = boundaries.windowEnd(startOffset, limit, startOffset + Math.ceil(maxChars * MIN_FILL_RATIO));
    windows.push({ startOffset, endOffset });
    startOffset = skipWhitespace(text, boundaries.nextWindowStart(startOffset, endOffset, overlapChars));
  }

  return windows;
};

class TextBoundaries {
  private readonly sentences: Intl.Segments;
  private readonly words: Intl.Segments;

  constructor(private readonly text: string) {
    this.sentences = new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text);
    this.words = new Intl.Segmenter(undefined, { granularity: "word" }).segment(text);
  }

  /** The end of the window that starts at `start` and may run to `limit` (exclusive of the text past it). */
  windowEnd(start: number, limit: number, minimumEnd: number): number {
    const sentenceEnd = this.sentenceStartAtOrBefore(limit);
    if (sentenceEnd >= minimumEnd) {
      return this.beforeTrailingHeading(sentenceEnd, minimumEnd);
    }

    for (const floor of [minimumEnd, start + 1]) {
      const end = this.lastSpaceAtOrBefore(limit, floor) ?? this.wordStartAtOrBefore(limit, floor);
      if (end !== null) {
        return end;
      }
    }

    return this.codePointBoundaryAtOrBefore(limit, start);
  }

  /** Where the window after [start, end) begins. */
  nextWindowStart(start: number, end: number, overlapChars: number): number {
    if (overlapChars === 0) {
      return end;
    }

    const earliest = Math.max(end - overlapChars, start + Math.ceil((end - start) / 2));
    // A blank line is a sentence of its own to the segmenter; the window starts at the text after it.
    const candidates = [
      this.sentenceStartAtOrAfter(earliest),
      this.wordStartAfterSpace(earliest, end),
      this.wordStartAtOrAfter(earliest),
    ].map((candidate) => skipWhitespace(this.text, candidate));

    return candidates.find((candidate) => candidate > start && candidate < end) ?? end;
  }

  private sentenceStartAtOrBefore(offset: number): number {
    return this.sentences.containing(offset)?.index ?? offset;
  }

  private sentenceStartAtOrAfter(offset: number): number {
    const segment = this.sentences.containing(offset);
    if (!segment) {
      return this.text.length;
    }
    return segment.index === offset ? offset : segment.index + segment.segment.length;
  }

  private wordStartAtOrBefore(offset: number, floor: number): number | null {
    const index = this.words.containing(offset)?.index ?? offset;
    return index >= floor ? index : null;
  }

  private wordStartAtOrAfter(offset: number): number {
    const segment = this.words.containing(offset);
    if (!segment) {
      return this.text.length;
    }
    return segment.index === offset ? offset : segment.index + segment.segment.length;
  }

  /** The offset of the last whitespace character in [floor, offset], where the window may end. */
  private lastSpaceAtOrBefore(offset: number, floor: number): number | null {
    for (let index = offset; index >= floor; index -= 1) {
      if (WHITESPACE.test(this.text[index] ?? "")) {
        return index;
      }
    }
    return null;
  }

  /** The first word after a whitespace run that begins in [offset, end). */
  private wordStartAfterSpace(offset: number, end: number): number {
    for (let index = offset; index < end; index += 1) {
      if (WHITESPACE.test(this.text[index] ?? "")) {
        return skipWhitespace(this.text, index);
      }
    }
    return end;
  }

  private codePointBoundaryAtOrBefore(offset: number, start: number): number {
    const splitsSurrogatePair = isLowSurrogate(this.text.charCodeAt(offset))
      && isHighSurrogate(this.text.charCodeAt(offset - 1));
    return splitsSurrogatePair && offset - 1 > start ? offset - 1 : offset;
  }

  /** Moves an end that would leave headings as a window's last lines to before them. */
  private beforeTrailingHeading(end: number, minimumEnd: number): number {
    let adjustedEnd = end;
    for (;;) {
      const lastLineStart = this.lastNonBlankLineStart(adjustedEnd);
      if (
        lastLineStart === null
        || lastLineStart < minimumEnd
        || !MARKDOWN_HEADING_LINE.test(this.text.slice(lastLineStart, adjustedEnd))
      ) {
        return adjustedEnd;
      }
      adjustedEnd = lastLineStart;
    }
  }

  private lastNonBlankLineStart(end: number): number | null {
    let lineEnd = end;
    while (lineEnd > 0 && WHITESPACE.test(this.text[lineEnd - 1] ?? "")) {
      lineEnd -= 1;
    }
    if (lineEnd === 0) {
      return null;
    }
    return this.text.lastIndexOf("\n", lineEnd - 1) + 1;
  }
}

const skipWhitespace = (text: string, offset: number): number => {
  let index = offset;
  while (index < text.length && WHITESPACE.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
