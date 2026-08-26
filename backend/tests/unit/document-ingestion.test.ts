import { describe, expect, it, vi } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../src/modules/documents/services/documentSourceContentService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentStorage,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentSourceRepository,
} from "../support/fakes.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";

describe("document ingestion", () => {
  it("queues new documents instead of processing them inline", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const analyticsService = {
      track: vi.fn().mockResolvedValue(undefined),
    };
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
      dispatchMany: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
      dispatcher,
      analyticsService as never,
    );

    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Queued",
      content: "Queued content",
    });

    expect(response.status).toBe("queued");
    const [document] = await documentRepository.listByWorkspaceId("workspace-1");
    expect(document.status).toBe("queued");
    expect(document.revision).toBe(1);
    expect([...jobRepository.items.values()]).toHaveLength(1);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.ingest",
        eventStatus: "success",
        metadata: expect.objectContaining({
          queuedJobCount: 1,
          processingJobCount: 0,
        }),
      }),
    );
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: document.id,
        workspaceId: "workspace-1",
        revision: 1,
      }),
    );
    expect(analyticsService.track).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "document.ingest_queued",
        workspaceId: "workspace-1",
        subjectId: document.id,
      }),
    );
  });

  it("publishes create, update, and reprocess transitions after their durable writes", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const publisher = { enqueue: vi.fn() };
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publisher,
    );

    const created = await service.ingest({ workspaceId: "workspace-1", title: "First", content: "one" });
    await service.update({ workspaceId: "workspace-1", documentId: created.documentId, title: "Updated", content: "two" });
    await service.reprocess({ workspaceId: "workspace-1", documentId: created.documentId });

    expect(publisher.enqueue).toHaveBeenCalledTimes(3);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, "workspace-1", ["document.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, "workspace-1", ["document.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(3, "workspace-1", ["document.status_changed"]);
  });

  it("publishes each committed source-deletion seam and stays silent for an empty no-op", async () => {
    const publisher = { enqueue: vi.fn() };
    const documentRepository = {
      deleteBySourceIdAndWorkspaceId: vi.fn()
        .mockResolvedValueOnce({ count: 2, storageRefs: [] })
        .mockResolvedValueOnce({ count: 0, storageRefs: [] }),
    };
    const sourceRepository = {
      deleteByIdAndWorkspaceId: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    const service = new DocumentIngestionService(
      documentRepository as never,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sourceRepository as never,
      undefined,
      publisher,
    );

    await service.deleteSourceWithDocuments({ workspaceId: "workspace-1", sourceId: "source-1" });
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, "workspace-1", ["document.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, "workspace-1", ["document.status_changed"]);

    publisher.enqueue.mockClear();
    await service.deleteSourceWithDocuments({ workspaceId: "workspace-1", sourceId: "missing-source" });
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("publishes a committed document removal even when the later source deletion fails", async () => {
    const publisher = { enqueue: vi.fn() };
    const service = new DocumentIngestionService(
      { deleteBySourceIdAndWorkspaceId: vi.fn(async () => ({ count: 1, storageRefs: [] })) } as never,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { deleteByIdAndWorkspaceId: vi.fn(async () => { throw new Error("source delete failed"); }) } as never,
      undefined,
      publisher,
    );

    await expect(service.deleteSourceWithDocuments({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    })).rejects.toThrow("source delete failed");
    expect(publisher.enqueue).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["document.status_changed"]);
  });

  it("stores a one-run enrichment override on the ingest job for manual documents", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
    );

    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Dated announcement",
      content: "The retreat happens on August 10, 2026.",
      documentEnrichmentOverride: "on",
    });

    const job = await jobRepository.findByDocumentRevision({
      documentId: response.documentId,
      workspaceId: "workspace-1",
      documentRevision: 1,
    });
    expect(job?.options).toEqual({ documentEnrichmentOverride: "on" });

    const withoutOverride = await service.ingest({
      workspaceId: "workspace-1",
      title: "Plain document",
      content: "No override requested.",
    });
    const plainJob = await jobRepository.findByDocumentRevision({
      documentId: withoutOverride.documentId,
      workspaceId: "workspace-1",
      documentRevision: 1,
    });
    expect(plainJob?.options ?? null).toBeNull();
  });

  it("does not fail ingest when queue snapshot metadata lookup fails after queueing", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      async () => {
        throw new Error("snapshot unavailable");
      },
    );

    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Queued",
      content: "Queued content",
    });

    expect(response.status).toBe("queued");
    expect([...jobRepository.items.values()]).toHaveLength(1);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.ingest",
        eventStatus: "success",
        metadata: expect.objectContaining({
          documentId: response.documentId,
          status: "queued",
        }),
      }),
    );
    expect(auditService.events).not.toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.ingest",
        eventStatus: "failure",
      }),
    );
  });

  it("does not persist a new document when durable queue creation fails", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const analyticsService = {
      track: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      analyticsService as never,
    );

    jobRepository.enqueue = async () => {
      throw new Error("queue unavailable");
    };

    await expect(
      service.ingest({
        workspaceId: "workspace-1",
        title: "Broken queue",
        content: "Broken queue content",
      }),
    ).rejects.toThrow("queue unavailable");

    expect(await documentRepository.listByWorkspaceId("workspace-1")).toHaveLength(0);
    expect(analyticsService.track).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "document.ingest_failed",
        workspaceId: "workspace-1",
      }),
    );
  });

  it("keeps ingest successful when dispatching the queued job fails after durable queueing", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
      {
        dispatch: vi.fn().mockRejectedValue(new Error("dispatch unavailable")),
        dispatchMany: vi.fn().mockResolvedValue(undefined),
      },
    );

    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Queued",
      content: "Queued content",
    });

    expect(response.status).toBe("queued");
    expect([...jobRepository.items.values()]).toHaveLength(1);

    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.dispatch",
        eventStatus: "failure",
      }),
    );
  });

  it("stores a one-run enrichment override on the reprocess job without leaking it to later jobs", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
    );
    const created = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "Ready content",
      markdownContent: "Ready content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });

    await service.reprocess({
      workspaceId: "workspace-1",
      documentId: created.id,
      documentEnrichmentOverride: "off",
    });

    const overrideJob = await jobRepository.findByDocumentRevision({
      documentId: created.id,
      workspaceId: "workspace-1",
      documentRevision: 2,
    });
    expect(overrideJob?.options).toEqual({ documentEnrichmentOverride: "off" });

    await service.reprocess({
      workspaceId: "workspace-1",
      documentId: created.id,
    });

    const laterJob = await jobRepository.findByDocumentRevision({
      documentId: created.id,
      workspaceId: "workspace-1",
      documentRevision: 3,
    });
    expect(laterJob?.options).toBeNull();
  });

  it("recovers timed-out claims when the same job is retried by id", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const queuedDocument = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Lease recovery",
      sourceContent: "Lease recovery",
      markdownContent: "Lease recovery",
      status: "queued",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const job = await jobRepository.enqueue({
      documentId: queuedDocument.id,
      workspaceId: queuedDocument.workspaceId,
      documentRevision: queuedDocument.revision,
    });
    const claimedAt = new Date();
    await jobRepository.claimById(job.id, claimedAt);

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      {
        process: vi.fn().mockResolvedValue("completed"),
      } as any,
      auditService,
      createLogger("silent"),
      1_000,
      {
        dispatch: vi.fn().mockResolvedValue(undefined),
        dispatchMany: vi.fn().mockResolvedValue(undefined),
      },
      1_000,
    );

    const result = await worker.runJobById(job.id, new Date(claimedAt.getTime() + 2_000));

    expect(result).toBe("processed");
    expect(jobRepository.items.get(job.id)?.status).toBe("completed");
  });

  it("processes queued jobs and marks the document ready", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const order: string[] = [];
    const recordAudit = auditService.record.bind(auditService);
    vi.spyOn(auditService, "record").mockImplementation(async (event) => {
      if (event.eventType === "document.process") {
        order.push("audit");
      }
      await recordAudit(event);
    });
    const publisher = {
      enqueue: vi.fn(() => {
        order.push("publish");
        return { accepted: true as const, coalesced: false };
      }),
    };
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultIngestionSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        publisher,
      ),
      auditService,
      createLogger("silent"),
    );

    const queued = await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Ready soon",
      content: "Ready soon",
    });

    expect(queued.status).toBe("queued");
    expect(await processingWorker.runOnce()).toBe(true);

    const [document] = await documentRepository.listByWorkspaceId("workspace-1");
    expect(document.status).toBe("ready");
    expect(chunkRepository.items.get(document.id)).toHaveLength(1);
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, "workspace-1", ["document.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, "workspace-1", ["document.status_changed"]);
    expect(order).toEqual(["publish", "publish", "audit"]);
  });

  it("uses the document embedding port without supplying provider-owned options", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const embedDocumentChunks = vi.fn(async (input: { texts: readonly string[] }) => ({
      space: {
        id: "space-document",
        dimensions: 3,
        distanceMetric: "cosine" as const,
      },
      vectors: input.texts.map(() => [1, 2, 3]),
    }));
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        { embedDocumentChunks },
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return {
              ...defaultIngestionSettings(workspaceId),
              embeddingModel: "text-embedding-3-large",
            };
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Model-specific",
      content: "Model-specific content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    expect(embedDocumentChunks).toHaveBeenCalledOnce();
    const request = embedDocumentChunks.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      texts: expect.any(Array),
      documentId: expect.any(String),
      documentRevision: 1,
      jobId: expect.any(String),
      usageItems: expect.any(Array),
      usageContext: expect.objectContaining({
        workspaceId: "workspace-1",
        surface: "documents",
        operation: "embedding",
      }),
    }));
    expect(request).not.toHaveProperty("provider");
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("dimensions");
    expect(request).not.toHaveProperty("purpose");
    expect(chunkRepository.publications).toHaveLength(1);
    expect(chunkRepository.publications[0]).toMatchObject({
      workspaceId: "workspace-1",
      revision: 1,
      canonicalVersion: "1",
      embeddingSpace: {
        id: "space-document",
        dimensions: 3,
        distanceMetric: "cosine",
      },
    });
  });

  it("keeps synchronous document publication on the active embedding model during a transition", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const seenModels: Array<string | undefined> = [];
    const promotePendingEmbeddingModelIfReady = vi.fn().mockResolvedValue(null);
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]> {
            seenModels.push(options?.model);
            return texts.map(() => [1, 2, 3]);
          },
        }, "text-embedding-3-small"),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return {
              ...defaultIngestionSettings(workspaceId),
              embeddingModel: "text-embedding-3-small",
              pendingEmbeddingModel: "text-embedding-3-large",
            };
          },
          promotePendingEmbeddingModelIfReady,
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Pending model",
      content: "Pending model content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    expect(seenModels).toEqual(["text-embedding-3-small"]);
    expect(chunkRepository.items.get((await documentRepository.listByWorkspaceId("workspace-1"))[0]!.id)?.[0]?.embeddingModel).toBe("text-embedding-3-small");
    expect(promotePendingEmbeddingModelIfReady).toHaveBeenCalledWith("workspace-1");
  });

  it("skips stale jobs when a newer revision is queued", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const publisher = { enqueue: vi.fn() };
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultIngestionSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        publisher,
      ),
      auditService,
      createLogger("silent"),
    );

    const first = await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Versioned",
      content: "First content",
    });

    await ingestionService.update({
      workspaceId: "workspace-1",
      documentId: first.documentId,
      title: "Versioned",
      content: "Second content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    const afterFirstRun = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(afterFirstRun?.status).toBe("queued");

    expect(await processingWorker.runOnce()).toBe(true);
    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.status).toBe("ready");
    expect(current?.revision).toBe(2);
    expect(chunkRepository.items.get(first.documentId)?.[0]?.content).toContain("Second content");
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
  });

  it("reuses the same document for repeated ingest requests with the same externalDocumentId", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "First content",
      externalDocumentId: "crm-123",
    } as any);

    const second = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Second content",
      externalDocumentId: "crm-123",
    } as any);

    expect(second.documentId).toBe(first.documentId);

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.externalDocumentId).toBe("crm-123");
    expect(current?.revision).toBe(2);
    expect(current?.sourceContent).toBe("Second content");
  });

  it("skips reprocessing when both content and searchable metadata are unchanged", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const publisher = { enqueue: vi.fn() };
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publisher,
    );

    const metadata = { sourceUrl: "https://example.com/p", author: "Sabine Kaphingst" };
    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata,
    } as any);

    await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { ...metadata },
    } as any);

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(1);
    expect(publisher.enqueue).toHaveBeenCalledOnce();
  });

  it("re-ingests a synced document when only searchable metadata changes (e.g. author becomes available)", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p" },
    } as any);

    const second = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p", author: "Sabine Kaphingst" },
    } as any);

    expect(second.documentId).toBe(first.documentId);
    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(2);
    expect(current?.metadata).toMatchObject({ author: "Sabine Kaphingst" });
  });

  it("re-ingests a synced document when only an indexed field changes (e.g. a product goes on sale)", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p" },
      indexedFields: { price: 17, on_sale: false },
    } as any);

    const second = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p" },
      indexedFields: { price: 12.5, on_sale: true },
    } as any);

    expect(second.documentId).toBe(first.documentId);
    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(2);
    expect(current?.metadata).toMatchObject({ price: 12.5, on_sale: true });
  });

  it("skips reprocessing when the indexed fields are unchanged", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p" },
      indexedFields: { price: 17, sku: "AEY0112" },
    } as any);

    // Key order must not matter: the plugin builds the map from whatever the
    // shop returns, so a reordered payload is the same document.
    await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p" },
      indexedFields: { sku: "AEY0112", price: 17 },
    } as any);

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(1);
  });

  it("re-ingests when an indexed field changes type without changing its text", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    // A shop that starts sending real numbers instead of strings changes what a
    // numeric rule matches, so it has to reach the chunks.
    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      indexedFields: { price: "17", on_sale: "false" },
    } as any);

    await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      indexedFields: { price: 17, on_sale: false },
    } as any);

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(2);
    expect(current?.metadata).toMatchObject({ price: 17, on_sale: false });
  });

  it("re-ingests when a field value only looks like two fields", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      indexedFields: { sku: "A\u0001zone=north" },
    } as any);

    await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      indexedFields: { sku: "A", zone: "north" },
    } as any);

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(2);
  });

  it("keeps the connector's own metadata when an indexed field collides with it", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const result = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Body",
      externalDocumentId: "wp_post_42",
      metadata: { author: "Swami Kriyananda", sourceUrl: "https://example.com/p" },
      indexedFields: { author: "staff-uploader", price: 17 },
    } as any);

    const current = await documentRepository.findByIdAndWorkspaceId(result.documentId, "workspace-1");
    expect(current?.metadata).toMatchObject({ author: "Swami Kriyananda", price: 17 });
  });

  it("leaves the content hash untouched for documents that carry no indexed fields", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const first = await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p", author: "Sabine Kaphingst" },
    } as any);

    await service.ingest({
      workspaceId: "workspace-1",
      title: "Synced doc",
      content: "Same body",
      externalDocumentId: "wp_post_42",
      metadata: { sourceUrl: "https://example.com/p", author: "Sabine Kaphingst" },
      indexedFields: {},
    } as any);

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.revision).toBe(1);
  });

  it("allows first assignment of externalDocumentId on update and rejects later reassignment", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

    const created = await service.ingest({
      workspaceId: "workspace-1",
      title: "Mutable once",
      content: "Original content",
    });

    await service.update({
      workspaceId: "workspace-1",
      documentId: created.documentId,
      title: "Mutable once",
      content: "Assigned content",
      externalDocumentId: "crm-123",
    } as any);

    const assigned = await documentRepository.findByIdAndWorkspaceId(created.documentId, "workspace-1");
    expect(assigned?.externalDocumentId).toBe("crm-123");

    await expect(
      service.update({
        workspaceId: "workspace-1",
        documentId: created.documentId,
        title: "Mutable once",
        content: "Reassigned content",
        externalDocumentId: "crm-456",
      } as any),
    ).rejects.toThrow("externalDocumentId cannot be changed once set");
  });

  it("does not publish stale chunks after a newer revision becomes ready", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const publisher = { enqueue: vi.fn() };
    let processingService!: DocumentProcessingService;
    let newerRevisionPublished = false;

    const first = await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Versioned",
      content: "First content",
    });

    processingService = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      createDocumentEmbeddingPort({
        async embedTexts(texts: string[]): Promise<number[][]> {
          if (!newerRevisionPublished) {
            newerRevisionPublished = true;
            await ingestionService.update({
              workspaceId: "workspace-1",
              documentId: first.documentId,
              title: "Versioned",
              content: "Second content",
            });

            const newerJob = await jobRepository.claimNext();
            expect(newerJob?.documentRevision).toBe(2);
            expect(await processingService.process(newerJob!)).toBe("completed");
          }

          return texts.map(() => [1, 2, 3]);
        },
      }),
      auditService,
      {
        async getForWorkspace(workspaceId: string) {
          return defaultIngestionSettings(workspaceId);
        },
      },
      new ChunkingStrategyRegistry([fixedWindowStrategy]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publisher,
    );

    const olderJob = await jobRepository.claimNext();
    expect(olderJob?.documentRevision).toBe(1);
    expect(await processingService.process(olderJob!)).toBe("stale");

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.status).toBe("ready");
    expect(current?.revision).toBe(2);
    expect(chunkRepository.items.get(first.documentId)?.[0]?.content).toContain("Second content");
    // Older processing was visible once, but its rejected ready publication
    // must not emit a fourth invalidation after revision 2 won the race.
    expect(publisher.enqueue).toHaveBeenCalledTimes(3);
  });

  it("rejects source changes when the document is not in the manually-added bucket", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const auditService = createAuditService();
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);

    const crawledSourceId = "11111111-1111-1111-1111-111111111111";
    const crawled = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Crawled page",
      sourceContent: "Crawled body",
      markdownContent: "Crawled body",
      status: "ready",
      sourceKind: "inline_text",
      sourceId: crawledSourceId,
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });

    await expect(
      ingestionService.update({
        workspaceId: "workspace-1",
        documentId: crawled.id,
        title: "Crawled page",
        content: "Crawled body",
        source: { id: "00000000-0000-0000-0000-000000000001" },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: "Source can only be changed for manually-added documents",
    });

    const persisted = await documentRepository.findByIdAndWorkspaceId(crawled.id, "workspace-1");
    expect(persisted?.sourceId).toBe(crawledSourceId);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.update",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          documentId: crawled.id,
          reason: "Source can only be changed for manually-added documents",
        }),
      }),
    );
  });

  it("rejects inline updates for imported documents", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const auditService = createAuditService();
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);

    const imported = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Imported",
      sourceContent: "Parsed content",
      markdownContent: "Parsed content",
      status: "ready",
      sourceKind: "uploaded_file",
      sourceFilename: "import.txt",
      sourceMimeType: "text/plain",
      sourceStorageBucket: "bucket",
      sourceStorageObject: "objects/doc-1",
      sourceStorageGeneration: "1",
      sourceSizeBytes: 14,
    });

    await expect(
      ingestionService.update({
        workspaceId: "workspace-1",
        documentId: imported.id,
        title: "Edited",
        content: "Edited content",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: "Imported documents cannot be updated through the inline document API",
    });

    const persisted = await documentRepository.findByIdAndWorkspaceId(imported.id, "workspace-1");
    expect(persisted?.sourceKind).toBe("uploaded_file");
    expect(persisted?.sourceStorageObject).toBe("objects/doc-1");
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.update",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          documentId: imported.id,
          reason: "Imported documents cannot be updated through the inline document API",
        }),
      }),
    );
  });

  it("propagates document metadata to chunks during processing", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultIngestionSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    const queued = await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Metadata doc",
      content: "Content with metadata",
      metadata: { sourceUrl: "https://example.com" },
    });

    expect(await processingWorker.runOnce()).toBe(true);

    const [document] = await documentRepository.listByWorkspaceId("workspace-1");
    expect(document.status).toBe("ready");

    const chunks = chunkRepository.items.get(queued.documentId);
    expect(chunks).toBeDefined();
    expect(chunks).toHaveLength(1);
    expect(chunks![0]!.metadata).toEqual({ sourceUrl: "https://example.com" });
  });

  it("uses source enrichment override during processing and clears stale enrichment metadata when disabled", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const sourceRepository = new InMemoryDocumentSourceRepository();
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const source = await sourceRepository.upsertByExternalId({
      workspaceId: "workspace-1",
      kind: "website",
      name: "Events",
      externalId: "https://events.example",
      config: {
        url: "https://events.example",
        documentEnrichmentOverride: "on",
      },
    });
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Event",
      sourceContent: "Event content",
      markdownContent: "Event content",
      status: "queued",
      metadata: {
        dateFrom: "2026-07-17",
        dateTo: "2026-07-17",
        sourceUrl: "https://events.example/event",
      },
      sourceId: source.id,
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    // Prior extraction provenance lives in the enrichment column (post-migration-120).
    documentRepository.items.set(document.id, {
      ...documentRepository.items.get(document.id)!,
      enrichment: { status: "applied" } as never,
    });
    const stage = {
      enrich: vi.fn().mockResolvedValue({
        status: "applied",
        documentMetadata: {
          sourceUrl: "https://events.example/event",
        },
        provenance: { status: "applied", shape: "event", factCount: 1, appliedChunkCount: 1 },
        chunks: [{
          chunkIndex: 0,
          content: "Event content",
          startOffset: 0,
          endOffset: "Event content".length,
          metadata: { sourceUrl: "https://events.example/event", dateFrom: "2026-08-01", dateTo: "2026-08-01" },
        }],
        factCount: 1,
        appliedChunkCount: 1,
      }),
    };
    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      createDocumentEmbeddingPort({
        async embedTexts(texts: string[]): Promise<number[][]> {
          return texts.map(() => [1, 2, 3]);
        },
      }),
      auditService,
      {
        async getForWorkspace(workspaceId: string) {
          return { ...defaultIngestionSettings(workspaceId), documentEnrichmentEnabled: false };
        },
      },
      new ChunkingStrategyRegistry([fixedWindowStrategy]),
      undefined,
      undefined,
      stage,
      sourceRepository,
      jobRepository,
    );

    // First revision: the source override enables enrichment, so the vectorize
    // path publishes without running the LLM and enqueues a lower-priority enrich
    // job that carries the run's options.
    const firstJob = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: document.revision,
    });
    expect(await service.process(firstJob)).toBe("completed");
    expect(stage.enrich).not.toHaveBeenCalled();
    // Vectorization clears prior stale extracted metadata and provenance.
    expect((await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1"))?.metadata).toEqual({
      sourceUrl: "https://events.example/event",
    });
    const firstEnrichJob = [...jobRepository.items.values()].find(
      (job) => job.kind === "enrich" && job.documentRevision === document.revision,
    );
    expect(firstEnrichJob).toBeDefined();

    // The enrich job runs the stage and patches document + chunk metadata.
    expect(await service.processEnrichment(firstEnrichJob!)).toBe("completed");
    expect(stage.enrich).toHaveBeenCalledOnce();
    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toEqual({
      sourceUrl: "https://events.example/event",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    });

    // Second revision with the override "off": no enrich job is enqueued and the
    // stale extracted metadata is cleared during vectorization.
    await documentRepository.requeueAndQueue(document.id, "workspace-1", { documentEnrichmentOverride: "off" });
    const offJob = await jobRepository.findByDocumentRevision({
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: 2,
    });
    stage.enrich.mockClear();

    expect(await service.process(offJob!)).toBe("completed");
    expect(stage.enrich).not.toHaveBeenCalled();
    expect([...jobRepository.items.values()].some((job) => job.kind === "enrich" && job.documentRevision === 2)).toBe(false);
    const current = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
    expect(current?.metadata).toEqual({ sourceUrl: "https://events.example/event" });
    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toEqual({ sourceUrl: "https://events.example/event" });

    // Third revision with override "on" but a failing extraction: provenance is
    // recorded and the document stays queryable (never flipped to failed).
    stage.enrich.mockImplementationOnce(async (input) => ({
      status: "failed",
      documentMetadata: {
        ...input.document.metadata,
      },
      provenance: { status: "failed", shape: "unknown", failureReason: "invalid_output", factCount: 0, appliedChunkCount: 0 },
      chunks: input.chunks,
      factCount: 0,
      appliedChunkCount: 0,
    }));
    await documentRepository.requeueAndQueue(document.id, "workspace-1", { documentEnrichmentOverride: "on" });
    const vectorizeJob3 = await jobRepository.findByDocumentRevision({
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: 3,
    });
    expect(await service.process(vectorizeJob3!)).toBe("completed");
    const failedEnrichJob = [...jobRepository.items.values()].find(
      (job) => job.kind === "enrich" && job.documentRevision === 3,
    );
    expect(failedEnrichJob).toBeDefined();

    expect(await service.processEnrichment(failedEnrichJob!)).toBe("completed");
    const failedCurrent = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
    expect(failedCurrent?.status).toBe("ready");
    expect(failedCurrent?.metadata).toEqual({ sourceUrl: "https://events.example/event" });
    expect(failedCurrent?.enrichment).toMatchObject({ status: "failed", failureReason: "invalid_output" });
  });

  it("returns not_found when update loses a delete race", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const service = new DocumentIngestionService(documentRepository, createAuditService());
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Race",
      sourceContent: "Race content",
      markdownContent: "Race content",
      status: "ready",
    });

    documentRepository.updateAndQueue = async () => {
      throw notFound("Document not found");
    };

    await expect(
      service.update({
        workspaceId: "workspace-1",
        documentId: document.id,
        title: "Race",
        content: "Updated content",
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      statusCode: 404,
      message: "Document not found",
    });
  });

  it("keeps update successful when dispatching the queued revision fails after durable queueing", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
      {
        dispatch: vi.fn().mockRejectedValue(new Error("dispatch unavailable")),
        dispatchMany: vi.fn().mockResolvedValue(undefined),
      },
    );

    const created = await service.ingest({
      workspaceId: "workspace-1",
      title: "Queued",
      content: "Queued content",
    });

    const updated = await service.update({
      workspaceId: "workspace-1",
      documentId: created.documentId,
      title: "Queued",
      content: "Updated content",
    });

    expect(updated.status).toBe("queued");
    const persisted = await documentRepository.findByIdAndWorkspaceId(created.documentId, "workspace-1");
    expect(persisted?.revision).toBe(2);
    expect([...jobRepository.items.values()]).toHaveLength(2);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.dispatch",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          documentId: created.documentId,
          revision: 2,
        }),
      }),
    );
  });

  it("returns not_found when reprocess loses a delete race", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const service = new DocumentIngestionService(documentRepository, createAuditService());
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Race",
      sourceContent: "Race content",
      markdownContent: "Race content",
      status: "ready",
    });

    documentRepository.requeueAndQueue = async () => {
      throw notFound("Document not found");
    };

    await expect(
      service.reprocess({
        workspaceId: "workspace-1",
        documentId: document.id,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      statusCode: 404,
      message: "Document not found",
    });
  });

  it("keeps reprocess successful when dispatching the queued revision fails after durable queueing", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      () => jobRepository.getQueueSnapshot(),
      jobRepository,
      {
        dispatch: vi.fn().mockRejectedValue(new Error("dispatch unavailable")),
        dispatchMany: vi.fn().mockResolvedValue(undefined),
      },
    );

    const created = await service.ingest({
      workspaceId: "workspace-1",
      title: "Queued",
      content: "Queued content",
    });

    const reprocessed = await service.reprocess({
      workspaceId: "workspace-1",
      documentId: created.documentId,
    });

    expect(reprocessed.status).toBe("queued");
    const persisted = await documentRepository.findByIdAndWorkspaceId(created.documentId, "workspace-1");
    expect(persisted?.revision).toBe(2);
    expect([...jobRepository.items.values()]).toHaveLength(2);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        eventType: "document.dispatch",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          documentId: created.documentId,
          revision: 2,
        }),
      }),
    );
  });

  it("marks a document failed after exhausting retries", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        {
          async replaceForDocument(): Promise<void> {
            throw new Error("chunk write failed");
          },
          async publishForDocumentRevision(): Promise<boolean> {
            throw new Error("chunk write failed");
          },
          async listForDocumentRevision() {
            return [];
          },
          async updateMetadataForDocumentRevision(): Promise<boolean> {
            return true;
          },
          async listSummariesForDocument() {
            return [];
          },
          async findByIdForDocument() {
            return null;
          },
        },
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultIngestionSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Broken",
      content: "Broken content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    expect(await processingWorker.runOnce(new Date(Date.now() + 2_000))).toBe(true);
    expect(await processingWorker.runOnce(new Date(Date.now() + 6_000))).toBe(true);

    const [document] = await documentRepository.listByWorkspaceId("workspace-1");
    expect(document.status).toBe("failed");
    expect([...jobRepository.items.values()].at(-1)?.status).toBe("failed");
  });

  it("stores an actionable provider credential failure reason without retrying", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      {
        async process() {
          throw {
            status: 401,
            code: "invalid_api_key",
            error: {
              message: "Incorrect API key provided.",
              code: "invalid_api_key",
            },
          };
        },
      } as any,
      auditService,
      createLogger("silent"),
    );

    await ingestionService.ingest({
      workspaceId: "workspace-1",
      title: "Provider failure",
      content: "Broken content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    // Credential errors are permanent — the worker should not burn retry
    // budget waiting for the operator to fix an .env value.
    expect(await processingWorker.runOnce(new Date(Date.now() + 2_000))).toBe(false);

    const [document] = await documentRepository.listByWorkspaceId("workspace-1");
    expect(document.status).toBe("failed");
    expect(document.failureReason).toBe(
      "The AI provider rejected the credentials. Replace the workspace API key at Settings → Credentials, or update the matching environment variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_COMPATIBLE_API_KEY) and restart Radioso.",
    );
    expect([...jobRepository.items.values()][0].attemptCount).toBe(1);
  });

  it("reprocesses imported documents from the stored original file", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const storage = new InMemoryDocumentStorage();
    const auditService = createAuditService();
    const importService = new DocumentImportService(documentRepository, auditService, storage);
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const sourceContentService = new DocumentSourceContentService(storage, async ({ buffer }) => ({
      fileType: "txt",
      text: buffer.toString("utf8"),
      markdown: buffer.toString("utf8"),
      sourceHints: {},
    }));
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultIngestionSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
        sourceContentService,
      ),
      auditService,
      createLogger("silent"),
    );

    const imported = await importService.importDocument({
      workspaceId: "workspace-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("First imported content"),
    });

    expect(await processingWorker.runOnce()).toBe(true);
    expect(chunkRepository.items.get(imported.documentId)?.[0]?.content).toContain("First imported content");

    const document = await documentRepository.findByIdAndWorkspaceId(imported.documentId, "workspace-1");
    expect(document?.sourceStorageObject).toBeTruthy();
    storage.objects.set(document!.sourceStorageObject!, {
      buffer: Buffer.from("Second imported content"),
      generation: document?.sourceStorageGeneration ?? "2",
      sizeBytes: 23,
    });

    await ingestionService.reprocess({
      workspaceId: "workspace-1",
      documentId: imported.documentId,
    });
    expect(await processingWorker.runOnce()).toBe(true);

    const current = await documentRepository.findByIdAndWorkspaceId(imported.documentId, "workspace-1");
    expect(current?.sourceContent).toBe("Second imported content");
    expect(chunkRepository.items.get(imported.documentId)?.[0]?.content).toContain("Second imported content");
  });

  it("does not downgrade a ready document during worker startup recovery", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Recovered",
      sourceContent: "Recovered content",
      markdownContent: "Recovered content",
      status: "ready",
    });
    const job = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    await jobRepository.claimNext();
    await documentRepository.setStatusIfRevisionMatches({
      documentId: document.id,
      workspaceId: document.workspaceId,
      revision: document.revision,
      status: "ready",
      failureReason: null,
    });

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        createDocumentEmbeddingPort({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultIngestionSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    await worker.start();
    await worker.stop();

    const recovered = await documentRepository.findByIdAndWorkspaceId(document.id, document.workspaceId);
    expect(recovered?.status).toBe("ready");
    expect(jobRepository.items.get(job.id)?.status).toBe("completed");
  });
});

