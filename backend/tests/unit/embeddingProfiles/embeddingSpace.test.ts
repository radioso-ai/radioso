import { describe, expect, it } from "vitest";

import {
  createEmbeddingSpaceIdentity,
  isEmbeddingSpaceCompatible,
} from "../../../src/modules/embeddingProfiles/domain/embeddingSpace.js";

const baseInput = {
  providerImplementation: "openai" as const,
  endpointScopeFingerprint: "scope_8fa3",
  model: "text-embedding-3-small",
  dimensions: 1536,
  distance: "cosine" as const,
  normalization: "provider_unit" as const,
  documentTask: "retrieval_document",
  queryTask: "retrieval_query",
  vectorOptions: { dimensions: 1536 },
  providerModelVersion: null,
};

describe("embedding space identity", () => {
  it("is stable across vector-option key order and excludes credentials", () => {
    const first = createEmbeddingSpaceIdentity({
      ...baseInput,
      vectorOptions: { dimensions: 1536, nested: { beta: true, alpha: 1 } },
    });
    const second = createEmbeddingSpaceIdentity({
      ...baseInput,
      vectorOptions: { nested: { alpha: 1, beta: true }, dimensions: 1536 },
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(JSON.stringify(first)).not.toContain("api-key");
  });

  it("changes for every vector-affecting compatibility field", () => {
    const original = createEmbeddingSpaceIdentity(baseInput);
    const changed = [
      createEmbeddingSpaceIdentity({ ...baseInput, endpointScopeFingerprint: "scope_other" }),
      createEmbeddingSpaceIdentity({ ...baseInput, model: "text-embedding-3-large" }),
      createEmbeddingSpaceIdentity({ ...baseInput, dimensions: 3072 }),
      createEmbeddingSpaceIdentity({ ...baseInput, normalization: "application_unit" }),
      createEmbeddingSpaceIdentity({ ...baseInput, queryTask: "semantic_similarity" }),
      createEmbeddingSpaceIdentity({ ...baseInput, providerModelVersion: "2026-07" }),
    ];

    expect(changed.every((candidate) => !isEmbeddingSpaceCompatible(original, candidate))).toBe(true);
  });

  it.each([0, -1, 1.5, 16_001])("rejects invalid dimension %s", (dimensions) => {
    expect(() => createEmbeddingSpaceIdentity({ ...baseInput, dimensions })).toThrow(
      "dimensions must be an integer between 1 and 16000",
    );
  });

  it("rejects missing endpoint scope and overlong model identifiers", () => {
    expect(() => createEmbeddingSpaceIdentity({ ...baseInput, endpointScopeFingerprint: "" })).toThrow();
    expect(() => createEmbeddingSpaceIdentity({ ...baseInput, model: "m".repeat(201) })).toThrow();
  });
});

