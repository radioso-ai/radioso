import type { AnswerSegment, CitationEvidence } from "../contracts/answerTypes.js";

export interface ImplicitCitationDiagnostics {
  eligibleSegmentCount: number;
  implicitMatchCount: number;
  explicitlyAssertedCount: number;
}

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
    if (normalized.length >= 4) {
      terms.push(normalized);
    }
  }
  return [...new Set(terms)];
};

const normalizeComparableText = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const splitIntoSentenceLikeSegments = (value: string): string[] => {
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
  return segments.join("") === value ? segments : [value];
};

const hasImplicitMatch = (text: string, citationEvidence: readonly CitationEvidence[]): boolean => {
  const segmentTerms = extractSignificantTerms(text);
  if (segmentTerms.length < 3) {
    const normalizedText = normalizeComparableText(text);
    return citationEvidence.some((citation) =>
      normalizeComparableText(`${citation.title} ${citation.content}`).includes(normalizedText),
    );
  }

  const scores = citationEvidence
    .map((citation) => {
      const citationTerms = new Set(extractSignificantTerms(`${citation.title} ${citation.content}`));
      const matchedTerms = segmentTerms.filter((term) => citationTerms.has(term));
      return { matches: matchedTerms.length, ratio: matchedTerms.length / segmentTerms.length };
    })
    .filter((score) => score.matches >= 2)
    .sort((left, right) => right.ratio - left.ratio || right.matches - left.matches);
  const best = scores[0];
  const second = scores[1];
  if (!best || best.ratio < 0.5) {
    return false;
  }
  return !(second && best.ratio < 0.7 && best.matches <= second.matches);
};

export const diagnoseImplicitCitationSupport = (
  answerSegments: readonly AnswerSegment[],
  citationEvidence: readonly CitationEvidence[],
): ImplicitCitationDiagnostics => {
  let eligibleSegmentCount = 0;
  let implicitMatchCount = 0;
  let explicitlyAssertedCount = 0;

  try {
    for (const segment of answerSegments) {
      if ((segment.citationIndices?.length ?? 0) > 0) {
        explicitlyAssertedCount += 1;
        continue;
      }
      for (const sentence of splitIntoSentenceLikeSegments(segment.text)) {
        if (!hasWordLikeContent(sentence)) {
          continue;
        }
        eligibleSegmentCount += 1;
        if (hasImplicitMatch(sentence, citationEvidence)) {
          implicitMatchCount += 1;
        }
      }
    }
  } catch {
    return { eligibleSegmentCount: 0, implicitMatchCount: 0, explicitlyAssertedCount };
  }

  return { eligibleSegmentCount, implicitMatchCount, explicitlyAssertedCount };
};