describe("document retrieval eligibility", () => {
  const createReadyDocument = async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const auditService = createAuditService();
    const service = new DocumentIngestionService(documentRepository, auditService);
    const record = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Doc",
      sourceContent: "body",
      markdownContent: "body",
      status: "ready",
    });
    return { documentRepository, auditService, service, documentId: record.id };
  };

  it("disables a document for retrieval and records an audit event", async () => {
    const { service, auditService, documentId } = await createReadyDocument();

    const updated = await service.updateRetrievalEligibility({
      workspaceId: "workspace-1",
      documentId,
      retrievalEnabled: false,
    });

    expect(updated.retrievalEnabled).toBe(false);
    expect(updated.retrievalExpiresAt).toBeNull();
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "document.retrieval.update",
        eventStatus: "success",
        metadata: expect.objectContaining({ documentId, retrievalEnabled: false }),
      }),
    );
  });

  it("sets an expiry without touching the enable flag", async () => {
    const { service, documentId } = await createReadyDocument();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const updated = await service.updateRetrievalEligibility({
      workspaceId: "workspace-1",
      documentId,
      retrievalExpiresAt: expiresAt,
    });

    expect(updated.retrievalEnabled).toBe(true);
    expect(updated.retrievalExpiresAt).toEqual(expiresAt);
  });

  it("reconciles profile coverage after retrieval eligibility changes", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const reconcileWorkspace = vi.fn().mockResolvedValue({
      enqueued: 1,
      skipped: 0,
    });
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { reconcileWorkspace },
    );
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Doc",
      sourceContent: "body",
      markdownContent: "body",
      status: "ready",
    });

    await service.updateRetrievalEligibility({
      workspaceId: "workspace-1",
      documentId: document.id,
      retrievalEnabled: true,
    });

    expect(reconcileWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("clears an elapsed expiry when the document is re-enabled", async () => {
    const { service, documentId } = await createReadyDocument();
    const elapsed = new Date(Date.now() - 60 * 60 * 1000);
    await service.updateRetrievalEligibility({ workspaceId: "workspace-1", documentId, retrievalExpiresAt: elapsed });

    const updated = await service.updateRetrievalEligibility({
      workspaceId: "workspace-1",
      documentId,
      retrievalEnabled: true,
    });

    expect(updated.retrievalEnabled).toBe(true);
    expect(updated.retrievalExpiresAt).toBeNull();
  });

  it("keeps a future expiry when the document is re-enabled", async () => {
    const { service, documentId } = await createReadyDocument();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await service.updateRetrievalEligibility({
      workspaceId: "workspace-1",
      documentId,
      retrievalEnabled: false,
      retrievalExpiresAt: future,
    });

    const updated = await service.updateRetrievalEligibility({
      workspaceId: "workspace-1",
      documentId,
      retrievalEnabled: true,
    });

    expect(updated.retrievalEnabled).toBe(true);
    expect(updated.retrievalExpiresAt).toEqual(future);
  });

  it("throws when the document does not exist", async () => {
    const { service } = await createReadyDocument();

    await expect(
      service.updateRetrievalEligibility({
        workspaceId: "workspace-1",
        documentId: "00000000-0000-0000-0000-000000000000",
        retrievalEnabled: false,
      }),
    ).rejects.toThrow("Document not found");
  });
});

