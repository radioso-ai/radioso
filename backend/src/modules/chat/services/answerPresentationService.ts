import { findCitationAnchorGroups, stripResidualCitationSyntax } from "./citationAnchorParser.js";
import { hasUnsupportedNoticeMarker, stripUnsupportedNoticeMarker } from "./unsupportedNoticeMarker.js";
import type {
  AnswerSegment,
  ChatCitation,
  CitationEvidence,
  NormalizedPresentedAnswer,
  PresentedAnswer,
} from "../contracts/answerTypes.js";

export const remapAnswerSegmentsToCitationEvidence = (
  answerSegments: AnswerSegment[],
  visibleCitationEvidence: CitationEvidence[],
  targetCitationEvidence: CitationEvidence[],
): AnswerSegment[] => {
  const targetIndexByDocumentId = new Map<string, number>();

  for (const [index, citation] of targetCitationEvidence.entries()) {
    if (!targetIndexByDocumentId.has(citation.documentId)) {
      targetIndexByDocumentId.set(citation.documentId, index);
    }
  }

  return answerSegments.map((segment) => {
    if (!segment.citationIndices || segment.citationIndices.length === 0) {
      return { text: segment.text };
    }

    const remappedIndices = [...new Set(segment.citationIndices.flatMap((index) => {
      const citation = visibleCitationEvidence[index];
      if (!citation) {
        return [];
      }

      const remappedIndex = targetIndexByDocumentId.get(citation.documentId);
      return remappedIndex === undefined ? [] : [remappedIndex];
    }))];

    return remappedIndices.length > 0
      ? { text: segment.text, citationIndices: remappedIndices }
      : { text: segment.text };
  });
};

const hasParagraphBreak = (text: string): boolean => /\r?\n\r?\n/.test(text);

const sameCitationIndices = (left?: number[], right?: number[]): boolean => {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
};

const toChatCitation = (citation: CitationEvidence): ChatCitation => ({
  documentId: citation.documentId,
  chunkId: citation.chunkId,
  title: citation.title,
});

export class AnswerPresentationService {
  normalize(input: {
    answer: string;
    citations: CitationEvidence[];
  }): NormalizedPresentedAnswer {
    const trimmedAnswer = input.answer.trim();
    return {
      ...this.normalizeAnchoredAnswer(stripUnsupportedNoticeMarker(trimmedAnswer), input.citations),
      unsupportedNoticeMarked: hasUnsupportedNoticeMarker(trimmedAnswer),
    };
  }

  present(input: {
    answer: string;
    citations: CitationEvidence[];
    citationDisplayEnabled: boolean;
  }): PresentedAnswer {
    const normalized = this.normalize({
      answer: input.answer,
      citations: input.citations,
    });

    if (!input.citationDisplayEnabled || normalized.citationEvidence.length === 0) {
      return { answer: normalized.answer };
    }

    return {
      answer: normalized.answer,
      citations: normalized.citationEvidence.map((citation) => toChatCitation(citation)),
      answerSegments: normalized.answerSegments,
    };
  }

  private normalizeAnchoredAnswer(answer: string, citations: CitationEvidence[]): {
    answer: string;
    citationEvidence: CitationEvidence[];
    answerSegments: AnswerSegment[];
  } {
    const anchorGroups = findCitationAnchorGroups(answer);
    const visibleCitations: CitationEvidence[] = [];
    const citationIndexByDocument = new Map<string, number>();
    const answerSegments: AnswerSegment[] = [];

    let answerText = "";
    let currentText = "";
    let lastIndex = 0;

    const pushSegment = (text: string, citationIndices?: number[]) => {
      if (text.length === 0) {
        return;
      }

      const previousSegment = answerSegments.at(-1);
      if (
        citationIndices &&
        citationIndices.length > 0 &&
        previousSegment?.citationIndices &&
        sameCitationIndices(previousSegment.citationIndices, citationIndices) &&
        !hasParagraphBreak(text)
      ) {
        previousSegment.text += text;
        answerText += text;
        return;
      }

      const segment = citationIndices && citationIndices.length > 0
        ? { text, citationIndices }
        : { text };
      answerSegments.push(segment);
      answerText += text;
    };

    const resolveCitationIndices = (resultNumbers: number[]): number[] => {
      const resolvedIndices: number[] = [];

      for (const resultNumber of resultNumbers) {
        const citation = citations[resultNumber - 1];
        if (!citation) {
          continue;
        }

        let citationIndex = citationIndexByDocument.get(citation.documentId);
        if (citationIndex === undefined) {
          citationIndex = visibleCitations.length;
          citationIndexByDocument.set(citation.documentId, citationIndex);
          visibleCitations.push(citation);
        }

        if (!resolvedIndices.includes(citationIndex)) {
          resolvedIndices.push(citationIndex);
        }
      }

      return resolvedIndices;
    };

    for (const anchorGroup of anchorGroups) {
      currentText += stripResidualCitationSyntax(answer.slice(lastIndex, anchorGroup.start));

      const citationIndices = resolveCitationIndices(anchorGroup.resultNumbers);
      const match = currentText.match(/^(.*?)(\s*)$/s);
      const coreText = match?.[1] ?? currentText;
      const trailingWhitespace = match?.[2] ?? "";

      if (citationIndices.length > 0 && coreText.length > 0) {
        pushSegment(coreText, citationIndices);
        currentText = trailingWhitespace;
      } else {
        currentText = `${coreText}${trailingWhitespace}`;
      }

      lastIndex = anchorGroup.end;
    }

    currentText += stripResidualCitationSyntax(answer.slice(lastIndex));
    pushSegment(currentText);

    return {
      answer: answerText,
      citationEvidence: visibleCitations,
      answerSegments,
    };
  }
}
