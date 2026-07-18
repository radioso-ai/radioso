import { removeDetachedPunctuationSpacing } from "./citationTextNormalization.js";

export interface CitationAnchorGroup {
  start: number;
  end: number;
  resultNumbers: number[];
  explicitlyUnsourced: boolean;
}

const ANCHOR_PATTERN = /\[\[(\d+|\?)\]\]/g;

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
    .replace(/\]\]/g, ""));
