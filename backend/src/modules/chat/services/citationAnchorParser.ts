export interface CitationAnchorGroup {
  start: number;
  end: number;
  resultNumbers: number[];
}

const ANCHOR_PATTERN = /\[\[(\d+)\]\]/g;

const removeDetachedPunctuationSpacing = (text: string): string =>
  text
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+(\r?\n)/g, "$1");

export const findCitationAnchorGroups = (answer: string): CitationAnchorGroup[] => {
  const matches = [...answer.matchAll(ANCHOR_PATTERN)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    resultNumber: Number(match[1]),
  }));

  const groups: CitationAnchorGroup[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const resultNumbers = [match.resultNumber];
    let end = match.end;

    while (index + 1 < matches.length) {
      const next = matches[index + 1];
      const gap = answer.slice(end, next.start);
      if (!/^[ \t]*$/.test(gap)) {
        break;
      }

      resultNumbers.push(next.resultNumber);
      end = next.end;
      index += 1;
    }

    groups.push({
      start: match.start,
      end,
      resultNumbers,
    });
  }

  return groups;
};

export const stripResidualCitationSyntax = (text: string): string =>
  removeDetachedPunctuationSpacing(text
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[[^\s.,;:!?)]*/g, "")
    .replace(/\]\]/g, ""));
