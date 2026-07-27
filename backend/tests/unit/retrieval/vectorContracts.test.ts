import { describe, expect, it } from "vitest";

import {
  compareVectorIndexVersions,
  cosineSimilarity,
  matchesVectorIndexFilter,
  supportsEmbeddingSpace,
  type VectorIndexCapabilities,
  type VectorIndexRecord,
} from "../../../src/modules/retrieval/domain/vectorAdapter.js";

const capabilities: VectorIndexCapabilities = {
  backend: "test",
  dimensionRanges: [{ min: 2, max: 4 }],
  distanceMetrics: ["cosine"],
  filterOperations: [
    "source",
    "metadata_containment",
    "retrieval_eligibility",
    "expiry",
  ],
  maxBatchSize: 100,
  searchModes: ["exact"],
  consistency: "eventual",
};

const record = (overrides: Partial<VectorIndexRecord> = {}): VectorIndexRecord => ({
  chunkId: "chunk-1",
  documentId: "document-1",
  vector: [1, 0],
  version: "1",
  payload: {
    sourceId: null,
    metadata: {
      customer: {
        id: "acme",
        tags: ["support", "priority"],
      },
    },
    retrievalEnabled: true,
    retrievalExpiresAt: null,
  },
  ...overrides,
});

describe("backend-neutral vector contracts", () => {
  it("compares arbitrarily large decimal-string versions without number coercion", () => {
    expect(compareVectorIndexVersions("9", "10")).toBeLessThan(0);
    expect(compareVectorIndexVersions("900719925474099312345", "900719925474099312346")).toBeLessThan(0);
    expect(compareVectorIndexVersions("42", "42")).toBe(0);
    expect(compareVectorIndexVersions("100", "99")).toBeGreaterThan(0);

    expect(() => compareVectorIndexVersions("-1", "2")).toThrow("invalid_vector_index_version");
    expect(() => compareVectorIndexVersions("01", "2")).toThrow("invalid_vector_index_version");
    expect(() => compareVectorIndexVersions("1.5", "2")).toThrow("invalid_vector_index_version");
  });

  it("uses finite non-zero cosine vectors and returns normalized scores", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);

    expect(() => cosineSimilarity([1], [1, 0])).toThrow("vector_dimension_mismatch");
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow("zero_cosine_vector");
    expect(() => cosineSimilarity([Number.NaN, 0], [1, 0])).toThrow("non_finite_vector");
  });

  it("checks an embedding space against declared adapter capabilities", () => {
    expect(supportsEmbeddingSpace(capabilities, {
      id: "space-2d",
      dimensions: 2,
      distanceMetric: "cosine",
    })).toBe(true);
    expect(supportsEmbeddingSpace(capabilities, {
      id: "space-5d",
      dimensions: 5,
      distanceMetric: "cosine",
    })).toBe(false);
  });

  it("applies portable source, unassigned, nested metadata, eligibility, and expiry filters", () => {
    const now = "2026-07-26T12:00:00.000Z";
    const baseRecord = record();

    expect(matchesVectorIndexFilter(baseRecord, {
      source: {
        constrained: true,
        sourceIds: [],
        includeUnassignedDocuments: true,
      },
      metadataContains: {
        customer: {
          id: "acme",
          tags: ["priority"],
        },
      },
      retrievalEnabled: true,
      notExpiredAt: now,
    })).toBe(true);

    expect(matchesVectorIndexFilter(record({
      payload: {
        ...baseRecord.payload,
        sourceId: "source-1",
      },
    }), {
      source: {
        constrained: true,
        sourceIds: [],
        includeUnassignedDocuments: true,
      },
    })).toBe(false);

    expect(matchesVectorIndexFilter(record({
      payload: {
        ...baseRecord.payload,
        retrievalEnabled: false,
      },
    }), {
      retrievalEnabled: true,
    })).toBe(false);

    expect(matchesVectorIndexFilter(record({
      payload: {
        ...baseRecord.payload,
        retrievalExpiresAt: now,
      },
    }), {
      notExpiredAt: now,
    })).toBe(false);

    expect(matchesVectorIndexFilter(record({
      payload: {
        ...baseRecord.payload,
        retrievalExpiresAt: "2026-07-26T12:00:00.001Z",
      },
    }), {
      notExpiredAt: now,
    })).toBe(true);
  });
});
