import { describe, expect, it, vi } from "vitest";

import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import type { DocumentEnrichmentStagePort } from "../../src/modules/documents/services/documentEnrichmentService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import type { DocumentProcessingJobRecord } from "../../src/db/repositories/documentProcessingJobRepository.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentSourceRepository,
} from "../support/fakes.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";

const singleChunkStrategy = (): ChunkingStrategy => ({
  id: "structured_semantic",
  async chunk() {
    return [
      {
        chunkIndex: 0,
        content: "Summer workshop introduction.",
        startOffset: 0,
        endOffset: 29,
      },
      {
        chunkIndex: 1,
        content: "The event runs on 2026-07-17.",
        startOffset: 30,
        endOffset: 59,
      },
    ];
  },
});

const buildEmbeddingService = (persisted: string[]) =>
  createDocumentEmbeddingPort({
    async embedTexts(texts: string[]): Promise<number[][]> {
      persisted.push(...texts);
      return texts.map(() => [1, 2, 3]);
    },
  });

const buildVectorizeJob = (
  documentId: string,
  revision: number,
  overrides: Partial<DocumentProcessingJobRecord> = {},
): DocumentProcessingJobRecord => ({
  id: "job-vectorize",
  documentId,
  workspaceId: "workspace-1",
  documentRevision: revision,
  kind: "vectorize",
  status: "processing",
  attemptCount: 1,
  lastError: null,
  availableAt: new Date(),
  claimedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  options: null,
  ...overrides,
});

const buildEnrichJob = (
  documentId: string,
  revision: number,
  overrides: Partial<DocumentProcessingJobRecord> = {},
): DocumentProcessingJobRecord => ({
  ...buildVectorizeJob(documentId, revision, overrides),
  id: overrides.id ?? "job-enrich",
  kind: "enrich",
});

const buildCountingStage = (): { stage: DocumentEnrichmentStagePort; calls: () => number } => {
  let calls = 0;
  const stage: DocumentEnrichmentStagePort = {
    async enrich(input) {
      calls += 1;
      return alwaysAppliesFirstChunkDate.enrich(input);
    },
  };
  return { stage, calls: () => calls };
};

const alwaysAppliesFirstChunkDate: DocumentEnrichmentStagePort = {
  async enrich({ chunks }) {
    return {
      status: "applied",
      documentMetadata: { dateFrom: "2026-07-17", dateTo: "2026-07-19" },
      provenance: {
        status: "applied" as const,
        shape: "event" as const,
        model: "gpt-5.2",
        enrichedAt: "2026-07-02T12:00:00.000Z",
        anchorDate: "2026-07-02",
        anchorSource: "document_created_at" as const,
        factCount: 1,
        appliedChunkCount: 1,
        failureReason: null,
      },
      chunks: chunks.map((chunk) =>
        chunk.chunkIndex === 1
          ? { ...chunk, metadata: { ...(chunk.metadata ?? {}), dateFrom: "2026-07-17", dateTo: "2026-07-19" } }
          : chunk,
      ),
      factCount: 1,
      appliedChunkCount: 1,
    };
  },
};

const settingsReader = (
  documentEnrichmentEnabled: boolean,
  manualDocumentEnrichmentOverride: "inherit" | "on" | "off" = "inherit",
) => ({
  async getForWorkspace(workspaceId: string) {
    return {
      ...defaultIngestionSettings(workspaceId),
      chunkingStrategy: "structured_semantic" as const,
      documentEnrichmentEnabled,
      manualDocumentEnrichmentOverride,
    };
  },
});

// Documents created without a sourceId are the "manually added" documents that
// have no document_sources row to carry a source-level override.
const countEnrichJobsForManualDocument = async (input: {
  workspaceEnrichmentEnabled: boolean;
  manualDocumentEnrichmentOverride: "inherit" | "on" | "off";
  jobOverride?: "on" | "off";
}): Promise<number> => {
  const documentRepository = new InMemoryDocumentRepository();
  const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(jobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);

  const document = await documentRepository.create({
    workspaceId: "workspace-1",
    title: "Summer Workshop",
    sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
    markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
    status: "queued",
  });

  const service = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    buildEmbeddingService([]),
    createAuditService(),
    settingsReader(input.workspaceEnrichmentEnabled, input.manualDocumentEnrichmentOverride),
    new ChunkingStrategyRegistry([singleChunkStrategy()]),
    undefined,
    undefined,
    alwaysAppliesFirstChunkDate,
    undefined,
    jobRepository,
  );

  await service.process(buildVectorizeJob(document.id, document.revision, {
    options: input.jobOverride ? { documentEnrichmentOverride: input.jobOverride } : null,
  }));

  return [...jobRepository.items.values()].filter((job) => job.kind === "enrich").length;
};

