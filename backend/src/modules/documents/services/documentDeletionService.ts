import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import type { AuditService } from "../../audit/contracts/index.js";
import type { DocumentRecord } from "./documentIngestionService.js";
import type { DocumentStoragePort } from "../contracts/storage.js";
import { capabilityNames, DefaultAllowCapabilityPolicy, type CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import { conflict, forbidden, notFound } from "../../../shared/domain/errors.js";

export interface DocumentDeletionRepositoryPort {
  findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null>;
  deleteByIdAndWorkspaceId(documentId: string, workspaceId: string, options?: { expectedUpdatedAt?: Date }): Promise<boolean>;
}

export class DocumentDeletionService {
  constructor(
    private readonly documentRepository: DocumentDeletionRepositoryPort,
    private readonly documentStorage: DocumentStoragePort,
    private readonly auditService: AuditService,
    private readonly capabilityPolicy: CapabilityPolicy = new DefaultAllowCapabilityPolicy(),
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
  ) {}

  /**
   * `expectedUpdatedAt` is the version the caller read. Present, it becomes the delete's own
   * predicate: a document edited since is refused rather than removed on the strength of a
   * snapshot that no longer describes it.
   */
  async delete(input: { workspaceId: string; documentId: string; expectedUpdatedAt?: Date }): Promise<void> {
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

    const deleted = await this.documentRepository.deleteByIdAndWorkspaceId(
      input.documentId,
      input.workspaceId,
      input.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: input.expectedUpdatedAt } : undefined,
    );

    if (!deleted) {
      // Only the version predicate can refuse a document the read above found, so a row still
      // there is a concurrent edit rather than a target that vanished.
      const stillPresent = input.expectedUpdatedAt !== undefined
        && await this.documentRepository.findByIdAndWorkspaceId(input.documentId, input.workspaceId) !== null;
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.delete",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: stillPresent ? "version_conflict" : "not_found",
        },
      });
      throw stillPresent
        ? conflict("Document was updated by another writer; reload before saving again")
        : notFound("Document not found");
    }

    this.workspaceInvalidationPublisher.enqueue(input.workspaceId, ["document.status_changed"]);
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
