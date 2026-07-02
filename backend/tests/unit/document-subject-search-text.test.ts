import { describe, expect, it } from "vitest";

import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import type { DocumentEnrichmentStagePort } from "../../src/modules/documents/services/documentEnrichmentService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";

describe("document subject search text", () => {
  it("anchors later chunks to the document subject even when the chunk text omits the subject name", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const persistedSearchTexts: string[] = [];
    const embeddingService = new EmbeddingService({
      async embedTexts(texts: string[]): Promise<number[][]> {
        persistedSearchTexts.push(...texts);
        return texts.map(() => [1, 2, 3]);
      },
    });
    const strategy: ChunkingStrategy = {
      id: "structured_semantic",
      async chunk() {
        return [
          {
            chunkIndex: 0,
            content: "## Premi\nPremi teaches meditation in summer camps.",
            startOffset: 0,
            endOffset: 49,
          },
          {
            chunkIndex: 1,
            content: "In September 2015 she took the vows as Nayaswami.",
            startOffset: 50,
            endOffset: 101,
          },
        ];
      },
    };
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "| Generic Catalog |",
      sourceContent: "## Premi\nPremi teaches meditation in summer camps.\n\nIn September 2015 she took the vows as Nayaswami.",
      markdownContent: "## Premi\nPremi teaches meditation in summer camps.\n\nIn September 2015 she took the vows as Nayaswami.",
      status: "queued",
    });
    const service = new DocumentProcessingService(
      documentRepository,
      {
        async replaceForDocument(documentId, chunks): Promise<void> {
          await chunkRepository.replaceForDocument(documentId, chunks);
        },
        async publishForDocumentRevision(input): Promise<boolean> {
          return chunkRepository.publishForDocumentRevision(input);
        },
        async listSummariesForDocument(input) {
          return chunkRepository.listSummariesForDocument(input);
        },
        async findByIdForDocument(input) {
          return chunkRepository.findByIdForDocument(input);
        },
      },
      embeddingService,
      createAuditService(),
      {
        async getForWorkspace(workspaceId: string) {
          return {
            ...defaultIngestionSettings(workspaceId),
            chunkingStrategy: "structured_semantic",
          };
        },
      },
      new ChunkingStrategyRegistry([strategy]),
    );

    await service.process({
      id: "job-1",
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: document.revision,
      status: "processing",
      attemptCount: 1,
      lastError: null,
      availableAt: new Date(),
      claimedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(persistedSearchTexts[1]).toContain("Subject: Premi");
    expect(persistedSearchTexts[1]).toContain("In September 2015 she took the vows as Nayaswami.");
  });

  it("includes metadata-backed date and month summaries in search text", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const persistedSearchTexts: string[] = [];
    const embeddingService = new EmbeddingService({
      async embedTexts(texts: string[]): Promise<number[][]> {
        persistedSearchTexts.push(...texts);
        return texts.map(() => [1, 2, 3]);
      },
    });
    const strategy: ChunkingStrategy = {
      id: "structured_semantic",
      async chunk() {
        return [
          {
            chunkIndex: 0,
            content: "Corso residenziale.",
            startOffset: 0,
            endOffset: 19,
          },
        ];
      },
    };
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Corso Residenziale Benvenuto Ad Ananda",
      sourceContent: "Corso residenziale.",
      markdownContent: "Corso residenziale.",
      status: "queued",
      metadata: {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-03",
        sourceUrl: "https://corsi.ananda.it/edizione/example",
      },
    });
    const service = new DocumentProcessingService(
      documentRepository,
      {
        async replaceForDocument(documentId, chunks): Promise<void> {
          await chunkRepository.replaceForDocument(documentId, chunks);
        },
        async publishForDocumentRevision(input): Promise<boolean> {
          return chunkRepository.publishForDocumentRevision(input);
        },
        async listSummariesForDocument(input) {
          return chunkRepository.listSummariesForDocument(input);
        },
        async findByIdForDocument(input) {
          return chunkRepository.findByIdForDocument(input);
        },
      },
      embeddingService,
      createAuditService(),
      {
        async getForWorkspace(workspaceId: string) {
          return {
            ...defaultIngestionSettings(workspaceId),
            chunkingStrategy: "structured_semantic",
          };
        },
      },
      new ChunkingStrategyRegistry([strategy]),
    );

    await service.process({
      id: "job-2",
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: document.revision,
      status: "processing",
      attemptCount: 1,
      lastError: null,
      availableAt: new Date(),
      claimedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(persistedSearchTexts[0]).toContain("Date from: 2026-05-01");
    expect(persistedSearchTexts[0]).toContain("Date to: 2026-05-03");
    expect(persistedSearchTexts[0]).toContain("Month key: 2026-05");
    expect(persistedSearchTexts[0]).toContain("Month label: May 2026");
    expect(persistedSearchTexts[0]).toContain("Month label: maggio 2026");
    expect(persistedSearchTexts[0]).toContain("URL: https://corsi.ananda.it/edizione/example");
  });

  it("renders search text from final per-chunk enrichment metadata before embedding", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const persistedSearchTexts: string[] = [];
    const embeddingService = new EmbeddingService({
      async embedTexts(texts: string[]): Promise<number[][]> {
        persistedSearchTexts.push(...texts);
        return texts.map(() => [1, 2, 3]);
      },
    });
    const strategy: ChunkingStrategy = {
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
            content: "The date is written later in the page.",
            startOffset: 30,
            endOffset: 68,
          },
        ];
      },
    };
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Summer Workshop",
      sourceContent: "Summer workshop introduction.\n\nThe date is written later in the page.",
      markdownContent: "Summer workshop introduction.\n\nThe date is written later in the page.",
      status: "queued",
    });
    const enrichmentStage: DocumentEnrichmentStagePort = {
      async enrich({ chunks }) {
        return {
          status: "applied",
          documentMetadata: {
            enrichment: {
              status: "applied",
              shape: "event",
              model: "gpt-5.2",
              enrichedAt: "2026-07-02T12:00:00.000Z",
              anchorDate: "2026-07-02",
              anchorSource: "document_created_at",
              factCount: 1,
              appliedChunkCount: 1,
              failureReason: null,
            },
          },
          chunks: chunks.map((chunk) =>
            chunk.chunkIndex === 0
              ? { ...chunk, metadata: { ...(chunk.metadata ?? {}), dateFrom: "2026-07-17", dateTo: "2026-07-19" } }
              : chunk,
          ),
          factCount: 1,
          appliedChunkCount: 1,
        };
      },
    };
    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      embeddingService,
      createAuditService(),
      {
        async getForWorkspace(workspaceId: string) {
          return {
            ...defaultIngestionSettings(workspaceId),
            chunkingStrategy: "structured_semantic",
            documentEnrichmentEnabled: true,
          };
        },
      },
      new ChunkingStrategyRegistry([strategy]),
      undefined,
      undefined,
      enrichmentStage,
    );

    await service.process({
      id: "job-enrichment",
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: document.revision,
      status: "processing",
      attemptCount: 1,
      lastError: null,
      availableAt: new Date(),
      claimedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(persistedSearchTexts[0]).toContain("Date from: 2026-07-17");
    expect(persistedSearchTexts[0]).toContain("Date to: 2026-07-19");
    expect(persistedSearchTexts[1]).not.toContain("Date from: 2026-07-17");
    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toMatchObject({
      dateFrom: "2026-07-17",
      dateTo: "2026-07-19",
    });
  });
});
