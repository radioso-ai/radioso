import { CitationAnchorParser, stripCitationAnchorsForDisplay } from "./citationAnchorParser.js";

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
  private readonly citationAnchorParser = new CitationAnchorParser();

  present(input: {
    answer: string;
    citations: CitationEvidence[];
    citationDisplayEnabled: boolean;
  }): PresentedAnswer {
    const answer = input.answer ?? "";
    const contexts = input.citations ?? [];

    // Always strip anchor syntax from the returned answer so clients never see placeholders.
    const sanitizedAnswer = stripCitationAnchorsForDisplay(answer);

    if (!input.citationDisplayEnabled) {
      return { answer: sanitizedAnswer };
    }

    if (contexts.length === 0) {
      return { answer: sanitizedAnswer };
    }

    const presented = this.citationAnchorParser.present({ answer, citations: contexts });

    // The parser already strips anchors for display. Ensure the answer is always sanitized.
    return presented.citations && presented.answerSegments
      ? presented
      : { answer: sanitizedAnswer };
  }
}
