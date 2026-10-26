import { describe, expect, it } from "vitest";

import type { DocumentEnrichmentGateway } from "../../src/modules/documents/domain/enrichment/enrichmentGateway.js";
import type {
  EnrichmentReplyStore,
  StoredEnrichmentReply,
} from "../../src/modules/documents/domain/enrichment/enrichmentReplyStore.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import { DocumentEnrichmentService } from "../../src/modules/documents/services/documentEnrichmentService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentSourceRepository,
} from "../support/fakes.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";

// Re-indexing is where enrichment cost multiplies: a re-crawl, a re-sent API document, a
// reprocess after a settings change, or a metadata edit each used to buy another model call for
// content the model had already read. These run the real ingestion, processing and enrichment
// services end to end and count the calls the model receives.

const WORKSPACE_ID = "workspace-reuse";
const PAGE_URL = "https://retreats.example.com/summer";
const WORKSHOP = "Summer workshop for returning students.\n\nDates: July 17-19, 2026.";

const paragraphChunking: ChunkingStrategy = {
  id: "structured_semantic",
  async chunk({ content }) {
    const chunks: Array<{ chunkIndex: number; content: string; startOffset: number; endOffset: number }> = [];
    let offset = 0;
    for (const paragraph of content.split("\n\n")) {
      chunks.push({ chunkIndex: chunks.length, content: paragraph, startOffset: offset, endOffset: offset + paragraph.length });
      offset += paragraph.length + 2;
    }
    return chunks;
  },
};

class InMemoryReplyStore implements EnrichmentReplyStore {
  private readonly replies = new Map<string, StoredEnrichmentReply>();

  async find(document: { workspaceId: string; documentId: string }) {
    return this.replies.get(`${document.workspaceId}:${document.documentId}`) ?? null;
  }

  async save(document: { workspaceId: string; documentId: string }, reply: StoredEnrichmentReply) {
    this.replies.set(`${document.workspaceId}:${document.documentId}`, reply);
  }

  async clear(document: { workspaceId: string; documentId: string }) {
    this.replies.delete(`${document.workspaceId}:${document.documentId}`);
  }
}

const buildWorkspace = () => {
  const documentRepository = new InMemoryDocumentRepository();
  const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(jobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const sourceRepository = new InMemoryDocumentSourceRepository();
  sourceRepository.setDocumentRepository(documentRepository);
  const auditService = createAuditService();

  let modelCalls = 0;
  const gateway: DocumentEnrichmentGateway = {
    requestProfile: "test",
    async generate() {
      modelCalls += 1;
      return {
        model: "gpt-5.4-mini",
        output: {
          type: "event",
          confidence: 0.92,
          facts: [{ kind: "event_date", quote: "July 17-19, 2026", dateFrom: "2026-07-17", dateTo: "2026-07-19", unresolvedText: null }],
        },
      };
    },
  };

  const ingestion = new DocumentIngestionService(
    documentRepository,
    auditService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sourceRepository,
  );
  const processing = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    createDocumentEmbeddingPort({
      async embedTexts(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 2, 3]);
      },
    }),
    auditService,
    {
      async getForWorkspace(workspaceId: string) {
        return { ...defaultIngestionSettings(workspaceId), chunkingStrategy: "structured_semantic" as const, documentEnrichmentEnabled: true };
      },
    },
    new ChunkingStrategyRegistry([paragraphChunking]),
    undefined,
    undefined,
    new DocumentEnrichmentService({
      gateway,
      replyStore: new InMemoryReplyStore(),
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-06-01T09:00:00.000Z"),
    }),
    sourceRepository,
    jobRepository,
  );

  const finished = new Set<string>();
  // Runs every queued job the way the worker does: indexing first, extraction behind it.
  const drain = async (): Promise<void> => {
    for (const kind of ["vectorize", "enrich"] as const) {
      for (const job of [...jobRepository.items.values()]) {
        if (job.kind !== kind || finished.has(job.id)) {
          continue;
        }
        finished.add(job.id);
        await (kind === "vectorize" ? processing.process(job) : processing.processEnrichment(job));
      }
    }
  };

  const crawlPage = async (content = WORKSHOP) => {
    const result = await ingestion.ingest({
      workspaceId: WORKSPACE_ID,
      title: "Summer workshop",
      content,
      externalDocumentId: PAGE_URL,
      source: { kind: "website", url: "https://retreats.example.com" },
    });
    await drain();
    return result.documentId;
  };

  const sendApiDocument = async (content = WORKSHOP) => {
    const result = await ingestion.ingest({
      workspaceId: WORKSPACE_ID,
      title: "Summer workshop",
      content,
      externalDocumentId: "crm-workshop-42",
    });
    await drain();
    return result.documentId;
  };

  return {
    crawlPage,
    sendApiDocument,
    reprocess: async (documentId: string) => {
      await ingestion.reprocess({ workspaceId: WORKSPACE_ID, documentId });
      await drain();
    },
    // What a document's "Run metadata extraction" action sends.
    runMetadataExtraction: async (documentId: string) => {
      await ingestion.reprocess({
        workspaceId: WORKSPACE_ID,
        documentId,
        documentEnrichmentOverride: "on",
        refreshDocumentEnrichment: true,
      });
      await drain();
    },
    put: async (documentId: string, content: string) => {
      await ingestion.update({ workspaceId: WORKSPACE_ID, documentId, title: "Summer workshop", content });
      await drain();
    },
    editMetadata: async (documentId: string, metadata: Record<string, unknown>) => {
      await ingestion.updateRetrievalSettings({ workspaceId: WORKSPACE_ID, documentId, metadata });
      await drain();
    },
    modelCalls: () => modelCalls,
    enrichJobCount: () => [...jobRepository.items.values()].filter((job) => job.kind === "enrich").length,
    documentOf: (documentId: string) => documentRepository.items.get(documentId)!,
    chunkDates: (documentId: string) =>
      [...(chunkRepository.items.get(documentId) ?? [])]
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .map((chunk) => [chunk.metadata?.dateFrom ?? null, chunk.metadata?.dateTo ?? null]),
    lastEnrichmentOutcome: () =>
      auditService.events.filter((event) => event.eventType === "document.enrichment").at(-1)?.metadata?.outcome,
  };
};

