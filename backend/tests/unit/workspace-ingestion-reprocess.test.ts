import { describe, expect, it, vi } from "vitest";

import { WorkspaceIngestionReprocessService } from "../../src/modules/documents/services/workspaceIngestionReprocessService.js";
import {
  createAuditService,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";

describe("workspace ingestion reprocess", () => {
  it("queues eligible workspace documents and skips in-flight ones", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const auditService = createAuditService();
    const publisher = { enqueue: vi.fn() };
    const service = new WorkspaceIngestionReprocessService(
      documentRepository,
      auditService,
      undefined,
      undefined,
      publisher,
    );

    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "ready",
      markdownContent: "ready",
      status: "ready",
    });
    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Failed",
      sourceContent: "failed",
      markdownContent: "failed",
      status: "failed",
    });
    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Queued",
      sourceContent: "queued",
      markdownContent: "queued",
      status: "queued",
    });
    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Processing",
      sourceContent: "processing",
      markdownContent: "processing",
      status: "processing",
    });
    await documentRepository.create({
      workspaceId: "workspace-2",
      title: "Other workspace",
      sourceContent: "other",
      markdownContent: "other",
      status: "ready",
    });

    const result = await service.reprocessWorkspace("workspace-1");
    const documents = await documentRepository.listByWorkspaceId("workspace-1");

    expect(result).toEqual({
      workspaceId: "workspace-1",
      queuedDocumentCount: 2,
      skippedDocumentCount: 2,
      status: "queued",
    });
    expect(documents.filter((document) => document.status === "queued")).toHaveLength(3);
    expect(documents.filter((document) => document.status === "processing")).toHaveLength(1);
    expect(documents.filter((document) => document.workspaceId === "workspace-1")).toHaveLength(4);
    expect(publisher.enqueue).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["document.status_changed"]);
    expect(auditService.events.at(-1)).toMatchObject({
      workspaceId: "workspace-1",
      eventType: "document.reprocess_workspace",
      eventStatus: "success",
      metadata: {
        queuedDocumentCount: 2,
        skippedDocumentCount: 2,
      },
    });
  });

  it("returns noop when no workspace documents are eligible", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const auditService = createAuditService();
    const publisher = { enqueue: vi.fn() };
    const service = new WorkspaceIngestionReprocessService(
      documentRepository,
      auditService,
      undefined,
      undefined,
      publisher,
    );

    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Queued",
      sourceContent: "queued",
      markdownContent: "queued",
      status: "queued",
    });
    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Processing",
      sourceContent: "processing",
      markdownContent: "processing",
      status: "processing",
    });

    const result = await service.reprocessWorkspace("workspace-1");

    expect(result).toEqual({
      workspaceId: "workspace-1",
      queuedDocumentCount: 0,
      skippedDocumentCount: 2,
      status: "noop",
    });
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("keeps workspace reprocess successful when dispatching a queued job fails", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const order: string[] = [];
    const publisher = {
      enqueue: vi.fn(() => {
        order.push("publish");
        return { accepted: true as const, coalesced: false };
      }),
    };
    const service = new WorkspaceIngestionReprocessService(
      documentRepository,
      auditService,
      jobRepository,
      {
        dispatch: vi.fn().mockImplementation(async () => {
          order.push("dispatch");
          throw new Error("dispatch unavailable");
        }),
        dispatchMany: vi.fn().mockResolvedValue(undefined),
      },
      publisher,
    );

    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "ready",
      markdownContent: "ready",
      status: "ready",
    });

    await expect(service.reprocessWorkspace("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      queuedDocumentCount: 1,
      skippedDocumentCount: 0,
      status: "queued",
    });
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.dispatch",
        eventStatus: "failure",
      }),
    );
    expect(order).toEqual(["publish", "dispatch"]);
  });
});
