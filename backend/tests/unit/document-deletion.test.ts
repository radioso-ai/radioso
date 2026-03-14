import { describe, expect, it } from "vitest";

import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { createAuditService } from "../support/fakes.js";

describe("document deletion", () => {
  it("deletes an account-scoped document and records a success audit event", async () => {
    const deleted: string[] = [];
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async deleteByIdAndAccountId(documentId: string, accountId: string): Promise<boolean> {
          if (documentId === "doc-1" && accountId === "account-1") {
            deleted.push(documentId);
            return true;
          }

          return false;
        },
      },
      auditService,
    );

    await service.delete({
      accountId: "account-1",
      documentId: "doc-1",
    });

    expect(deleted).toEqual(["doc-1"]);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-1",
        eventType: "document.delete",
        eventStatus: "success",
        metadata: { documentId: "doc-1" },
      }),
    );
  });

  it("throws a not_found error when the document does not belong to the account", async () => {
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async deleteByIdAndAccountId(): Promise<boolean> {
          return false;
        },
      },
      auditService,
    );

    await expect(
      service.delete({
        accountId: "account-2",
        documentId: "doc-missing",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
      message: "Document not found",
    });
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: "account-2",
        eventType: "document.delete",
        eventStatus: "failure",
        metadata: {
          documentId: "doc-missing",
          reason: "not_found",
        },
      }),
    );
  });
});
