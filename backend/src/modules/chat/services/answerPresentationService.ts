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

export class AnswerPresentationService {
  present(input: {
    answer: string;
    citations: CitationEvidence[];
    citationDisplayEnabled: boolean;
  }): PresentedAnswer {
    const normalized = this.normalizeAnchoredAnswer(input.answer.trim(), input.citations);

    if (!input.citationDisplayEnabled || normalized.citations.length === 0) {
      return { answer: normalized.answer };
    }

    return {
      answer: normalized.answer,
      citations: normalized.citations,
      answerSegments: normalized.answerSegments,
    };
  }

  private normalizeAnchoredAnswer(answer: string, citations: CitationEvidence[]): {
    answer: string;
    citations: ChatCitation[];
    answerSegments: AnswerSegment[];
  } {
    const anchorGroups = findCitationAnchorGroups(answer);
    const visibleCitations: ChatCitation[] = [];
    const citationIndexByDocument = new Map<string, number>();
    const answerSegments: AnswerSegment[] = [];

    let answerText = "";
    let currentText = "";
    let lastIndex = 0;

    const pushSegment = (text: string, citationIndices?: number[]) => {
      if (text.length === 0) {
        return;
      }

      const segment = citationIndices && citationIndices.length > 0
        ? { text, citationIndices }
        : { text };
      answerSegments.push(segment);
      answerText += text;
    };

    const resolveCitationIndices = (resultNumbers: number[]): number[] => {
      const resolved: number[] = [];

      for (const resultNumber of resultNumbers) {
        const citation = citations[resultNumber - 1];
        if (!citation) {
          continue;
        }

        let citationIndex = citationIndexByDocument.get(citation.documentId);
        if (citationIndex === undefined) {
          citationIndex = visibleCitations.length;
          citationIndexByDocument.set(citation.documentId, citationIndex);
          visibleCitations.push({
            documentId: citation.documentId,
            chunkId: citation.chunkId,
            title: citation.title,
          });
        }

        if (!resolved.includes(citationIndex)) {
          resolved.push(citationIndex);
        }
      }

      return resolved;
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
      citations: visibleCitations,
      answerSegments,
    };
  }
}