describe("manually added document enrichment override", () => {
  it("enriches when the manual override is on and the workspace default is off", async () => {
    expect(await countEnrichJobsForManualDocument({
      workspaceEnrichmentEnabled: false,
      manualDocumentEnrichmentOverride: "on",
    })).toBe(1);
  });

  it("skips enrichment when the manual override is off and the workspace default is on", async () => {
    expect(await countEnrichJobsForManualDocument({
      workspaceEnrichmentEnabled: true,
      manualDocumentEnrichmentOverride: "off",
    })).toBe(0);
  });

  it("follows the workspace default when the manual override inherits", async () => {
    expect(await countEnrichJobsForManualDocument({
      workspaceEnrichmentEnabled: true,
      manualDocumentEnrichmentOverride: "inherit",
    })).toBe(1);
    expect(await countEnrichJobsForManualDocument({
      workspaceEnrichmentEnabled: false,
      manualDocumentEnrichmentOverride: "inherit",
    })).toBe(0);
  });

  it("lets a per-run job override win over the manual override", async () => {
    expect(await countEnrichJobsForManualDocument({
      workspaceEnrichmentEnabled: false,
      manualDocumentEnrichmentOverride: "off",
      jobOverride: "on",
    })).toBe(1);
    expect(await countEnrichJobsForManualDocument({
      workspaceEnrichmentEnabled: true,
      manualDocumentEnrichmentOverride: "on",
      jobOverride: "off",
    })).toBe(0);
  });
});

