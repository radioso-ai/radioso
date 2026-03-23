import { describe, expect, it } from "vitest";

import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import { createAuditService, InMemoryDocumentRepository, InMemoryDocumentStorage } from "../support/fakes.js";

describe("document import service", () => {
  it("stores an uploaded file, derives a title, and queues a file-backed document", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const storage = new InMemoryDocumentStorage();
    const auditService = createAuditService();
    const service = new DocumentImportService(documentRepository, auditService, storage);

    const response = await service.importDocument({
      workspaceId: "workspace-1",
      filename: "Quarterly Report.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("fake-xlsx"),
    });

    expect(response.status).toBe("queued");

    const document = await documentRepository.findByIdAndWorkspaceId(response.documentId, "workspace-1");
    expect(document).toMatchObject({
      title: "Quarterly Report",
      sourceKind: "uploaded_file",
      sourceFilename: "Quarterly Report.xlsx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      status: "queued",
      sourceContent: "",
      markdownContent: "",
    });
    expect(storage.objects.size).toBe(1);
  });

  it("uses the provided title override when importing a file", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const storage = new InMemoryDocumentStorage();
    const service = new DocumentImportService(documentRepository, createAuditService(), storage);

    const response = await service.importDocument({
      workspaceId: "workspace-1",
      filename: "customer-handbook.pdf",
      mimeType: "application/pdf",
      title: "Customer Handbook",
      buffer: Buffer.from("fake-pdf"),
    });

    const document = await documentRepository.findByIdAndWorkspaceId(response.documentId, "workspace-1");
    expect(document?.title).toBe("Customer Handbook");
  });

  it("rejects unsupported file types before storing them", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const storage = new InMemoryDocumentStorage();
    const service = new DocumentImportService(documentRepository, createAuditService(), storage);

    await expect(
      service.importDocument({
        workspaceId: "workspace-1",
        filename: "avatar.png",
        mimeType: "image/png",
        buffer: Buffer.from("png"),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
      message: "Unsupported document type",
    });
    expect(storage.objects.size).toBe(0);
  });

  it("records a failure when storage upload fails", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const auditService = createAuditService();
    const service = new DocumentImportService(documentRepository, auditService, {
      async upload() {
        throw new Error("storage unavailable");
      },
      async read() {
        throw new Error("not used");
      },
      async delete() {
        throw new Error("not used");
      },
    });

    await expect(
      service.importDocument({
        workspaceId: "workspace-1",
        filename: "report.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("report"),
      }),
    ).rejects.toThrow("storage unavailable");

    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.import",
        eventStatus: "failure",
      }),
    );
  });

  it("deletes the uploaded object when document persistence fails after storage succeeds", async () => {
    const storage = new InMemoryDocumentStorage();
    const documentRepository = new InMemoryDocumentRepository();
    documentRepository.createAndQueue = async () => {
      throw new Error("queue unavailable");
    };
    const service = new DocumentImportService(documentRepository, createAuditService(), storage);

    await expect(
      service.importDocument({
        workspaceId: "workspace-1",
        filename: "report.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("report"),
      }),
    ).rejects.toThrow("queue unavailable");

    expect(storage.objects.size).toBe(0);
  });
});
