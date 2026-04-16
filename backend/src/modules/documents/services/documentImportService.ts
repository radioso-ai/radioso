import { randomUUID } from "node:crypto";

import { detectDocumentType, DocumentParserError } from "@radioso/document-parser";

import type { AuditService } from "../../audit/services/auditService.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
  DocumentProcessingQueueSnapshot,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../infra/gcsDocumentStorage.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";

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
    private readonly getQueueSnapshot?: () => Promise<DocumentProcessingQueueSnapshot>,
    private readonly jobRepository?: Pick<DocumentProcessingJobRepositoryPort, "findByDocumentRevision">,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
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
    let document:
      | {
          id: string;
          revision: number;
          sourceKind: string;
          status: string;
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
      document = await this.documentRepository.createAndQueue({
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

    } catch (error) {
      if (storedObject && !document) {
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

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.import",
      eventStatus: "success",
      metadata: {
        documentId: document.id,
        revision: document.revision,
        sourceKind: document.sourceKind,
        ...(await this.queueSnapshotMetadata()),
      },
    });
    await this.dispatchQueuedDocumentJob({
      documentId: document.id,
      workspaceId: input.workspaceId,
      revision: document.revision,
    });

    return {
      documentId: document.id,
      status: document.status,
    };
  }

  private async queueSnapshotMetadata(): Promise<{
    queuedJobCount?: number;
    processingJobCount?: number;
  }> {
    if (!this.getQueueSnapshot) {
      return {};
    }

    try {
      const snapshot = await this.getQueueSnapshot();
      return {
        queuedJobCount: snapshot.queuedJobCount,
        processingJobCount: snapshot.processingJobCount,
      };
    } catch {
      // Queue-depth metadata is best-effort observability and must not change import outcomes.
      return {};
    }
  }

  private async dispatchQueuedDocumentJob(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
  }): Promise<void> {
    if (!this.jobRepository) {
      return;
    }

    try {
      const job = await this.jobRepository.findByDocumentRevision({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        documentRevision: input.revision,
      });
      if (!job) {
        return;
      }
      await this.jobDispatcher.dispatch(this.toDispatchRequest(job));
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.dispatch",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          revision: input.revision,
          reason: error instanceof Error ? error.message : "Failed to dispatch document processing job",
        },
      });
    }
  }

  private toDispatchRequest(job: DocumentProcessingJobRecord) {
    return {
      jobId: job.id,
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      revision: job.documentRevision,
    };
  }
}
