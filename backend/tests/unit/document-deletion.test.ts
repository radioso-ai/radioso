import { describe, expect, it } from "vitest";

import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { createAuditService } from "../support/fakes.js";

describe("document deletion", () => {
  it("deletes a workspace-scoped document and records a success audit event", async () => {
    const deleted: string[] = [];
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean> {
          if (documentId === "doc-1" && workspaceId === "workspace-1") {
            deleted.push(documentId);
            return true;
          }

          return false;
        },
      },
      auditService,
    );

    await service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    });

    expect(deleted).toEqual(["doc-1"]);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.delete",
        eventStatus: "success",
        metadata: { documentId: "doc-1" },
      }),
    );
  });

  it("throws a not_found error when the document does not belong to the workspace", async () => {
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async deleteByIdAndWorkspaceId(): Promise<boolean> {
          return false;
        },
      },
      auditService,
    );

    await expect(
      service.delete({
        workspaceId: "workspace-2",
        documentId: "doc-missing",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
      message: "Document not found",
    });
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-2",
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
