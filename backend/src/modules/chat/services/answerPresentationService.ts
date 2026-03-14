export interface ChatCitation {
  documentId: string;
  chunkId: string;
  title: string;
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
    citations: ChatCitation[];
    citationDisplayEnabled: boolean;
  }): PresentedAnswer {
    const answer = input.answer.trim();

    if (!input.citationDisplayEnabled) {
      return { answer };
    }

    const citations = this.deduplicateCitations(input.citations);
    if (citations.length === 0) {
      return { answer };
    }

    return {
      answer,
      citations,
      answerSegments: [
        {
          text: answer,
          citationIndices: citations.map((_, index) => index),
        },
      ],
    };
  }

  private deduplicateCitations(citations: ChatCitation[]): ChatCitation[] {
    const seen = new Set<string>();
    const deduped: ChatCitation[] = [];

    for (const citation of citations) {
      const key = `${citation.documentId}:${citation.chunkId}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(citation);
    }

    return deduped;
  }
}
