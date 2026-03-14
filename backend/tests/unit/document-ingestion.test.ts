import { describe, expect, it } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import { createAuditService, InMemoryDocumentRepository } from "../support/fakes.js";

describe("document ingestion", () => {
  it("does not leave a document marked ready when chunk persistence fails", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const embeddingService = new EmbeddingService({
      async embedTexts(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 2, 3]);
      },
    });
    const service = new DocumentIngestionService(
      documentRepository,
      {
        async replaceForDocument(): Promise<void> {
          throw new Error("chunk write failed");
        },
      },
      embeddingService,
      createAuditService(),
      {
        async getForAccount(accountId: string) {
          return defaultRetrievalSettings(accountId);
        },
      },
      {
        get() {
          return fixedWindowStrategy;
        },
      },
    );

    await expect(
      service.ingest({
        accountId: "account-1",
        title: "Broken",
        content: "Broken content",
      }),
    ).rejects.toThrow("chunk write failed");

    const [document] = await documentRepository.listByAccountId("account-1");
    expect(document.status).toBe("failed");
  });

  it("uses the selected chunking strategy during ingest", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const persistedChunks: { content: string; chunkIndex: number }[] = [];
    const embeddingService = new EmbeddingService({
      async embedTexts(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 2, 3]);
      },
    });
    const structuredStrategy: ChunkingStrategy = {
      id: "structured_semantic",
      async chunk() {
        return [{ chunkIndex: 0, content: "Structured chunk", startOffset: 0, endOffset: 16 }];
      },
    };
    const service = new DocumentIngestionService(
      documentRepository,
      {
        async replaceForDocument(_documentId, chunks): Promise<void> {
          persistedChunks.push(...chunks.map((chunk) => ({ content: chunk.content, chunkIndex: chunk.chunkIndex })));
        },
      },
      embeddingService,
      createAuditService(),
      {
        async getForAccount(accountId: string) {
          return {
            ...defaultRetrievalSettings(accountId),
            chunkingStrategy: "structured_semantic",
          };
        },
      },
      {
        get(strategyId) {
          expect(strategyId).toBe("structured_semantic");
          return structuredStrategy;
        },
      },
    );

    await service.ingest({
      accountId: "account-1",
      title: "Structured",
      content: "# Intro\n\nParagraph",
    });

    expect(persistedChunks).toEqual([{ content: "Structured chunk", chunkIndex: 0 }]);
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
