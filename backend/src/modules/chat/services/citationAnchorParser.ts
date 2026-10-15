import { removeDetachedPunctuationSpacing } from "./citationTextNormalization.js";

interface CitationAnchorGroup {
  start: number;
  end: number;
  resultNumbers: number[];
  explicitlyUnsourced: boolean;
}

const ANCHOR_PATTERN = /\[\[(\d+|\?)\]\]/g;

/**
 * The single-bracket form of an assertion marker (`[n]` or `[?]`) the model sometimes
 * writes instead of the prompted `[[n]]`/`[[?]]` (#1502). Not adjacent to another bracket,
 * so `[[n]]`/`[[?]]` are left to their own handling, and not immediately followed by `(`,
 * so a markdown link whose label is a bare number (`[1](url)`) survives. Everything else
 * shaped like `[n]`/`[?]` is treated as a stray marker and removed, the same trade-off the
 * voice channel's speech renderer already makes; shared here (exported via chat/contracts)
 * so both paths strip the identical shape.
 */
export const SINGLE_BRACKET_ASSERTION_MARKER = /(?<!\[)\[(?:\d+|\?)\](?!\]|\()/g;

export const findCitationAnchorGroups = (answer: string): CitationAnchorGroup[] => {
  const matches = [...answer.matchAll(ANCHOR_PATTERN)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    resultNumber: match[1] === "?" ? null : Number(match[1]),
  }));

  const groups: CitationAnchorGroup[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const explicitlyUnsourced = match.resultNumber === null;
    const resultNumbers = match.resultNumber === null ? [] : [match.resultNumber];
    let end = match.end;

    while (index + 1 < matches.length) {
      const next = matches[index + 1];
      const gap = answer.slice(end, next.start);
      if (!/^[ \t]*$/.test(gap) || (next.resultNumber === null) !== explicitlyUnsourced) {
        break;
      }

      if (next.resultNumber !== null) {
        resultNumbers.push(next.resultNumber);
      }
      end = next.end;
      index += 1;
    }

    groups.push({
      start: match.start,
      end,
      resultNumbers,
      explicitlyUnsourced,
    });
  }

  return groups;
};

export const stripResidualCitationSyntax = (text: string): string =>
  removeDetachedPunctuationSpacing(text
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[[^\s.,;:!?)]*/g, "")
    .replace(/\]\]/g, "")
    .replace(SINGLE_BRACKET_ASSERTION_MARKER, ""));