// Operator-authored document tags only reach the chunks at vectorize time, so a
// metadata replace has to requeue the document rather than write it in place.
describe("document metadata update", () => {
  const createService = () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const auditService = createAuditService();
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
      dispatchMany: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DocumentIngestionService(
      documentRepository,
      auditService,
      undefined,
      jobRepository,
      dispatcher,
    );
    return { documentRepository, jobRepository, auditService, dispatcher, service };
  };

  it("replaces the whole metadata record and requeues the document", async () => {
    const { service, documentRepository, jobRepository } = createService();
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Doc",
      sourceContent: "body",
      markdownContent: "body",
      status: "ready",
      metadata: { audience: "operators", stale: "drop me" },
    });

    const updated = await service.updateMetadata({
      workspaceId: "workspace-1",
      documentId: document.id,
      metadata: { audience: "admins", revision: 2 },
    });

    expect(updated.metadata).toEqual({ audience: "admins", revision: 2 });
    const stored = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
    expect(stored?.metadata).toEqual({ audience: "admins", revision: 2 });
    expect(stored?.status).toBe("queued");
    expect(stored?.revision).toBe(document.revision + 1);
    expect([...jobRepository.items.values()].filter((job) => job.documentId === document.id)).toHaveLength(1);
  });

  it("clears every tag when given an empty record", async () => {
    const { service, documentRepository } = createService();
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Doc",
      sourceContent: "body",
      markdownContent: "body",
      status: "ready",
      metadata: { audience: "operators" },
    });

    const updated = await service.updateMetadata({
      workspaceId: "workspace-1",
      documentId: document.id,
      metadata: {},
    });

    expect(updated.metadata).toEqual({});
  });

  it("is allowed for imported documents, which the inline update path rejects", async () => {
    const { service, documentRepository } = createService();
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Handbook",
      sourceContent: "",
      markdownContent: "",
      status: "ready",
      sourceKind: "uploaded_file",
      sourceFilename: "handbook.pdf",
      sourceMimeType: "application/pdf",
    });

    const updated = await service.updateMetadata({
      workspaceId: "workspace-1",
      documentId: document.id,
      metadata: { audience: "operators" },
    });

    expect(updated.metadata).toEqual({ audience: "operators" });
    expect((await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1"))?.status).toBe("queued");
  });

  it("dispatches the queued processing job and records an audit event", async () => {
    const { service, documentRepository, dispatcher, auditService } = createService();
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Doc",
      sourceContent: "body",
      markdownContent: "body",
      status: "ready",
    });

    await service.updateMetadata({
      workspaceId: "workspace-1",
      documentId: document.id,
      metadata: { audience: "operators" },
    });

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "document.metadata.update",
        eventStatus: "success",
        metadata: expect.objectContaining({ documentId: document.id }),
      }),
    );
  });

  it("rejects an unknown document", async () => {
    const { service } = createService();

    await expect(
      service.updateMetadata({
        workspaceId: "workspace-1",
        documentId: "00000000-0000-0000-0000-000000000000",
        metadata: {},
      }),
    ).rejects.toThrow("Document not found");
  });
});

const fixedWindowStrategy: ChunkingStrategy = {
  id: "fixed_window",
  async chunk(input) {
    return [
      {
        chunkIndex: 0,
        content: input.content,
        startOffset: 0,
        endOffset: input.content.length,
      },
    ];
  },
};
