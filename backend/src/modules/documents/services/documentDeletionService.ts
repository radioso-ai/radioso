import type { AuditService } from "../../audit/services/auditService.js";
import { notFound } from "../../../shared/domain/errors.js";

export interface DocumentDeletionRepositoryPort {
  deleteByIdAndAccountId(documentId: string, accountId: string): Promise<boolean>;
}

export class DocumentDeletionService {
  constructor(
    private readonly documentRepository: DocumentDeletionRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  async delete(input: { accountId: string; documentId: string }): Promise<void> {
    const deleted = await this.documentRepository.deleteByIdAndAccountId(input.documentId, input.accountId);

    if (!deleted) {
      await this.auditService.record({
        accountId: input.accountId,
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
      accountId: input.accountId,
      eventType: "document.delete",
      eventStatus: "success",
      metadata: {
        documentId: input.documentId,
      },
    });
  }
}