describe("enrichment of unchanged content", () => {
  it("makes no model call when an unchanged page is crawled again", async () => {
    const workspace = buildWorkspace();
    const documentId = await workspace.crawlPage();
    expect(workspace.modelCalls()).toBe(1);

    await workspace.crawlPage();

    expect(workspace.modelCalls()).toBe(1);
    expect(workspace.enrichJobCount()).toBe(1);
    expect(workspace.documentOf(documentId).metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
  });

  it("makes no model call when the same API document is sent again", async () => {
    const workspace = buildWorkspace();
    await workspace.sendApiDocument();

    await workspace.sendApiDocument();

    expect(workspace.modelCalls()).toBe(1);
    expect(workspace.enrichJobCount()).toBe(1);
  });

  it("re-applies the stored reply when unchanged content is re-indexed", async () => {
    const workspace = buildWorkspace();
    const documentId = await workspace.crawlPage();

    await workspace.reprocess(documentId);
    await workspace.put(documentId, WORKSHOP);

    expect(workspace.modelCalls()).toBe(1);
    expect(workspace.enrichJobCount()).toBe(3);
    expect(workspace.lastEnrichmentOutcome()).toBe("reused");
    expect(workspace.documentOf(documentId).metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    expect(workspace.chunkDates(documentId)).toEqual([
      ["2026-07-17", "2026-07-19"],
      ["2026-07-17", "2026-07-19"],
    ]);
  });

  it("re-indexes an operator's metadata edit without a model call, and the operator's dates win", async () => {
    const workspace = buildWorkspace();
    const documentId = await workspace.sendApiDocument();

    await workspace.editMetadata(documentId, { dateFrom: "2026-07-24", dateTo: "2026-07-26" });

    expect(workspace.modelCalls()).toBe(1);
    expect(workspace.lastEnrichmentOutcome()).toBe("reused");
    expect(workspace.documentOf(documentId).metadata).toMatchObject({ dateFrom: "2026-07-24", dateTo: "2026-07-26" });
    expect(workspace.chunkDates(documentId)).toEqual([
      ["2026-07-24", "2026-07-26"],
      ["2026-07-24", "2026-07-26"],
    ]);
  });

  it("asks the model afresh when an operator runs metadata extraction on one document", async () => {
    const workspace = buildWorkspace();
    const documentId = await workspace.crawlPage();

    await workspace.runMetadataExtraction(documentId);
    await workspace.reprocess(documentId);

    expect(workspace.modelCalls()).toBe(2);
    expect(workspace.lastEnrichmentOutcome()).toBe("reused");
    expect(workspace.documentOf(documentId).enrichment).toMatchObject({ status: "applied", reusedReply: true });
  });

  it("asks the model again when the content changes", async () => {
    const workspace = buildWorkspace();
    const documentId = await workspace.crawlPage();

    await workspace.crawlPage(`${WORKSHOP} Bring water.`);
    await workspace.put(documentId, `${WORKSHOP} Bring a hat.`);

    expect(workspace.modelCalls()).toBe(3);
    expect(workspace.lastEnrichmentOutcome()).toBe("applied");
  });
});
