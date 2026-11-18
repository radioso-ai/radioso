/**
 * A source an answer cites, as a reply carries it to whoever shows it: live chat, the history
 * reads, and Test Chat, which keeps a test turn's sources beside its answer.
 */
export interface ChatCitation {
  documentId: string;
  chunkId: string;
  title: string;
  sourceUrl?: string;
}

/** A run of an answer's text, with the indices into the reply's citations that the run rests on. */
export interface AnswerSegment {
  text: string;
  citationIndices?: number[];
}
