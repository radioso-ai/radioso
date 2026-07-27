import { describe, expect, it } from "vitest";

import {
  validateEmbeddingBatch,
  splitEmbeddingInputs,
} from "../../../src/modules/embeddingProfiles/services/embeddingVectorValidator.js";
import {
  EmbeddingClientProviderAdapter,
} from "../../../src/shared/infra/llm/embeddingProviderAdapter.js";

describe("embedding vector validation", () => {
  it("accepts a finite, non-zero batch with the exact count and dimensions", () => {
    expect(validateEmbeddingBatch([[1, 0], [0, 1]], {
      expectedCount: 2,
      expectedDimensions: 2,
      normalization: "provider_unit",
    })).toEqual([[1, 0], [0, 1]]);
  });

  it.each([
    { vectors: [] as number[][], message: "vector count" },
    { vectors: [[1, 0], [1]], message: "dimensions" },
    { vectors: [[Number.NaN, 0], [0, 1]], message: "finite" },
    { vectors: [[0, 0], [0, 1]], message: "non-zero" },
    { vectors: [[2, 0], [0, 1]], message: "unit-normalized" },
  ])("rejects malformed output: $message", ({ vectors, message }) => {
    expect(() => validateEmbeddingBatch(vectors, {
      expectedCount: 2,
      expectedDimensions: 2,
      normalization: "provider_unit",
    })).toThrow(message);
  });

  it("normalizes application-owned vectors", () => {
    expect(validateEmbeddingBatch([[3, 4]], {
      expectedCount: 1,
      expectedDimensions: 2,
      normalization: "application_unit",
    })[0]).toEqual([0.6, 0.8]);
  });

  it("splits logical batches by count and UTF-8 byte limits", () => {
    expect(splitEmbeddingInputs(["aa", "bb", "cc"], { maxBatch: 2, maxInputBytes: 4 }))
      .toEqual([["aa", "bb"], ["cc"]]);
    expect(() => splitEmbeddingInputs(["hello"], { maxBatch: 2, maxInputBytes: 4 }))
      .toThrow("input exceeds");
  });

  it("splits provider calls and validates the combined response", async () => {
    const calls: string[][] = [];
    const adapter = new EmbeddingClientProviderAdapter({
      metadata: {
        capability: "embeddings",
        provider: "openai",
        model: "text-embedding-3-small",
      },
      async embedTexts(texts) {
        calls.push(texts);
        return { vectors: texts.map(() => [1, 0]) };
      },
    }, () => ({
      model: "text-embedding-3-small",
      providerFamily: "openai_like",
      dimensions: 2,
      normalization: "provider_unit",
      taskMapping: {
        retrieval_document: null,
        retrieval_query: null,
        clustering: null,
      },
      limits: { maxBatch: 2, maxInputBytes: 4, maxResponseBytes: 100 },
    }));

    const result = await adapter.generate({
      texts: ["a", "b", "c"],
      model: "text-embedding-3-small",
      dimensions: 2,
      purpose: "retrieval_document",
    });

    expect(calls).toEqual([["a", "b"], ["c"]]);
    expect(result.vectors).toEqual([[1, 0], [1, 0], [1, 0]]);
  });
});
