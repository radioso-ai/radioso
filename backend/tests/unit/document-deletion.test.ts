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
            retrievalEnabled: true,
            retrievalExpiresAt: null,
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

  it("removes the document record before attempting uploaded source cleanup", async () => {
    const callOrder: string[] = [];
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
            retrievalEnabled: true,
            retrievalExpiresAt: null,
          };
        },
        async deleteByIdAndWorkspaceId() {
          callOrder.push("db");
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
          callOrder.push("storage");
          deletedObjects.push(input.objectPath);
        },
      },
      auditService,
      undefined,
      {
        async onCorpusChanged(input) {
          callOrder.push(`corpus:${input.change}`);
        },
      },
    );

    await service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    });

    expect(callOrder).toEqual(["db", "corpus:deleted", "storage"]);
    expect(deletedObjects).toEqual(["objects/doc-1"]);
  });

  it("deletes the document even when uploaded source cleanup fails", async () => {
    const auditService = createAuditService();
    let deleted = false;
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
            retrievalEnabled: true,
            retrievalExpiresAt: null,
          };
        },
        async deleteByIdAndWorkspaceId() {
          deleted = true;
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

    await service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    });

    expect(deleted).toBe(true);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.delete",
        eventStatus: "failure",
        metadata: {
          documentId: "doc-1",
          reason: "gcs unavailable",
        },
      }),
    );
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
