import type {
  AnswerSegment,
  ChatCitation,
  CitationEvidence,
  NormalizedPresentedAnswer,
  PresentedAnswer,
} from "../contracts/answerTypes.js";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

const hasWordLikeContent = (value: string): boolean => {
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) {
      return true;
    }
  }

  return false;
};

const extractSignificantTerms = (value: string): string[] => {
  const terms: string[] = [];

  for (const segment of wordSegmenter.segment(value.normalize("NFKC").toLowerCase())) {
    if (!segment.isWordLike) {
      continue;
    }

    const normalized = segment.segment.replace(/[^\p{L}\p{N}]+/gu, "");
    if (normalized.length < 4) {
      continue;
    }
    terms.push(normalized);
  }

  return [...new Set(terms)];
};

const normalizeComparableText = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export const splitIntoSentenceLikeSegments = (value: string): string[] => {
  const rawSegments = [...sentenceSegmenter.segment(value)]
    .map((segment) => segment.segment)
    .filter((segment) => segment.length > 0);

  if (rawSegments.length <= 1) {
    return [value];
  }

  const segments: string[] = [];
  let carry = "";

  for (const segment of rawSegments) {
    if (!hasWordLikeContent(segment)) {
      carry += segment;
      continue;
    }

    segments.push(`${carry}${segment}`);
    carry = "";
  }

  if (carry.length > 0) {
    if (segments.length === 0) {
      segments.push(carry);
    } else {
      segments[segments.length - 1] += carry;
    }
  }

  const rebuilt = segments.join("");
  return rebuilt === value ? segments : [value];
};

export const resolveImplicitCitationIndices = (
  text: string,
  citationEvidence: CitationEvidence[],
): number[] | undefined => {
  // These thresholds are user-visible citation policy now, not a defensive cleanup path:
  // require enough distinct long terms to avoid short-answer noise, require at least
  // two shared terms and 50% overlap for basic support, and demand either stronger
  // overlap or a clear win when multiple citations compete.
  const segmentTerms = extractSignificantTerms(text);
  if (segmentTerms.length < 3) {
    const normalizedText = normalizeComparableText(text);
    const exactIndex = citationEvidence.findIndex((citation) =>
      normalizeComparableText(`${citation.title} ${citation.content}`).includes(normalizedText),
    );
    return exactIndex >= 0 ? [exactIndex] : undefined;
  }

  const scores = citationEvidence
    .map((citation, index) => {
      const citationTerms = new Set(extractSignificantTerms(`${citation.title} ${citation.content}`));
      const matchedTerms = segmentTerms.filter((term) => citationTerms.has(term));
      return {
        index,
        matches: matchedTerms.length,
        ratio: matchedTerms.length / segmentTerms.length,
      };
    })
    .filter((score) => score.matches >= 2)
    .sort((left, right) => {
      if (right.ratio !== left.ratio) {
        return right.ratio - left.ratio;
      }
      return right.matches - left.matches;
    });

  const best = scores[0];
  const second = scores[1];
  if (!best) {
    return undefined;
  }

  if (best.ratio < 0.5) {
    return undefined;
  }

  if (second && best.ratio < 0.7 && best.matches <= second.matches) {
    return undefined;
  }

  return [best.index];
};

const toChatCitation = (citation: CitationEvidence): ChatCitation => ({
  documentId: citation.documentId,
  chunkId: citation.chunkId,
  title: citation.title,
});

const sameCitationIndices = (left?: number[], right?: number[]): boolean => {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
};

const hasParagraphBreak = (text: string): boolean => /\r?\n\r?\n/.test(text);

// Input citationIndices must be relative to citationEvidence. Segments from another
// citation array, such as normalize()'s visible-only evidence, must be remapped first.
export const attachImplicitCitationArtifacts = (
  answerSegments: AnswerSegment[],
  citationEvidence: CitationEvidence[],
): {
  citations: ChatCitation[];
  answerSegments: AnswerSegment[];
} => {
  const expandedSegments: AnswerSegment[] = [];

  for (const segment of answerSegments) {
    if ((segment.citationIndices?.length ?? 0) > 0) {
      expandedSegments.push(segment);
      continue;
    }

    for (const text of splitIntoSentenceLikeSegments(segment.text)) {
      const citationIndices = resolveImplicitCitationIndices(text, citationEvidence);
      expandedSegments.push(citationIndices ? { text, citationIndices } : { text });
    }
  }

  const citations: ChatCitation[] = [];
  const indexMap = new Map<number, number>();
  const remappedSegments = expandedSegments.map((segment) => {
    if (!segment.citationIndices || segment.citationIndices.length === 0) {
      return { text: segment.text };
    }

    const remappedIndices = segment.citationIndices.flatMap((index) => {
      const citation = citationEvidence[index];
      if (!citation) {
        return [];
      }

      let nextIndex = indexMap.get(index);
      if (nextIndex === undefined) {
        nextIndex = citations.length;
        indexMap.set(index, nextIndex);
        citations.push(toChatCitation(citation));
      }

      return [nextIndex];
    });

    return remappedIndices.length > 0
      ? { text: segment.text, citationIndices: remappedIndices }
      : { text: segment.text };
  });

  const mergedSegments: AnswerSegment[] = [];
  for (const segment of remappedSegments) {
    const previous = mergedSegments.at(-1);

    if (
      previous?.citationIndices
      && segment.citationIndices
      && sameCitationIndices(previous.citationIndices, segment.citationIndices)
      && !hasParagraphBreak(segment.text)
    ) {
      previous.text += segment.text;
      continue;
    }

    mergedSegments.push(segment);
  }

  return {
    citations,
    answerSegments: mergedSegments,
  };
};

export const resolveCitationArtifacts = (
  presented: PresentedAnswer,
  normalized: NormalizedPresentedAnswer,
  citationEvidence: CitationEvidence[],
): Pick<PresentedAnswer, "citations" | "answerSegments"> => {
  const hasPresentedArtifacts =
    (presented.citations?.length ?? 0) > 0 &&
    (presented.answerSegments?.length ?? 0) > 0;
  const artifacts = hasPresentedArtifacts
    ? {
        citations: presented.citations ?? [],
        answerSegments: presented.answerSegments ?? [],
      }
    : attachImplicitCitationArtifacts(presented.answerSegments ?? normalized.answerSegments, citationEvidence);

  return {
    citations: artifacts.citations.length > 0 ? artifacts.citations : presented.citations,
    answerSegments: artifacts.answerSegments.length > 0 ? artifacts.answerSegments : presented.answerSegments,
  };
};
