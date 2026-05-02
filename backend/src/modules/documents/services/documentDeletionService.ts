import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentRecord } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../infra/gcsDocumentStorage.js";
import { capabilityNames, DefaultAllowCapabilityPolicy, type CapabilityPolicy } from "../../capabilities/capabilityPolicy.js";
import { forbidden, notFound } from "../../../shared/domain/errors.js";

export interface DocumentDeletionRepositoryPort {
  findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null>;
  deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean>;
}

export class DocumentDeletionService {
  constructor(
    private readonly documentRepository: DocumentDeletionRepositoryPort,
    private readonly documentStorage: DocumentStoragePort,
    private readonly auditService: AuditService,
    private readonly capabilityPolicy: CapabilityPolicy = new DefaultAllowCapabilityPolicy(),
  ) {}

  async delete(input: { workspaceId: string; documentId: string }): Promise<void> {
    const capability = await this.capabilityPolicy.can({
      capability: capabilityNames.documents.delete,
      workspaceId: input.workspaceId,
      subjectId: input.documentId,
    });
    if (!capability.allowed) {
      throw forbidden("Capability is not available");
    }

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

    let sourceCleanupFailed = false;
    let sourceCleanupReason: string | undefined;

    if (document.sourceKind === "uploaded_file" && document.sourceStorageBucket && document.sourceStorageObject) {
      try {
        await this.documentStorage.delete({
          bucket: document.sourceStorageBucket,
          objectPath: document.sourceStorageObject,
          generation: document.sourceStorageGeneration ?? null,
        });
      } catch (error) {
        sourceCleanupFailed = true;
        sourceCleanupReason = error instanceof Error ? error.message : "stored_source_delete_failed";
      }
    }

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.delete",
      eventStatus: sourceCleanupFailed ? "failure" : "success",
      metadata: {
        documentId: input.documentId,
        ...(sourceCleanupFailed ? { reason: sourceCleanupReason } : {}),
      },
    });

  }
}
