import { describe, expect, it, vi } from "vitest";

import {
  EmbeddingGenerationService,
  ModelEmbeddingGenerationGateway,
  type EmbeddingGenerationGateway,
  type EmbeddingInferencePort,
} from "../../../src/modules/embeddingProfiles/public.js";

describe("embedding generation service", () => {
  it("forwards the general binding, shape, purpose, attribution and item metadata", async () => {
    const embedTexts = vi.fn(async () => ({
      vectors: [[1, 0]],
      usage: { inputTokens: 3, totalTokens: 3, quality: "actual" as const },
    }));
    const inference: EmbeddingInferencePort = { embedTexts };
    const gateway = new ModelEmbeddingGenerationGateway(inference);

    await expect(gateway.embedTextsWithUsage(["query"], {
      model: "text-embedding-3-small",
      dimensions: 1536,
      purpose: "retrieval_query",
      provider: "openai",
      endpointScopeFingerprint: "endpoint-a",
      usageContext: {
        workspaceId: "workspace-1",
        surface: "retrieval",
        operation: "query_embedding",
        attemptKey: "query-1",
      },
      sourceId: "source-1",
      documentId: "document-1",
      documentRevision: 3,
      jobId: "job-1",
      usageItems: [{
        chunkIndex: 0,
        chunkId: "chunk-1",
        contentBytes: 5,
      }],
    })).resolves.toEqual({
      vectors: [[1, 0]],
      usage: { inputTokens: 3, totalTokens: 3, quality: "actual" },
    });
    expect(embedTexts).toHaveBeenCalledWith({
      texts: ["query"],
      model: "text-embedding-3-small",
      dimensions: 1536,
      purpose: "retrieval_query",
      provider: "openai",
      endpointScopeFingerprint: "endpoint-a",
      operation: {
        workspaceId: "workspace-1",
        surface: "retrieval",
        operation: "query_embedding",
        attemptKey: "query-1",
      },
      sourceId: "source-1",
      documentId: "document-1",
      documentRevision: 3,
      jobId: "job-1",
      items: [{
        chunkIndex: 0,
        chunkId: "chunk-1",
        contentBytes: 5,
      }],
    });
  });

  it("creates unattributed operation context without changing gateway behavior", async () => {
    const embedTexts = vi.fn(async (request) => ({
      vectors: request.texts.map(() => [1]),
    }));
    const gateway = new ModelEmbeddingGenerationGateway({ embedTexts });

    await expect(gateway.embedTexts(["one", "two"])).resolves.toEqual([
      [1],
      [1],
    ]);
    expect(embedTexts).toHaveBeenCalledWith(expect.objectContaining({
      texts: ["one", "two"],
      operation: expect.objectContaining({
        workspaceId: "unknown",
        surface: "embedding",
        operation: "embedding",
        attemptKey: "unattributed",
        requestId: expect.any(String),
      }),
    }));
  });

  it("preserves the service usage fallback for gateways without usage support", async () => {
    const gateway: EmbeddingGenerationGateway = {
      embedTexts: vi.fn(async (texts) => texts.map(() => [1, 0])),
    };
    const service = new EmbeddingGenerationService(gateway);

    await expect(service.embedChunksWithUsage(["a", "b"])).resolves.toEqual({
      vectors: [[1, 0], [1, 0]],
    });
    await expect(service.embedChunks(["a"])).resolves.toEqual([[1, 0]]);
    await expect(service.embedTexts(["a"])).resolves.toEqual([[1, 0]]);
  });
});
