import { describe, expect, it } from "vitest";

import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { createAuditService } from "../support/fakes.js";

describe("document deletion", () => {
  it("deletes a workspace-scoped document and records a success audit event", async () => {
    const deleted: string[] = [];
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId(documentId: string, workspaceId: string) {
          if (documentId !== "doc-1" || workspaceId !== "workspace-1") {
            return null;
          }

          return {
            id: "doc-1",
            workspaceId: "workspace-1",
            title: "Inline",
            sourceContent: "Inline body",
            markdownContent: "Inline body",
            metadata: {},
            sourceKind: "inline_text" as const,
            sourceFilename: null,
            sourceMimeType: "text/plain",
            sourceStorageBucket: null,
            sourceStorageObject: null,
            sourceStorageGeneration: null,
            sourceSizeBytes: null,
            status: "ready",
            revision: 1,
            failureReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        async deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean> {
          if (documentId === "doc-1" && workspaceId === "workspace-1") {
            deleted.push(documentId);
            return true;
          }

          return false;
        },
      },
      {
        async upload() {
          throw new Error("unused");
        },
        async read() {
          throw new Error("unused");
        },
        async delete() {
          throw new Error("unused");
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

  it("deletes a stored source object before removing an uploaded document", async () => {
    const deletedObjects: string[] = [];
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId(documentId: string, workspaceId: string) {
          if (documentId !== "doc-1" || workspaceId !== "workspace-1") {
            return null;
          }

          return {
            id: "doc-1",
            workspaceId: "workspace-1",
            title: "Imported",
            sourceContent: "",
            markdownContent: "",
            metadata: {},
            sourceKind: "uploaded_file" as const,
            sourceFilename: "import.txt",
            sourceMimeType: "text/plain",
            sourceStorageBucket: "bucket",
            sourceStorageObject: "objects/doc-1",
            sourceStorageGeneration: "1",
            sourceSizeBytes: 12,
            status: "ready",
            revision: 1,
            failureReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        async deleteByIdAndWorkspaceId() {
          return true;
        },
      },
      {
        async upload() {
          throw new Error("unused");
        },
        async read() {
          throw new Error("unused");
        },
        async delete(input) {
          deletedObjects.push(input.objectPath);
        },
      },
      auditService,
    );

    await service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    });

    expect(deletedObjects).toEqual(["objects/doc-1"]);
  });

  it("fails safely when uploaded document source cleanup fails", async () => {
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId() {
          return {
            id: "doc-1",
            workspaceId: "workspace-1",
            title: "Imported",
            sourceContent: "",
            markdownContent: "",
            metadata: {},
            sourceKind: "uploaded_file" as const,
            sourceFilename: "import.txt",
            sourceMimeType: "text/plain",
            sourceStorageBucket: "bucket",
            sourceStorageObject: "objects/doc-1",
            sourceStorageGeneration: "1",
            sourceSizeBytes: 12,
            status: "ready",
            revision: 1,
            failureReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        async deleteByIdAndWorkspaceId() {
          return true;
        },
      },
      {
        async upload() {
          throw new Error("unused");
        },
        async read() {
          throw new Error("unused");
        },
        async delete() {
          throw new Error("gcs unavailable");
        },
      },
      auditService,
    );

    await expect(
      service.delete({
        workspaceId: "workspace-1",
        documentId: "doc-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable",
      message: "Failed to delete stored document source",
    });
  });

  it("throws a not_found error when the document does not belong to the workspace", async () => {
    const auditService = createAuditService();
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId(): Promise<null> {
          return null;
        },
        async deleteByIdAndWorkspaceId(): Promise<boolean> {
          return false;
        },
      },
      {
        async upload() {
          throw new Error("unused");
        },
        async read() {
          throw new Error("unused");
        },
        async delete() {
          throw new Error("unused");
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
