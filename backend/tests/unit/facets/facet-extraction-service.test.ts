import { describe, expect, it, vi } from "vitest";

import type {
  FacetExtractionJob,
  FacetSourceMessagePort,
  FacetExtractionInferenceFactory,
  MessageFacetRecord,
  MessageFacetRepositoryPort,
} from "../../../src/modules/facets/contracts.js";
import { FACET_EXTRACTION_PROMPT_VERSION } from "../../../src/modules/facets/services/prompt.js";
import { FacetExtractionService } from "../../../src/modules/facets/services/facetExtractionService.js";
import type { ClusteringEmbeddingPort } from "../../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");

const buildJob = (overrides: Partial<FacetExtractionJob> = {}): FacetExtractionJob => ({
  id: "job-1",
  messageId: "message-1",
  workspaceId: "workspace-1",
  status: "processing",
  attemptCount: 1,
  claimedAt: NOW,
  scheduledAt: NOW,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const buildInferenceFactory = (facet: string): FacetExtractionInferenceFactory => ({
  create: vi.fn(async () => ({
    metadata: { capability: "rewrite" as const, provider: "openai" as const, model: "test-model" },
    complete: vi.fn(async () => ({ text: JSON.stringify({ facet }) })),
    stream: vi.fn(),
  })),
});

const buildFacets = (overrides: Partial<MessageFacetRepositoryPort> = {}): MessageFacetRepositoryPort => ({
  upsertFacet: vi.fn(async () => undefined),
  attachEmbedding: vi.fn(async () => undefined),
  listForWindow: vi.fn(async () => []),
  listMessageIdsMissingCurrentFacet: vi.fn(async () => []),
  ...overrides,
});

const buildMessages = (content: string | null): FacetSourceMessagePort => ({
  getContentById: vi.fn(async () => content),
});

describe("FacetExtractionService", () => {
  it("persists the facet before attempting to embed it", async () => {
    const callOrder: string[] = [];
    const facets = buildFacets({
      upsertFacet: vi.fn(async () => {
        callOrder.push("upsertFacet");
      }),
      attachEmbedding: vi.fn(async () => {
        callOrder.push("attachEmbedding");
      }),
    });
    const embeddings: ClusteringEmbeddingPort = {
      embedForClustering: vi.fn(async () => {
        callOrder.push("embedForClustering");
        return {
          vectors: [[0.1, 0.2]],
          space: { id: "space-1", dimensions: 2, distanceMetric: "cosine" as const },
        };
      }),
    };
    const inferenceFactory = buildInferenceFactory("asking about the retreat price");
    const service = new FacetExtractionService({
      messages: buildMessages("How much does the retreat cost?"),
      facets,
      embeddings,
      inferenceFactory,
    });

    const outcome = await service.extract(buildJob());

    expect(outcome).toEqual({ status: "extracted" });
    expect(callOrder).toEqual(["upsertFacet", "embedForClustering", "attachEmbedding"]);
    expect(facets.upsertFacet).toHaveBeenCalledWith({
      messageId: "message-1",
      workspaceId: "workspace-1",
      facetText: "asking about the retreat price",
      promptVersion: FACET_EXTRACTION_PROMPT_VERSION,
    });
    expect(facets.attachEmbedding).toHaveBeenCalledWith({
      messageId: "message-1",
      embedding: [0.1, 0.2],
      embeddingProfileId: "space-1",
    });
    expect(embeddings.embedForClustering).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      texts: ["asking about the retreat price"],
      usageContext: {
        workspaceId: "workspace-1",
        messageId: "message-1",
        surface: "facet_extraction",
        operation: "embedding",
        attemptKey: "facet-embedding:job-1:1",
      },
    });
  });

  it("leaves the facet stored and retryable when the embedding step fails", async () => {
    const facets = buildFacets();
    const embeddings: ClusteringEmbeddingPort = {
      embedForClustering: vi.fn(async () => {
        throw new Error("embedding provider unavailable");
      }),
    };
    const service = new FacetExtractionService({
      messages: buildMessages("How much does the retreat cost?"),
      facets,
      embeddings,
      inferenceFactory: buildInferenceFactory("asking about the retreat price"),
    });

    await expect(service.extract(buildJob())).rejects.toThrow("embedding provider unavailable");

    expect(facets.upsertFacet).toHaveBeenCalledTimes(1);
    expect(facets.attachEmbedding).not.toHaveBeenCalled();
  });

  it("retries only the embedding step, without re-extracting, when a facet already exists at the current prompt version", async () => {
    const existing: MessageFacetRecord = {
      messageId: "message-1",
      facetText: "asking about the retreat price",
      embedding: null,
      promptVersion: FACET_EXTRACTION_PROMPT_VERSION,
      embeddingProfileId: null,
    };
    const facets = buildFacets({
      listForWindow: vi.fn(async () => [existing]),
    });
    const embeddings: ClusteringEmbeddingPort = {
      embedForClustering: vi.fn(async () => ({
        vectors: [[0.4, 0.5]],
        space: { id: "space-1", dimensions: 2, distanceMetric: "cosine" as const },
      })),
    };
    const messages = buildMessages("should never be read on a retry");
    const inferenceFactory = buildInferenceFactory("should never be called on a retry");
    const service = new FacetExtractionService({ messages, facets, embeddings, inferenceFactory });

    const outcome = await service.extract(buildJob({ attemptCount: 2 }));

    expect(outcome).toEqual({ status: "extracted" });
    expect(messages.getContentById).not.toHaveBeenCalled();
    expect(inferenceFactory.create).not.toHaveBeenCalled();
    expect(facets.upsertFacet).not.toHaveBeenCalled();
    expect(facets.attachEmbedding).toHaveBeenCalledWith({
      messageId: "message-1",
      embedding: [0.4, 0.5],
      embeddingProfileId: "space-1",
    });
  });

  it("refreshes the embedding without re-extracting when a facet is already stored", async () => {
    const existing: MessageFacetRecord = {
      messageId: "message-1",
      facetText: "asking about the retreat price",
      embedding: [0.4, 0.5],
      promptVersion: FACET_EXTRACTION_PROMPT_VERSION,
      embeddingProfileId: "space-1",
    };
    const facets = buildFacets({ listForWindow: vi.fn(async () => [existing]) });
    const embeddings: ClusteringEmbeddingPort = {
      embedForClustering: vi.fn(async () => ({
        vectors: [[0.7, 0.8]],
        space: { id: "space-2", dimensions: 2, distanceMetric: "cosine" as const },
      })),
    };
    const messages = buildMessages("should never be read");
    const inferenceFactory = buildInferenceFactory("should never be called");
    const service = new FacetExtractionService({ messages, facets, embeddings, inferenceFactory });

    const outcome = await service.extract(buildJob());

    expect(outcome).toEqual({ status: "extracted" });
    expect(embeddings.embedForClustering).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      texts: ["asking about the retreat price"],
      usageContext: {
        workspaceId: "workspace-1",
        messageId: "message-1",
        surface: "facet_extraction",
        operation: "embedding",
        attemptKey: "facet-embedding:job-1:1",
      },
    });
    expect(facets.upsertFacet).not.toHaveBeenCalled();
    expect(facets.attachEmbedding).toHaveBeenCalledWith({
      messageId: "message-1",
      embedding: [0.7, 0.8],
      embeddingProfileId: "space-2",
    });
  });

  it("skips without calling the model when the source message no longer exists", async () => {
    const facets = buildFacets();
    const embeddings: ClusteringEmbeddingPort = { embedForClustering: vi.fn() };
    const inferenceFactory = buildInferenceFactory("unused");
    const service = new FacetExtractionService({
      messages: buildMessages(null),
      facets,
      embeddings,
      inferenceFactory,
    });

    const outcome = await service.extract(buildJob());

    expect(outcome).toEqual({ status: "skipped", reason: "message_not_found" });
    expect(inferenceFactory.create).not.toHaveBeenCalled();
    expect(facets.upsertFacet).not.toHaveBeenCalled();
    expect(embeddings.embedForClustering).not.toHaveBeenCalled();
  });

  it("skips without persisting when the message content is empty", async () => {
    const facets = buildFacets();
    const embeddings: ClusteringEmbeddingPort = { embedForClustering: vi.fn() };
    const inferenceFactory = buildInferenceFactory("unused");
    const service = new FacetExtractionService({
      messages: buildMessages("   "),
      facets,
      embeddings,
      inferenceFactory,
    });

    const outcome = await service.extract(buildJob());

    expect(outcome).toEqual({ status: "skipped", reason: "empty_message" });
    expect(inferenceFactory.create).not.toHaveBeenCalled();
    expect(facets.upsertFacet).not.toHaveBeenCalled();
  });
});
