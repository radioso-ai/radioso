import { describe, expect, it, vi } from "vitest";

import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { createAuditService, InMemoryDocumentProcessingJobRepository, InMemoryDocumentRepository } from "../support/fakes.js";

describe("document processing worker runtime signals", () => {
  it("logs the initial queue snapshot when the worker starts", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Queued",
      sourceContent: "Queued content",
      markdownContent: "Queued content",
      status: "queued",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    await jobRepository.enqueue({
      documentId: [...documentRepository.items.keys()][0],
      workspaceId: "workspace-1",
      documentRevision: 1,
    });

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      {
        process: vi.fn().mockResolvedValue("completed"),
      } as any,
      createAuditService(),
      logger as any,
      10_000,
    );

    await worker.start();
    await worker.stop();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        queuedJobCount: 1,
        processingJobCount: 0,
      }),
      "Document processing worker started",
    );
  });

  it("repairs queued documents that are missing processing jobs", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Orphaned queue entry",
      sourceContent: "Recovered content",
      markdownContent: "Recovered content",
      status: "queued",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      {
        process: vi.fn().mockResolvedValue("completed"),
      } as any,
      createAuditService(),
      logger as any,
      10_000,
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect([...jobRepository.items.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: document.id,
          documentRevision: document.revision,
          status: "completed",
        }),
      ]),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        repairedJobCount: 1,
      }),
      "Document processing worker repaired missing queued jobs",
    );
  });

  it("emits worker telemetry for processing failures and retries", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const telemetryService = {
      emit: vi.fn().mockResolvedValue(null),
    };
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Retry me",
      sourceContent: "Retry me",
      markdownContent: "Retry me",
      status: "queued",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      {
        process: vi.fn().mockRejectedValue(new Error("embedding timeout")),
      } as any,
      createAuditService(),
      logger as any,
      10_000,
      undefined,
      undefined,
      telemetryService as any,
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(telemetryService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "document.worker.processing",
        tags: { outcome: "processing" },
      }),
    );
    expect(telemetryService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "document.worker.job_failed",
        tags: { outcome: "retry_scheduled" },
      }),
    );
  });
});
