import { randomUUID } from "node:crypto";

import { detectDocumentType, DocumentParserError } from "@radioso/document-parser";

import type { AuditService } from "../../audit/contracts/index.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
  DocumentProcessingQueueSnapshot,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import type { DocumentProcessingJobOptions } from "../contracts/documentContracts.js";
import { buildDocumentProcessingOptions, type DocumentRepositoryPort } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../contracts/storage.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  toDocumentSourceSummary,
  type DocumentSourceRepositoryPort,
} from "../../../db/repositories/documentSourceRepository.js";
import {
  NoopUsageLimitPolicy,
  type UsageLimitPolicy,
  type UsageLimitReservation,
} from "../../../shared/domain/usageLimitPolicy.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";

export interface DocumentImportInput {
  workspaceId: string;
  accountId?: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  title?: string;
  metadata?: Record<string, unknown>;
  usageReservation?: UsageLimitReservation;
  documentEnrichmentOverride?: DocumentProcessingJobOptions["documentEnrichmentOverride"];
}

// Capitalize the first character of each whitespace-delimited word so a derived
// title like "shipping faq" reads as "Shipping Faq" instead of looking broken.
// Uses locale-aware casing and is a no-op for scripts without case distinctions.
const toTitleCase = (value: string): string =>
  value
    .split(" ")
    .map((word) => (word ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : word))
    .join(" ");

const deriveTitleFromFilename = (filename: string): string =>
  toTitleCase(
    filename
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

export class DocumentImportService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly auditService: AuditService,
    private readonly storage: DocumentStoragePort,
    private readonly getQueueSnapshot?: () => Promise<DocumentProcessingQueueSnapshot>,
    private readonly jobRepository?: Pick<DocumentProcessingJobRepositoryPort, "findByDocumentRevision">,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
    private readonly usageLimitPolicy: UsageLimitPolicy = new NoopUsageLimitPolicy(),
    private readonly documentSourceRepository?: DocumentSourceRepositoryPort,
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
    const usageReservation = input.usageReservation
      ?? await this.usageLimitPolicy.reserveDocument({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceKind: "uploaded_file",
      });
    let storageReservation: UsageLimitReservation | undefined;
    let monthlyReservation: UsageLimitReservation | undefined;
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
      // Stored object size is authoritative for uploaded-file storage metering;
      // adapters may transform payloads before persistence.
      storageReservation = await this.usageLimitPolicy.reserveIndexedStorage({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        contentSizeBytes: storedObject.sizeBytes,
        sourceKind: "uploaded_file",
      });
      monthlyReservation = await this.usageLimitPolicy.reserveMonthlyIndexedContent({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        contentSizeBytes: storedObject.sizeBytes,
        sourceKind: "uploaded_file",
      });
      const title = input.title?.trim() || deriveTitleFromFilename(input.filename) || "Imported document";
      const source = await this.resolveUploadSource(input.workspaceId);
      document = await this.documentRepository.createAndQueue({
        workspaceId: input.workspaceId,
        title,
        sourceContent: "",
        markdownContent: "",
        metadata: input.metadata ?? {},
        sourceId: source?.id ?? null,
        source: source ? toDocumentSourceSummary(source) : null,
        sourceKind: "uploaded_file",
        sourceFilename: input.filename,
        sourceMimeType: input.mimeType,
        sourceStorageBucket: storedObject.bucket,
        sourceStorageObject: storedObject.objectPath,
        sourceStorageGeneration: storedObject.generation ?? null,
        sourceSizeBytes: storedObject.sizeBytes,
        contentSizeBytes: storedObject.sizeBytes,
      }, buildDocumentProcessingOptions(input));

    } catch (error) {
      await usageReservation.release();
      if (storageReservation) {
        await storageReservation.release();
      }
      if (monthlyReservation) {
        await monthlyReservation.release();
      }
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
    await usageReservation.commit();
    if (storageReservation) {
      await storageReservation.commit();
    }
    if (monthlyReservation) {
      await monthlyReservation.commit();
    }

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

  private async resolveUploadSource(workspaceId: string) {
    if (!this.documentSourceRepository) {
      return null;
    }
    return this.documentSourceRepository.upsertByExternalId({
      workspaceId,
      kind: "upload",
      name: "Uploads",
      externalId: "workspace-uploads",
      config: {},
      metadata: {},
    });
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
