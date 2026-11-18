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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metadataField = (metadata: unknown, key: string): unknown => (isRecord(metadata) ? metadata[key] : undefined);

/** The citations a stored reply's metadata keeps; entries that are not citations are dropped, and none read as undefined. */
export const storedCitations = (metadata: unknown): ChatCitation[] | undefined => {
  const raw = metadataField(metadata, "citations");
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const citations = raw.flatMap((value): ChatCitation[] => {
    if (!isRecord(value)) {
      return [];
    }
    const { documentId, chunkId, title, sourceUrl } = value;
    if (typeof documentId !== "string" || typeof chunkId !== "string" || typeof title !== "string") {
      return [];
    }
    return [{
      documentId,
      chunkId,
      title,
      ...(typeof sourceUrl === "string" && sourceUrl.length > 0 ? { sourceUrl } : {}),
    }];
  });
  return citations.length > 0 ? citations : undefined;
};

/** The text runs a stored reply's metadata keeps, each with its valid citation indices; none read as undefined. */
export const storedAnswerSegments = (metadata: unknown): AnswerSegment[] | undefined => {
  const raw = metadataField(metadata, "answerSegments");
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const segments = raw.flatMap((value): AnswerSegment[] => {
    if (!isRecord(value) || typeof value.text !== "string") {
      return [];
    }
    const citationIndices = Array.isArray(value.citationIndices)
      ? value.citationIndices.filter((index): index is number => Number.isInteger(index) && index >= 0)
      : undefined;
    return [{
      text: value.text,
      ...(citationIndices && citationIndices.length > 0 ? { citationIndices } : {}),
    }];
  });
  return segments.length > 0 ? segments : undefined;
};
