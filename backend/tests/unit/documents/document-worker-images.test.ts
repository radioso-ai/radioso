import { createNoopWorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import { describe, expect, it, vi } from "vitest";

import {
  DocumentProcessingWorker,
  type DocumentImageCaptureStage,
} from "../../../src/modules/documents/services/documentProcessingWorker.js";
import type { DocumentProcessingService } from "../../../src/modules/documents/services/documentProcessingService.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import {
  createAuditService,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../../support/fakes.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const setup = async (kind: "vectorize" | "enrich" | "images", processOutcome: "completed" | Error = "completed") => {
  const documentRepository = new InMemoryDocumentRepository();
  const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(jobRepository);
  const document = await documentRepository.create({
    status: "queued",
    workspaceId: WORKSPACE_ID,
    title: "Alpine Flowers",
    sourceContent: "Text",
    markdownContent: "Text",
    sourceKind: "inline_text",
    sourceFilename: null,
    sourceMimeType: "text/plain",
    sourceStorageBucket: null,
    sourceStorageObject: null,
    sourceStorageGeneration: null,
    sourceSizeBytes: null,
  });
  const job = kind === "vectorize"
    ? await jobRepository.enqueue({ documentId: document.id, workspaceId: WORKSPACE_ID, documentRevision: document.revision })
    : await jobRepository.ensureFollowUpJob({ kind, documentId: document.id, workspaceId: WORKSPACE_ID, documentRevision: document.revision });
  const run = () => processOutcome instanceof Error ? Promise.reject(processOutcome) : Promise.resolve(processOutcome);
  const processingService = { process: vi.fn(run), processEnrichment: vi.fn(run) } as unknown as DocumentProcessingService;
  const imageCapture: DocumentImageCaptureStage = {
    capture: vi.fn(run),
    afterRevisionPublished: vi.fn().mockResolvedValue(undefined),
    sweepReleased: vi.fn().mockResolvedValue(undefined),
  };
  const worker = new DocumentProcessingWorker(
    documentRepository,
    jobRepository,
    processingService,
    createAuditService(),
    createLogger("silent"),
    1_000,
    { dispatch: vi.fn().mockResolvedValue(undefined), dispatchMany: vi.fn().mockResolvedValue(undefined) },
    300_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createNoopWorkspaceInvalidationPublisher(),
    imageCapture,
  );
  return { worker, job, jobRepository, imageCapture, processingService };
};

describe("the document worker's image stage", () => {
  it("runs an images job through capture and completes it", async () => {
    const { worker, job, jobRepository, imageCapture, processingService } = await setup("images");

    await worker.runJobById(job.id);

    expect(imageCapture.capture).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, kind: "images" }));
    expect(processingService.process).not.toHaveBeenCalled();
    expect(jobRepository.items.get(job.id)?.status).toBe("completed");
  });

  it("queues capture once a vectorize job has published the revision, and only then", async () => {
    const vectorize = await setup("vectorize");
    const enrich = await setup("enrich");

    await vectorize.worker.runJobById(vectorize.job.id);
    await enrich.worker.runJobById(enrich.job.id);

    expect(vectorize.imageCapture.afterRevisionPublished).toHaveBeenCalledWith(expect.objectContaining({ id: vectorize.job.id }));
    expect(enrich.imageCapture.afterRevisionPublished).not.toHaveBeenCalled();
  });

  it("sweeps released images after every job, a failed one included", async () => {
    const { worker, job, imageCapture } = await setup("vectorize", new Error("provider unavailable"));

    await worker.runJobById(job.id);

    expect(imageCapture.afterRevisionPublished).not.toHaveBeenCalled();
    expect(imageCapture.sweepReleased).toHaveBeenCalledTimes(1);
  });
});
