import type { DocumentImageEvidenceReader } from "../../documents/contracts/index.js";
import {
  PRIMARY_DOCUMENT_COUNT_LIMIT,
  assignEvidenceImages,
  type EvidenceContext,
  type EvidenceItemImages,
} from "../domain/evidenceImages.js";

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Reads the stored images an answer's evidence carries. One indexed read per turn; composition
 * binds the reader to the documents' image rows.
 */
export class EvidenceImageAttacher {
  constructor(private readonly reader: DocumentImageEvidenceReader) {}

  async attach(workspaceId: string, contexts: readonly EvidenceContext[]): Promise<EvidenceItemImages[]> {
    if (contexts.length === 0) {
      return [];
    }
    const rows = await this.reader.listStoredForEvidence({
      workspaceId,
      documentIds: unique(contexts.map((context) => context.documentId)),
      chunkIds: unique(contexts.map((context) => context.chunkId)),
      primaryDocumentCountLimit: PRIMARY_DOCUMENT_COUNT_LIMIT,
    });
    return assignEvidenceImages(contexts, rows);
  }
}
