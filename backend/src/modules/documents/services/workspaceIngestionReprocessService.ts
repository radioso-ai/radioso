import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentProcessingJobRepositoryPort } from "../../../db/repositories/documentProcessingJobRepository.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";

export interface WorkspaceIngestionReprocessResult {
  workspaceId: string;
  queuedDocumentCount: number;
  skippedDocumentCount: number;
  status: "queued" | "noop";
}

export class WorkspaceIngestionReprocessService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly auditService: AuditService,
    private readonly jobRepository?: Pick<DocumentProcessingJobRepositoryPort, "findByDocumentRevision">,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
  ) {}

  async reprocessWorkspace(workspaceId: string): Promise<WorkspaceIngestionReprocessResult> {
    const result = await this.documentRepository.requeueAllEligibleAndQueue(workspaceId);
    await this.dispatchQueuedJobs(workspaceId, result.queuedDocuments);
    await this.auditService.record({
      workspaceId,
      eventType: "document.reprocess_workspace",
      eventStatus: "success",
      metadata: result,
    });

    return {
      workspaceId,
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
        throw error;
      }
    }
  }
}
