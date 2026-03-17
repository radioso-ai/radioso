import type { AuditService } from "../../audit/services/auditService.js";
import { notFound } from "../../../shared/domain/errors.js";

export interface DocumentDeletionRepositoryPort {
  deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean>;
}

export class DocumentDeletionService {
  constructor(
    private readonly documentRepository: DocumentDeletionRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  async delete(input: { workspaceId: string; documentId: string }): Promise<void> {
    const deleted = await this.documentRepository.deleteByIdAndWorkspaceId(input.documentId, input.workspaceId);

    if (!deleted) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.delete",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: "not_found",
        },
      });
      throw notFound("Document not found");
    }

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.delete",
      eventStatus: "success",
      metadata: {
        documentId: input.documentId,
      },
    });
  }
}