describe("document processing enrichment split", () => {
  it("vectorize job publishes ready without running enrichment and enqueues one enrich job when enabled", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const persistedSearchTexts: string[] = [];
    const { stage, calls } = buildCountingStage();

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "queued",
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService(persistedSearchTexts),
      createAuditService(),
      settingsReader(true),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      stage,
      undefined,
      jobRepository,
    );

    const outcome = await service.process(buildVectorizeJob(document.id, document.revision));

    expect(outcome).toBe("completed");
    expect(calls()).toBe(0);
    // No extracted date metadata is folded into the embedded search text.
    expect(persistedSearchTexts.some((text) => text.includes("Date from: 2026-07-17"))).toBe(false);
    expect(documentRepository.items.get(document.id)?.status).toBe("ready");

    const enrichJobs = [...jobRepository.items.values()].filter((job) => job.kind === "enrich");
    expect(enrichJobs).toHaveLength(1);
    expect(enrichJobs[0]).toMatchObject({
      documentId: document.id,
      documentRevision: document.revision,
      kind: "enrich",
    });
  });

  it("vectorize job enqueues no enrich job when enrichment is disabled", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "queued",
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService([]),
      createAuditService(),
      settingsReader(false),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      alwaysAppliesFirstChunkDate,
      undefined,
      jobRepository,
    );

    await service.process(buildVectorizeJob(document.id, document.revision));

    expect([...jobRepository.items.values()].filter((job) => job.kind === "enrich")).toHaveLength(0);
  });

  it("enrich job applies extracted dates to document and chunk metadata without re-embedding", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const persistedSearchTexts: string[] = [];

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "queued",
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService(persistedSearchTexts),
      createAuditService(),
      settingsReader(true),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      alwaysAppliesFirstChunkDate,
      undefined,
      jobRepository,
    );

    await service.process(buildVectorizeJob(document.id, document.revision));
    const searchTextsAfterVectorize = persistedSearchTexts.length;

    const outcome = await service.processEnrichment(buildEnrichJob(document.id, document.revision));

    expect(outcome).toBe("completed");
    // No re-embedding on the enrich path.
    expect(persistedSearchTexts).toHaveLength(searchTextsAfterVectorize);

    expect(documentRepository.items.get(document.id)?.metadata).toMatchObject({
      dateFrom: "2026-07-17",
      dateTo: "2026-07-19",
    });
    expect(documentRepository.items.get(document.id)?.enrichment).toMatchObject({ status: "applied" });

    const chunks = chunkRepository.items.get(document.id) ?? [];
    const secondChunk = chunks.find((chunk) => chunk.chunkIndex === 1);
    expect(secondChunk?.metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    // Document stays ready throughout.
    expect(documentRepository.items.get(document.id)?.status).toBe("ready");
  });

  it("skips a stale-revision enrich job without error", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const { stage, calls } = buildCountingStage();

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "ready",
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService([]),
      createAuditService(),
      settingsReader(true),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      stage,
      undefined,
      jobRepository,
    );

    // Job targets an older revision than the document currently has.
    const outcome = await service.processEnrichment(buildEnrichJob(document.id, document.revision - 1));

    expect(outcome).toBe("stale");
    expect(calls()).toBe(0);
  });

  it("leaves the document ready when an enrich job fails permanently in the worker", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
    });
    const enrichJob = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
      kind: "enrich",
    });
    // Exhaust retries so failure is terminal on this run.
    jobRepository.items.set(enrichJob.id, { ...jobRepository.items.get(enrichJob.id)!, attemptCount: 3 });

    const processingService = {
      process: vi.fn(),
      processEnrichment: vi.fn().mockRejectedValue(new Error("enrichment persistence failed")),
    };
    const markFailedIfDocumentMatches = vi.spyOn(jobRepository, "markFailedIfDocumentMatches");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      processingService as never,
      createAuditService(),
      logger as never,
      10_000,
    );

    await worker.runOnce(new Date());

    expect(processingService.processEnrichment).toHaveBeenCalledOnce();
    expect(processingService.process).not.toHaveBeenCalled();
    // The document must stay queryable — enrich failure never flips it to failed.
    expect(documentRepository.items.get(document.id)?.status).toBe("ready");
    expect(markFailedIfDocumentMatches).not.toHaveBeenCalled();
    expect(jobRepository.items.get(enrichJob.id)?.status).toBe("failed");
  });

  it("dispatches the enrich job so task-server deployments run it promptly", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const { stage } = buildCountingStage();
    const dispatch = vi.fn().mockResolvedValue(undefined);

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "queued",
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService([]),
      createAuditService(),
      settingsReader(true),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      stage,
      undefined,
      jobRepository,
      { dispatch, dispatchMany: vi.fn() },
    );

    await service.process(buildVectorizeJob(document.id, document.revision));

    const enrichJobs = [...jobRepository.items.values()].filter((job) => job.kind === "enrich");
    expect(enrichJobs).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ jobId: enrichJobs[0]!.id }));
  });

  it("vectorize retry after enrich enqueue is idempotent and never duplicates the enrich job", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const { stage } = buildCountingStage();

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "queued",
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService([]),
      createAuditService(),
      settingsReader(true),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      stage,
      undefined,
      jobRepository,
    );

    const job = buildVectorizeJob(document.id, document.revision);
    await service.process(job);
    // Simulate a transient failure after enqueue (e.g. markCompleted failed) that
    // re-runs the same vectorize job; the second run must not throw or duplicate.
    await expect(service.process(job)).resolves.toBe("completed");

    const enrichJobs = [...jobRepository.items.values()].filter((j) => j.kind === "enrich");
    expect(enrichJobs).toHaveLength(1);
  });

  it("on restart, an in-flight enrich job for a ready document is rescheduled, not completed", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
    });
    const enrichJob = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
      kind: "enrich",
    });
    // Worker died mid-enrichment: the job is in flight ("processing").
    jobRepository.items.set(enrichJob.id, { ...jobRepository.items.get(enrichJob.id)!, status: "processing" });

    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      { process: vi.fn(), processEnrichment: vi.fn() } as never,
      createAuditService(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    );

    await worker.start();
    await worker.stop();

    // Readiness is not proof the enrichment ran: the job must run again, and the
    // document must stay ready.
    expect(jobRepository.items.get(enrichJob.id)?.status).toBe("queued");
    expect(jobRepository.items.get(enrichJob.id)?.completedAt).toBeNull();
    expect(documentRepository.items.get(document.id)?.status).toBe("ready");
  });
});

