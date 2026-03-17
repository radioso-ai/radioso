import { describe, expect, it } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { createLogger } from "../../src/shared/observability/logger.js";

describe("document ingestion", () => {
  it("queues new documents instead of processing them inline", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const service = new DocumentIngestionService(documentRepository, createAuditService());

    const response = await service.ingest({
      workspaceId: "account-1",
      title: "Queued",
      content: "Queued content",
    });

    expect(response.status).toBe("queued");
    const [document] = await documentRepository.listByWorkspaceId("account-1");
    expect(document.status).toBe("queued");
    expect(document.revision).toBe(1);
    expect([...jobRepository.items.values()]).toHaveLength(1);
  });

  it("does not persist a new document when durable queue creation fails", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
    );

    jobRepository.enqueue = async () => {
      throw new Error("queue unavailable");
    };

    await expect(
      service.ingest({
        workspaceId: "account-1",
        title: "Broken queue",
        content: "Broken queue content",
      }),
    ).rejects.toThrow("queue unavailable");

    expect(await documentRepository.listByWorkspaceId("account-1")).toHaveLength(0);
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
            return defaultRetrievalSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    const queued = await ingestionService.ingest({
      workspaceId: "account-1",
      title: "Ready soon",
      content: "Ready soon",
    });

    expect(queued.status).toBe("queued");
    expect(await processingWorker.runOnce()).toBe(true);

    const [document] = await documentRepository.listByWorkspaceId("account-1");
    expect(document.status).toBe("ready");
    expect(chunkRepository.items.get(document.id)).toHaveLength(1);
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
            return defaultRetrievalSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    const first = await ingestionService.ingest({
      workspaceId: "account-1",
      title: "Versioned",
      content: "First content",
    });

    await ingestionService.update({
      workspaceId: "account-1",
      documentId: first.documentId,
      title: "Versioned",
      content: "Second content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    const afterFirstRun = await documentRepository.findByIdAndWorkspaceId(first.documentId, "account-1");
    expect(afterFirstRun?.status).toBe("queued");

    expect(await processingWorker.runOnce()).toBe(true);
    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "account-1");
    expect(current?.status).toBe("ready");
    expect(current?.revision).toBe(2);
    expect(chunkRepository.items.get(first.documentId)?.[0]?.content).toContain("Second content");
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
      workspaceId: "account-1",
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
              workspaceId: "account-1",
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
          return defaultRetrievalSettings(workspaceId);
        },
      },
      new ChunkingStrategyRegistry([fixedWindowStrategy]),
    );

    const olderJob = await jobRepository.claimNext();
    expect(olderJob?.documentRevision).toBe(1);
    expect(await processingService.process(olderJob!)).toBe("stale");

    const current = await documentRepository.findByIdAndWorkspaceId(first.documentId, "account-1");
    expect(current?.status).toBe("ready");
    expect(current?.revision).toBe(2);
    expect(chunkRepository.items.get(first.documentId)?.[0]?.content).toContain("Second content");
  });

  it("returns not_found when update loses a delete race", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const service = new DocumentIngestionService(documentRepository, createAuditService());
    const document = await documentRepository.create({
      workspaceId: "account-1",
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
        workspaceId: "account-1",
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

  it("returns not_found when reprocess loses a delete race", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const service = new DocumentIngestionService(documentRepository, createAuditService());
    const document = await documentRepository.create({
      workspaceId: "account-1",
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
        workspaceId: "account-1",
        documentId: document.id,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      statusCode: 404,
      message: "Document not found",
    });
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
        },
        new EmbeddingService({
          async embedTexts(texts: string[]): Promise<number[][]> {
            return texts.map(() => [1, 2, 3]);
          },
        }),
        auditService,
        {
          async getForWorkspace(workspaceId: string) {
            return defaultRetrievalSettings(workspaceId);
          },
        },
        new ChunkingStrategyRegistry([fixedWindowStrategy]),
      ),
      auditService,
      createLogger("silent"),
    );

    await ingestionService.ingest({
      workspaceId: "account-1",
      title: "Broken",
      content: "Broken content",
    });

    expect(await processingWorker.runOnce()).toBe(true);
    expect(await processingWorker.runOnce(new Date(Date.now() + 2_000))).toBe(true);
    expect(await processingWorker.runOnce(new Date(Date.now() + 6_000))).toBe(true);

    const [document] = await documentRepository.listByWorkspaceId("account-1");
    expect(document.status).toBe("failed");
    expect([...jobRepository.items.values()].at(-1)?.status).toBe("failed");
  });

  it("does not downgrade a ready document during worker startup recovery", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const document = await documentRepository.create({
      workspaceId: "account-1",
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
            return defaultRetrievalSettings(workspaceId);
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
