import { findCitationAnchors, stripCitationAnchorSyntax } from "./citationAnchorSyntax.js";
import { removeDetachedPunctuationSpacing } from "./citationTextNormalization.js";

interface CitationAnchorGroup {
  start: number;
  end: number;
  resultNumbers: number[];
  explicitlyUnsourced: boolean;
}

export const findCitationAnchorGroups = (answer: string): CitationAnchorGroup[] => {
  const matches = findCitationAnchors(answer);

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

/**
 * Removes the anchor syntax left in `text` (see `citationAnchorSyntax.ts`) and the spacing it
 * stranded before punctuation. `text` runs to the end of the answer, so a trailing `[[12` is
 * an anchor cut short and goes too.
 */
export const stripResidualCitationSyntax = (text: string): string =>
  removeDetachedPunctuationSpacing(stripCitationAnchorSyntax(text, { endsAnswer: true }));
