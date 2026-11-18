import type { AnswerSegment, ChatCitation } from "../../../shared/domain/answerCitation.js";

export type { AnswerSegment, ChatCitation };

export interface CitationEvidence extends ChatCitation {
  content: string;
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
