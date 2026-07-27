import { describe, expect, it } from "vitest";

import {
  LegacyVectorCandidateSearchAdapter,
  VectorCandidateSearchRolloutAdapter,
} from "../../../src/app/composition/legacyVectorCandidateSearchAdapter.js";
import type { VectorIndexPort } from "../../../src/modules/retrieval/domain/vectorIndex.js";
import type { VectorCandidateSearchPort } from "../../../src/modules/retrieval/domain/vectorAdapter.js";

describe("LegacyVectorCandidateSearchAdapter", () => {
  it("contains model-keyed pgvector compatibility behind the neutral search port", async () => {
    const searches: Array<Parameters<VectorIndexPort["search"]>[0]> = [];
    const adapter = new LegacyVectorCandidateSearchAdapter({
      legacy: {
        async search(input) {
          searches.push(input);
          return [{ chunkId: "chunk-1", documentId: "document-1", score: 0.8 }];
        },
      },
      profiles: {
        async findEmbeddingSpaceById(id) {
          expect(id).toBe("space-1");
          return {
            id,
            identityFingerprint: "fingerprint",
            endpointScopeFingerprint: "endpoint",
            provider: "openai",
            model: "text-embedding-3-large",
            dimensions: 3072,
            distanceMetric: "cosine",
            normalization: "provider_unit",
            documentTask: null,
            queryTask: null,
            vectorOptions: {},
            modelVersion: null,
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
      },
    });

    await expect(adapter.search({
      workspaceId: "workspace-1",
      space: {
        id: "space-1",
        dimensions: 3072,
        distanceMetric: "cosine",
      },
      queryVector: [0.1, 0.2],
      topK: 3,
      minimumScore: 0.4,
      filter: {
        metadataContains: { locale: "en" },
      },
    })).resolves.toEqual([{
      chunkId: "chunk-1",
      documentId: "document-1",
      embeddingSpaceId: "space-1",
      version: "0",
      score: 0.8,
    }]);
    expect(searches).toEqual([{
      workspaceId: "workspace-1",
      queryEmbedding: [0.1, 0.2],
      queryEmbeddingDimensions: 3072,
      topK: 3,
      similarityThreshold: 0.4,
      embeddingModel: "text-embedding-3-large",
      filter: {
        metadataContains: { locale: "en" },
      },
    }]);
  });

  it("searches existing Gemini vectors with their persisted 1536-dimensional contract", async () => {
    const searches: Array<Parameters<VectorIndexPort["search"]>[0]> = [];
    const adapter = new LegacyVectorCandidateSearchAdapter({
      legacy: {
        async search(input) {
          searches.push(input);
          return [];
        },
      },
      profiles: {
        async findEmbeddingSpaceById() {
          return {
            id: "gemini-existing-space",
            identityFingerprint: "fingerprint",
            endpointScopeFingerprint: "gemini-endpoint",
            provider: "gemini",
            model: "gemini-embedding-001",
            dimensions: 1536,
            distanceMetric: "cosine",
            normalization: "application_unit",
            documentTask: null,
            queryTask: null,
            vectorOptions: {},
            modelVersion: null,
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
      },
    });

    await adapter.search({
      workspaceId: "gemini-workspace",
      space: {
        id: "gemini-existing-space",
        dimensions: 1536,
        distanceMetric: "cosine",
      },
      queryVector: [1, 0],
      topK: 5,
      minimumScore: 0,
      filter: {},
    });

    expect(searches).toEqual([{
      workspaceId: "gemini-workspace",
      queryEmbedding: [1, 0],
      queryEmbeddingDimensions: 1536,
      topK: 5,
      similarityThreshold: 0,
      embeddingModel: "gemini-embedding-001",
      filter: {},
    }]);
  });

  it("merges the canonical index with only explicitly compatible legacy dimensions", async () => {
    const canonical: VectorCandidateSearchPort = {
      async search(input) {
        return [{
          chunkId: "canonical",
          documentId: "document-canonical",
          embeddingSpaceId: input.space.id,
          version: "2",
          score: 0.7,
        }];
      },
    };
    const legacyCalls: number[] = [];
    const legacy: VectorCandidateSearchPort = {
      async search(input) {
        legacyCalls.push(input.space.dimensions);
        return [{
          chunkId: "legacy",
          documentId: "document-legacy",
          embeddingSpaceId: input.space.id,
          version: "0",
          score: 0.8,
        }];
      },
    };
    const adapter = new VectorCandidateSearchRolloutAdapter({
      canonical,
      legacy,
      legacyDimensions: [1536],
    });
    const baseInput = {
      workspaceId: "workspace-1",
      queryVector: [1],
      topK: 5,
      minimumScore: 0,
      filter: {},
    };

    await expect(adapter.search({
      ...baseInput,
      space: { id: "space-1536", dimensions: 1536, distanceMetric: "cosine" },
    })).resolves.toEqual([
      expect.objectContaining({ chunkId: "legacy" }),
      expect.objectContaining({ chunkId: "canonical" }),
    ]);
    await expect(adapter.search({
      ...baseInput,
      space: { id: "space-3072", dimensions: 3072, distanceMetric: "cosine" },
    })).resolves.toEqual([
      expect.objectContaining({ chunkId: "canonical" }),
    ]);
    expect(legacyCalls).toEqual([1536]);
  });
});
