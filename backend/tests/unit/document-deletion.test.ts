import { describe, expect, it, vi } from "vitest";

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

  it("publishes only after a true delete and before post-delete audit", async () => {
    const order: string[] = [];
    const auditService = createAuditService();
    vi.spyOn(auditService, "record").mockImplementation(async () => {
      order.push("audit");
    });
    const publisher = {
      enqueue: vi.fn(() => {
        order.push("publish");
        return { accepted: true as const, coalesced: false };
      }),
    };
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId() {
          return {
            id: "doc-1",
            workspaceId: "workspace-1",
            title: "Inline",
            sourceContent: "body",
            markdownContent: "body",
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
        async deleteByIdAndWorkspaceId() {
          order.push("delete");
          return true;
        },
      },
      { async upload() { throw new Error("unused"); }, async read() { throw new Error("unused"); }, async delete() { throw new Error("unused"); } },
      auditService,
      undefined,
      publisher,
    );

    await service.delete({ workspaceId: "workspace-1", documentId: "doc-1" });

    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["document.status_changed"]);
    expect(order).toEqual(["delete", "publish", "audit"]);
  });

  it("does not publish when the conditional delete reports no affected row", async () => {
    const publisher = { enqueue: vi.fn() };
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId() {
          return {
            id: "doc-1",
            workspaceId: "workspace-1",
            title: "Inline",
            sourceContent: "body",
            markdownContent: "body",
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
        async deleteByIdAndWorkspaceId() { return false; },
      },
      { async upload() { throw new Error("unused"); }, async read() { throw new Error("unused"); }, async delete() { throw new Error("unused"); } },
      createAuditService(),
      undefined,
      publisher,
    );

    await expect(service.delete({ workspaceId: "workspace-1", documentId: "doc-1" })).rejects.toMatchObject({ statusCode: 404 });
    expect(publisher.enqueue).not.toHaveBeenCalled();
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
    );

    await service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    });

    expect(callOrder).toEqual(["db", "storage"]);
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
  // The version the caller read is the delete's own predicate, so a document edited since the
  // decision was made is refused rather than removed on the strength of a stale snapshot.
  it("reports a delete refused by its version predicate as a conflict, not as a missing document", async () => {
    const auditService = createAuditService();
    const stored = {
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
      status: "ready",
      revision: 1,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date("2026-08-30T10:00:00.000Z"),
      retrievalEnabled: true,
      retrievalExpiresAt: null,
    };
    const deleteByIdAndWorkspaceId = vi.fn(async (
      _documentId: string,
      _workspaceId: string,
      options?: { expectedUpdatedAt?: Date },
    ) => options?.expectedUpdatedAt === undefined);
    const service = new DocumentDeletionService(
      {
        async findByIdAndWorkspaceId() { return stored; },
        deleteByIdAndWorkspaceId,
      },
      {
        async upload() { throw new Error("unused"); },
        async read() { throw new Error("unused"); },
        async delete() { throw new Error("unused"); },
      },
      auditService,
    );

    await expect(
      service.delete({
        workspaceId: "workspace-1",
        documentId: "doc-1",
        expectedUpdatedAt: new Date("2026-08-01T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
    expect(deleteByIdAndWorkspaceId).toHaveBeenCalledWith("doc-1", "workspace-1", {
      expectedUpdatedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "document.delete",
        eventStatus: "failure",
        metadata: { documentId: "doc-1", reason: "version_conflict" },
      }),
    );
  });
});
