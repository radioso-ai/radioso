import { describe, expect, it, vi } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import type { ProviderUsage } from "../../src/shared/infra/llm/providerTypes.js";
import type { EmbeddingUsageEvent, ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";

class RecordingUsageEventRecorder implements UsageEventRecorder {
  readonly embeddings: EmbeddingUsageEvent[] = [];

  async recordEmbedding(event: EmbeddingUsageEvent): Promise<void> {
    this.embeddings.push(event);
  }

  async recordModelCall(_event: ModelUsageEvent): Promise<void> {}
}

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

const createProcessingService = (input: {
  documentRepository: InMemoryDocumentRepository;
  chunkRepository: InMemoryChunkRepository;
  auditService: ReturnType<typeof createAuditService>;
  recorder: RecordingUsageEventRecorder;
  embedTexts: (texts: string[]) => Promise<number[][]>;
  providerUsage?: ProviderUsage;
}) =>
  new DocumentProcessingService(
    input.documentRepository,
    input.chunkRepository,
    new EmbeddingService({
      embedTexts: input.embedTexts,
      async embedTextsWithUsage(texts) {
        return {
          vectors: await input.embedTexts(texts),
          usage: input.providerUsage,
        };
      },
    }),
    input.auditService,
    {
      async getForWorkspace(workspaceId: string) {
        return defaultIngestionSettings(workspaceId);
      },
    },
    new ChunkingStrategyRegistry([fixedWindowStrategy]),
    undefined,
    undefined,
    input.recorder,
    {
      identifyForModel(model: string) {
        return { provider: "openai", model };
      },
    },
  );

describe("document processing usage metering", () => {
  it("records successful embedding usage with provider identity and chunk-scoped idempotency", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const recorder = new RecordingUsageEventRecorder();
    const ingestion = new DocumentIngestionService(documentRepository, auditService);

    await ingestion.ingest({
      workspaceId: "workspace-1",
      title: "Doc",
      content: "Content",
    });

    const job = await jobRepository.claimNext();
    const service = createProcessingService({
      documentRepository,
      chunkRepository,
      auditService,
      recorder,
      embedTexts: async (texts) => texts.map(() => [1, 2, 3]),
    });

    await service.process(job!);

    expect(recorder.embeddings).toHaveLength(1);
    expect(recorder.embeddings[0]).toEqual(expect.objectContaining({
      provider: "openai",
      status: "succeeded",
      usageQuality: "estimated",
    }));
    expect(recorder.embeddings[0]?.idempotencyKey).toContain(`:${job!.id}:chunks:`);
    expect(recorder.embeddings[0]?.idempotencyKey).not.toContain(":batch:");
  });

  it("records actual provider embedding usage when the adapter reports it", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const recorder = new RecordingUsageEventRecorder();
    const ingestion = new DocumentIngestionService(documentRepository, auditService);

    await ingestion.ingest({
      workspaceId: "workspace-1",
      title: "Doc",
      content: "Content",
    });

    const job = await jobRepository.claimNext();
    const service = createProcessingService({
      documentRepository,
      chunkRepository,
      auditService,
      recorder,
      embedTexts: async (texts) => texts.map(() => [1, 2, 3]),
      providerUsage: {
        inputTokens: 7,
        totalTokens: 7,
        quality: "actual",
        providerRequestId: "embed-req-1",
      },
    });

    await service.process(job!);

    expect(recorder.embeddings).toHaveLength(1);
    expect(recorder.embeddings[0]).toEqual(expect.objectContaining({
      inputTokens: 7,
      providerRequestId: "embed-req-1",
      usageQuality: "actual",
    }));
  });

  it("records failed embedding usage before surfacing provider errors", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const recorder = new RecordingUsageEventRecorder();
    const ingestion = new DocumentIngestionService(documentRepository, auditService);

    await ingestion.ingest({
      workspaceId: "workspace-1",
      title: "Doc",
      content: "Content",
    });

    const job = await jobRepository.claimNext();
    const service = createProcessingService({
      documentRepository,
      chunkRepository,
      auditService,
      recorder,
      embedTexts: vi.fn().mockRejectedValue(new Error("provider down")),
    });

    await expect(service.process(job!)).rejects.toThrow("provider down");

    expect(recorder.embeddings).toHaveLength(1);
    expect(recorder.embeddings[0]).toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "Error",
    }));
    expect(recorder.embeddings[0]?.idempotencyKey).toContain(":failed");
  });
});
