import { describe, expect, it } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import { createAuditService, InMemoryDocumentRepository } from "../support/fakes.js";

describe("document subject search text", () => {
  it("anchors later chunks to the document subject even when the chunk text omits the subject name", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const persistedSearchTexts: string[] = [];
    const embeddingService = new EmbeddingService({
      async embedTexts(texts: string[]): Promise<number[][]> {
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
    const service = new DocumentIngestionService(
      documentRepository,
      {
        async replaceForDocument(_documentId, chunks): Promise<void> {
          persistedSearchTexts.push(...chunks.map((chunk) => chunk.searchText ?? ""));
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
        get() {
          return strategy;
        },
      },
    );

    await service.ingest({
      accountId: "account-1",
      title: "| Generic Catalog |",
      content: "## Premi\nPremi teaches meditation in summer camps.\n\nIn September 2015 she took the vows as Nayaswami.",
    });

    expect(persistedSearchTexts[1]).toContain("Subject: Premi");
    expect(persistedSearchTexts[1]).toContain("In September 2015 she took the vows as Nayaswami.");
  });
});
