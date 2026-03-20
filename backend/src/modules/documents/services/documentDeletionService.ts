import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentRecord } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../infra/gcsDocumentStorage.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";

export interface DocumentDeletionRepositoryPort {
  findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null>;
  deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean>;
}

export class DocumentDeletionService {
  constructor(
    private readonly documentRepository: DocumentDeletionRepositoryPort,
    private readonly documentStorage: DocumentStoragePort,
    private readonly auditService: AuditService,
  ) {}

  async delete(input: { workspaceId: string; documentId: string }): Promise<void> {
    const document = await this.documentRepository.findByIdAndWorkspaceId(input.documentId, input.workspaceId);
    if (!document) {
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

    if (document.sourceKind === "uploaded_file" && document.sourceStorageBucket && document.sourceStorageObject) {
      try {
        await this.documentStorage.delete({
          bucket: document.sourceStorageBucket,
          objectPath: document.sourceStorageObject,
          generation: document.sourceStorageGeneration ?? null,
        });
      } catch (error) {
        await this.auditService.record({
          workspaceId: input.workspaceId,
          eventType: "document.delete",
          eventStatus: "failure",
          metadata: {
            documentId: input.documentId,
            reason: error instanceof Error ? error.message : "stored_source_delete_failed",
          },
        });
        throw new AppError(503, "service_unavailable", "Failed to delete stored document source");
      }
    }

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
