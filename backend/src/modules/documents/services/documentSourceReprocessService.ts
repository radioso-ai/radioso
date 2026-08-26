import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";
import type {
  DocumentProcessingJobRepositoryPort,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import type { DocumentProcessingJobOptions } from "../contracts/documentContracts.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { notFound } from "../../../shared/domain/errors.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";
import { buildDocumentProcessingOptions } from "./documentIngestionService.js";

export interface DocumentSourceReprocessResult {
  workspaceId: string;
  /** null identifies the manually added documents, which have no source row. */
  sourceId: string | null;
  queuedDocumentCount: number;
  skippedDocumentCount: number;
  status: "queued" | "noop";
}

export class DocumentSourceReprocessService {
  constructor(
    private readonly documentRepository: Pick<DocumentRepositoryPort, "requeueSourceEligibleAndQueue">,
    private readonly sourceRepository: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">,
    private readonly auditService: AuditService,
    private readonly jobRepository?: Pick<DocumentProcessingJobRepositoryPort, "findByDocumentRevision">,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
  ) {}

  async reprocessSource(input: {
    workspaceId: string;
    /**
     * null reprocesses the manually added documents. They have no
     * document_sources row, so there is no source existence to check.
     */
    sourceId: string | null;
    documentEnrichmentOverride?: DocumentProcessingJobOptions["documentEnrichmentOverride"];
  }): Promise<DocumentSourceReprocessResult> {
    if (input.sourceId !== null) {
      const source = await this.sourceRepository.findByIdAndWorkspaceId(input.sourceId, input.workspaceId);
      if (!source) {
        throw notFound("Source not found");
      }
    }

    const options = buildDocumentProcessingOptions(input);
    const result = await this.documentRepository.requeueSourceEligibleAndQueue({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      options,
    });

    if (result.queuedDocumentCount > 0) {
      this.workspaceInvalidationPublisher.enqueue(input.workspaceId, ["document.status_changed"]);
    }
    await this.dispatchQueuedJobs(input.workspaceId, result.queuedDocuments);
    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.reprocess_source",
      eventStatus: "success",
      metadata: {
        sourceId: input.sourceId,
        queuedDocumentCount: result.queuedDocumentCount,
        skippedDocumentCount: result.skippedDocumentCount,
        documentEnrichmentOverride: input.documentEnrichmentOverride ?? null,
      },
    });

    return {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      queuedDocumentCount: result.queuedDocumentCount,
      skippedDocumentCount: result.skippedDocumentCount,
      status: result.queuedDocumentCount > 0 ? "queued" : "noop",
    };
  }

  private async dispatchQueuedJobs(
    workspaceId: string,
    queuedDocuments: Array<{ documentId: string; revision: number }>,
  ): Promise<void> {
    if (!this.jobRepository || queuedDocuments.length === 0) {
      return;
    }

    for (const queuedDocument of queuedDocuments) {
      try {
        const job = await this.jobRepository.findByDocumentRevision({
          documentId: queuedDocument.documentId,
          workspaceId,
          documentRevision: queuedDocument.revision,
        });
        if (!job) {
          continue;
        }
        await this.jobDispatcher.dispatch({
          jobId: job.id,
          documentId: job.documentId,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
        });
      } catch (error) {
        await this.auditService.record({
          workspaceId,
          eventType: "document.dispatch",
          eventStatus: "failure",
          metadata: {
            documentId: queuedDocument.documentId,
            revision: queuedDocument.revision,
            reason: error instanceof Error ? error.message : "Failed to dispatch document processing job",
          },
        });
      }
    }
  }
}
