export interface ChatCitation {
  documentId: string;
  chunkId: string;
  title: string;
  sourceUrl?: string;
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
