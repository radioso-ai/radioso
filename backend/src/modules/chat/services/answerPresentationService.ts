import { findCitationAnchorGroups, stripResidualCitationSyntax } from "./citationAnchorParser.js";

export interface ChatCitation {
  documentId: string;
  chunkId: string;
  title: string;
}

export interface CitationEvidence extends ChatCitation {
  content: string;
}

export interface AnswerSegment {
  text: string;
  citationIndices?: number[];
}

export interface PresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

export interface NormalizedPresentedAnswer {
  answer: string;
  citationEvidence: CitationEvidence[];
  answerSegments: AnswerSegment[];
}

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
    return this.normalizeAnchoredAnswer(input.answer.trim(), input.citations);
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

        return [citationIndex];
      }

      return [];
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
