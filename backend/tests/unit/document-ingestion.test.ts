import { describe, expect, it, vi } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../src/modules/documents/services/documentSourceContentService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
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
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        new EmbeddingService({
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
      title: "Ready soon",
      content: "Ready soon",
    });

    expect(queued.status).toBe("queued");
    expect(await processingWorker.runOnce()).toBe(true);

    const [document] = await documentRepository.listByWorkspaceId("workspace-1");
    expect(document.status).toBe("ready");
    expect(chunkRepository.items.get(document.id)).toHaveLength(1);
  });

  it("uses the workspace embedding model when processing document chunks", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const seenModels: Array<string | undefined> = [];
    const ingestionService = new DocumentIngestionService(documentRepository, auditService);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        new EmbeddingService({
          async embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]> {
            seenModels.push(options?.model);
            return texts.map(() => [1, 2, 3]);
          },
        }),
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
    expect(seenModels).toEqual(["text-embedding-3-large"]);
  });

  it("uses a pending embedding model for reprocessed document chunks before promotion", async () => {
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
        new EmbeddingService({
          async embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]> {
            seenModels.push(options?.model);
            return texts.map(() => [1, 2, 3]);
          },
        }),
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
    expect(seenModels).toEqual(["text-embedding-3-large"]);
    expect(chunkRepository.items.get((await documentRepository.listByWorkspaceId("workspace-1"))[0]!.id)?.[0]?.embeddingModel).toBe("text-embedding-3-large");
    expect(promotePendingEmbeddingModelIfReady).toHaveBeenCalledWith("workspace-1");
  });

  it("skips stale jobs when a newer revision is queued", async () => {
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
        new EmbeddingService({
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
    const service = new DocumentIngestionService(documentRepository, auditService, () => jobRepository.getQueueSnapshot());

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
      new EmbeddingService({
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
    );

    const olderJob = await jobRepository.claimNext();
    expect(olderJob?.documentRevision).toBe(1);
    expect(await processingService.process(olderJob!)).toBe("stale");

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "workspace-1");
    expect(current?.status).toBe("ready");
    expect(current?.revision).toBe(2);
    expect(chunkRepository.items.get(first.documentId)?.[0]?.content).toContain("Second content");
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
        new EmbeddingService({
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
        enrichment: { status: "applied" },
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
    const stage = {
      enrich: vi.fn().mockResolvedValue({
        status: "applied",
        documentMetadata: {
          sourceUrl: "https://events.example/event",
          enrichment: { status: "applied", shape: "event", factCount: 1, appliedChunkCount: 1 },
        },
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
      new EmbeddingService({
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
    );

    const firstJob = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: document.revision,
    });
    expect(await service.process(firstJob)).toBe("completed");
    expect(stage.enrich).toHaveBeenCalledOnce();

    await documentRepository.requeueAndQueue(document.id, "workspace-1", { documentEnrichmentOverride: "off" });
    const offJob = await jobRepository.findByDocumentRevision({
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: 2,
    });
    stage.enrich.mockClear();

    expect(await service.process(offJob!)).toBe("completed");
    expect(stage.enrich).not.toHaveBeenCalled();
    const current = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
    expect(current?.metadata).toEqual({ sourceUrl: "https://events.example/event" });
    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toEqual({ sourceUrl: "https://events.example/event" });

    stage.enrich.mockImplementationOnce(async (input) => ({
      status: "failed",
      documentMetadata: {
        ...input.document.metadata,
        enrichment: { status: "failed", failureReason: "invalid_output", factCount: 0, appliedChunkCount: 0 },
      },
      chunks: input.chunks,
      factCount: 0,
      appliedChunkCount: 0,
    }));
    await documentRepository.requeueAndQueue(document.id, "workspace-1", { documentEnrichmentOverride: "on" });
    const failedJob = await jobRepository.findByDocumentRevision({
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: 3,
    });

    expect(await service.process(failedJob!)).toBe("completed");
    const failedCurrent = await documentRepository.findByIdAndWorkspaceId(document.id, "workspace-1");
    expect(failedCurrent?.metadata).toEqual({
      sourceUrl: "https://events.example/event",
      enrichment: { status: "failed", failureReason: "invalid_output", factCount: 0, appliedChunkCount: 0 },
    });
    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toEqual({ sourceUrl: "https://events.example/event" });
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
          async listSummariesForDocument() {
            return [];
          },
          async findByIdForDocument() {
            return null;
          },
        },
        new EmbeddingService({
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
        new EmbeddingService({
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
        new EmbeddingService({
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
