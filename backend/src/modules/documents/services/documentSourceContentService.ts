import { parseDocument, type ParsedDocument } from "@hivec/document-parser";

import type { DocumentRecord } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../infra/gcsDocumentStorage.js";

export interface MaterializedDocumentContent {
  sourceContent: string;
  markdownContent: string;
}

type DocumentParser = (input: {
  buffer: Buffer;
  filename?: string | null;
  mimeType?: string | null;
}) => Promise<ParsedDocument>;

export class DocumentSourceContentService {
  constructor(
    private readonly storage: DocumentStoragePort,
    private readonly parser: DocumentParser = parseDocument,
  ) {}

  async materialize(document: DocumentRecord): Promise<MaterializedDocumentContent> {
    if (document.sourceKind === "inline_text") {
      return {
        sourceContent: document.sourceContent,
        markdownContent: document.markdownContent,
      };
    }

    if (!document.sourceStorageBucket || !document.sourceStorageObject) {
      throw new Error("Uploaded document is missing storage metadata");
    }

    const buffer = await this.storage.read({
      bucket: document.sourceStorageBucket,
      objectPath: document.sourceStorageObject,
      generation: document.sourceStorageGeneration ?? null,
    });
    const parsed = await this.parser({
      buffer,
      filename: document.sourceFilename,
      mimeType: document.sourceMimeType,
    });

    return {
      sourceContent: parsed.text,
      markdownContent: parsed.markdown,
    };
  }
}
