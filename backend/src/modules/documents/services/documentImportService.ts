import { randomUUID } from "node:crypto";

import { detectDocumentType, DocumentParserError } from "@hivec/document-parser";

import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../infra/gcsDocumentStorage.js";
import { badRequest } from "../../../shared/domain/errors.js";

export interface DocumentImportInput {
  workspaceId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  title?: string;
}

const deriveTitleFromFilename = (filename: string): string =>
  filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export class DocumentImportService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly auditService: AuditService,
    private readonly storage: DocumentStoragePort,
  ) {}

  async importDocument(input: DocumentImportInput): Promise<{ documentId: string; status: string }> {
    let storedObject:
      | {
          bucket: string;
          objectPath: string;
          generation?: string | null;
          sizeBytes: number;
        }
      | undefined;
    try {
      if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
        throw badRequest("Uploaded file is empty");
      }

      try {
        detectDocumentType({
          filename: input.filename,
          mimeType: input.mimeType,
        });
      } catch (error) {
        if (error instanceof DocumentParserError) {
          throw badRequest(error.message);
        }
        throw error;
      }

      const storageDocumentId = randomUUID();
      storedObject = await this.storage.upload({
        workspaceId: input.workspaceId,
        documentId: storageDocumentId,
        filename: input.filename,
        mimeType: input.mimeType,
        buffer: input.buffer,
      });
      const title = input.title?.trim() || deriveTitleFromFilename(input.filename) || "Imported document";
      const document = await this.documentRepository.createAndQueue({
        workspaceId: input.workspaceId,
        title,
        sourceContent: "",
        markdownContent: "",
        metadata: {},
        sourceKind: "uploaded_file",
        sourceFilename: input.filename,
        sourceMimeType: input.mimeType,
        sourceStorageBucket: storedObject.bucket,
        sourceStorageObject: storedObject.objectPath,
        sourceStorageGeneration: storedObject.generation ?? null,
        sourceSizeBytes: storedObject.sizeBytes,
      });

      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.import",
        eventStatus: "success",
        metadata: {
          documentId: document.id,
          revision: document.revision,
          sourceKind: document.sourceKind,
        },
      });

      return {
        documentId: document.id,
        status: document.status,
      };
    } catch (error) {
      if (storedObject) {
        try {
          await this.storage.delete({
            bucket: storedObject.bucket,
            objectPath: storedObject.objectPath,
            generation: storedObject.generation ?? null,
          });
        } catch {
          // Best-effort cleanup. The original failure is still surfaced and audited below.
        }
      }
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.import",
        eventStatus: "failure",
        metadata: {
          filename: input.filename,
          reason: error instanceof Error ? error.message : "Document import failed",
        },
      });
      throw error;
    }
  }
}