// Source-level document tags are stamped onto the CHUNK metadata projection at
// vectorize time and never written back to documents.metadata. Document-own
// keys win over source keys.
describe("source-level document tags", () => {
  const buildSourceScopedService = async (input: {
    sourceDocumentMetadata?: Record<string, unknown>;
    documentMetadata?: Record<string, unknown>;
    persistedSearchTexts?: string[];
  }) => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const sourceRepository = new InMemoryDocumentSourceRepository();
    sourceRepository.setDocumentRepository(documentRepository);

    const source = await sourceRepository.upsertByExternalId({
      workspaceId: "workspace-1",
      kind: "website",
      name: "Handbook site",
      externalId: "handbook-site",
      config: input.sourceDocumentMetadata ? { documentMetadata: input.sourceDocumentMetadata } : {},
    });

    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      markdownContent: "Summer workshop introduction.\n\nThe event runs on 2026-07-17.",
      status: "queued",
      sourceId: source.id,
      metadata: input.documentMetadata,
    });

    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      buildEmbeddingService(input.persistedSearchTexts ?? []),
      createAuditService(),
      settingsReader(false),
      new ChunkingStrategyRegistry([singleChunkStrategy()]),
      undefined,
      undefined,
      alwaysAppliesFirstChunkDate,
      sourceRepository,
      jobRepository,
    );

    return { service, document, documentRepository, chunkRepository, sourceRepository };
  };

  it("stamps source tags onto every chunk", async () => {
    const { service, document, chunkRepository } = await buildSourceScopedService({
      sourceDocumentMetadata: { region: "eu", tier: 2, active: true },
    });

    await service.process(buildVectorizeJob(document.id, document.revision));

    const chunks = chunkRepository.items.get(document.id) ?? [];
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.metadata).toMatchObject({ region: "eu", tier: 2, active: true });
    }
  });

  it("lets document-own keys win over source keys", async () => {
    const { service, document, chunkRepository } = await buildSourceScopedService({
      sourceDocumentMetadata: { region: "eu", audience: "everyone" },
      documentMetadata: { audience: "operators" },
    });

    await service.process(buildVectorizeJob(document.id, document.revision));

    const chunks = chunkRepository.items.get(document.id) ?? [];
    expect(chunks[0]?.metadata).toEqual({ region: "eu", audience: "operators" });
  });

  it("never writes source tags back to documents.metadata", async () => {
    const { service, document, documentRepository } = await buildSourceScopedService({
      sourceDocumentMetadata: { region: "eu" },
      documentMetadata: { audience: "operators" },
    });

    await service.process(buildVectorizeJob(document.id, document.revision));

    expect(documentRepository.items.get(document.id)?.metadata).toEqual({ audience: "operators" });
  });

  // The merged map is what feeds renderMetadataSearchText. That renderer
  // projects a fixed key set (dates, url, author), so a source tag reaches the
  // embedded text only for those keys; arbitrary tags stay filter-only.
  it("folds source tags into the embedded search text for keys the renderer projects", async () => {
    const persistedSearchTexts: string[] = [];
    const { service, document } = await buildSourceScopedService({
      sourceDocumentMetadata: { author: "Radioso Docs Team", region: "eu" },
      persistedSearchTexts,
    });

    await service.process(buildVectorizeJob(document.id, document.revision));

    expect(persistedSearchTexts.some((text) => text.includes("Author: Radioso Docs Team"))).toBe(true);
    expect(persistedSearchTexts.some((text) => text.includes("eu"))).toBe(false);
  });

  it("leaves chunk metadata untouched when the source carries no tags", async () => {
    const { service, document, chunkRepository } = await buildSourceScopedService({
      documentMetadata: { audience: "operators" },
    });

    await service.process(buildVectorizeJob(document.id, document.revision));

    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toEqual({ audience: "operators" });
  });

  it("keeps source tags on chunks after the enrich pass merges extracted facts", async () => {
    const { service, document, chunkRepository } = await buildSourceScopedService({
      sourceDocumentMetadata: { region: "eu" },
    });

    await service.process(buildVectorizeJob(document.id, document.revision));
    await service.processEnrichment(buildEnrichJob(document.id, document.revision));

    const chunks = chunkRepository.items.get(document.id) ?? [];
    const secondChunk = chunks.find((chunk) => chunk.chunkIndex === 1);
    expect(secondChunk?.metadata).toMatchObject({
      region: "eu",
      dateFrom: "2026-07-17",
      dateTo: "2026-07-19",
    });
  });
});
