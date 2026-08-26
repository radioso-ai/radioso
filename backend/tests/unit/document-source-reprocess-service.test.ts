import { describe, expect, it, vi } from "vitest";

import { DocumentSourceReprocessService } from "../../src/modules/documents/services/documentSourceReprocessService.js";
import {
  createAuditService,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentSourceRepository,
} from "../support/fakes.js";

describe("DocumentSourceReprocessService", () => {
  it("queues only ready and failed documents for one source and records skipped counts", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const sourceRepository = new InMemoryDocumentSourceRepository();
    const auditService = createAuditService();
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
      dispatchMany: vi.fn().mockResolvedValue(undefined),
    };
    const source = await sourceRepository.upsertByExternalId({
      workspaceId: "workspace-1",
      kind: "website",
      name: "Events",
      externalId: "https://events.example",
      config: { url: "https://events.example" },
    });
    const otherSource = await sourceRepository.upsertByExternalId({
      workspaceId: "workspace-1",
      kind: "website",
      name: "Other",
      externalId: "https://other.example",
      config: { url: "https://other.example" },
    });
    const statuses = ["ready", "failed", "queued", "processing"] as const;
    const sourceDocuments = await Promise.all(statuses.map((status) =>
      documentRepository.create({
        workspaceId: "workspace-1",
        title: `${status} document`,
        sourceContent: status,
        markdownContent: status,
        status,
        sourceId: source.id,
        sourceKind: "inline_text",
        sourceFilename: null,
        sourceMimeType: "text/plain",
        sourceStorageBucket: null,
        sourceStorageObject: null,
        sourceStorageGeneration: null,
        sourceSizeBytes: null,
      }),
    ));
    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Other source ready",
      sourceContent: "other",
      markdownContent: "other",
      status: "ready",
      sourceId: otherSource.id,
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const service = new DocumentSourceReprocessService(
      documentRepository,
      sourceRepository,
      auditService,
      jobRepository,
      dispatcher,
    );

    const result = await service.reprocessSource({
      workspaceId: "workspace-1",
      sourceId: source.id,
      documentEnrichmentOverride: "on",
    });

    expect(result).toEqual({
      workspaceId: "workspace-1",
      sourceId: source.id,
      queuedDocumentCount: 2,
      skippedDocumentCount: 2,
      status: "queued",
    });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    for (const document of sourceDocuments.slice(0, 2)) {
      const updated = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
      expect(updated?.status).toBe("queued");
      expect(updated?.revision).toBe(2);
      const job = await jobRepository.findByDocumentRevision({
        documentId: document.id,
        workspaceId: "workspace-1",
        documentRevision: 2,
      });
      expect(job?.options).toEqual({ documentEnrichmentOverride: "on" });
    }
    const untouchedOther = [...documentRepository.items.values()].find((document) => document.sourceId === otherSource.id);
    expect(untouchedOther?.status).toBe("ready");
    expect(untouchedOther?.revision).toBe(1);
    expect(auditService.events).toContainEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      eventType: "document.reprocess_source",
      eventStatus: "success",
      metadata: expect.objectContaining({
        sourceId: source.id,
        queuedDocumentCount: 2,
        skippedDocumentCount: 2,
        documentEnrichmentOverride: "on",
      }),
    }));
  });

  it("queues only documents with no source for the manual scope and skips the source lookup", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const sourceRepository = new InMemoryDocumentSourceRepository();
    const findSource = vi.spyOn(sourceRepository, "findByIdAndWorkspaceId");
    const auditService = createAuditService();
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
      dispatchMany: vi.fn().mockResolvedValue(undefined),
    };
    const source = await sourceRepository.upsertByExternalId({
      workspaceId: "workspace-1",
      kind: "website",
      name: "Events",
      externalId: "https://events.example",
      config: { url: "https://events.example" },
    });
    const manualStatuses = ["ready", "failed", "processing"] as const;
    const manualDocuments = await Promise.all(manualStatuses.map((status) =>
      documentRepository.create({
        workspaceId: "workspace-1",
        title: `manual ${status} document`,
        sourceContent: status,
        markdownContent: status,
        status,
      }),
    ));
    const sourcedDocument = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Sourced ready",
      sourceContent: "sourced",
      markdownContent: "sourced",
      status: "ready",
      sourceId: source.id,
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const service = new DocumentSourceReprocessService(
      documentRepository,
      sourceRepository,
      auditService,
      jobRepository,
      dispatcher,
    );

    const result = await service.reprocessSource({
      workspaceId: "workspace-1",
      sourceId: null,
      documentEnrichmentOverride: "on",
    });

    expect(findSource).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspaceId: "workspace-1",
      sourceId: null,
      queuedDocumentCount: 2,
      skippedDocumentCount: 1,
      status: "queued",
    });
    for (const document of manualDocuments.slice(0, 2)) {
      const updated = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
      expect(updated?.status).toBe("queued");
      expect(updated?.revision).toBe(2);
      const job = await jobRepository.findByDocumentRevision({
        documentId: document.id,
        workspaceId: "workspace-1",
        documentRevision: 2,
      });
      expect(job?.options).toEqual({ documentEnrichmentOverride: "on" });
    }
    const untouchedSourced = await documentRepository.findByIdAndWorkspaceId(sourcedDocument.id, "workspace-1");
    expect(untouchedSourced?.status).toBe("ready");
    expect(untouchedSourced?.revision).toBe(1);
    expect(auditService.events).toContainEqual(expect.objectContaining({
      eventType: "document.reprocess_source",
      eventStatus: "success",
      metadata: expect.objectContaining({
        sourceId: null,
        queuedDocumentCount: 2,
        skippedDocumentCount: 1,
      }),
    }));
  });

  it("publishes one document invalidation for a changed bulk scope and stays silent for a no-op", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const sourceRepository = new InMemoryDocumentSourceRepository();
    const auditService = createAuditService();
    const publisher = { enqueue: vi.fn() };
    const source = await sourceRepository.upsertByExternalId({
      workspaceId: "workspace-1",
      kind: "website",
      name: "Events",
      externalId: "https://events.example",
      config: { url: "https://events.example" },
    });
    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "ready",
      markdownContent: "ready",
      status: "ready",
      sourceId: source.id,
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const service = new DocumentSourceReprocessService(
      documentRepository,
      sourceRepository,
      auditService,
      undefined,
      undefined,
      publisher,
    );

    await expect(service.reprocessSource({ workspaceId: "workspace-1", sourceId: source.id })).resolves.toMatchObject({
      queuedDocumentCount: 1,
      status: "queued",
    });
    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["document.status_changed"]);

    await expect(service.reprocessSource({ workspaceId: "workspace-1", sourceId: source.id })).resolves.toMatchObject({
      queuedDocumentCount: 0,
      status: "noop",
    });
    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
  });
});
