import { describe, expect, it } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
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
});
