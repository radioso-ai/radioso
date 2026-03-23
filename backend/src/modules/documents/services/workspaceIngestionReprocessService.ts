import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";

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
  ) {}

  async reprocessWorkspace(workspaceId: string): Promise<WorkspaceIngestionReprocessResult> {
    const result = await this.documentRepository.requeueAllEligibleAndQueue(workspaceId);
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
}
