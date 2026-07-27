import { describe, expect, it } from "vitest";

import {
  endpointScopeFingerprint,
  resolveEmbeddingProviderBinding,
} from "../../../src/shared/infra/llm/embeddingProviderResolver.js";
import type { LlmCapabilityConfig } from "../../../src/shared/infra/llm/providerTypes.js";

const openai: LlmCapabilityConfig = {
  capability: "embeddings",
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "openai-secret",
};
const compatible: LlmCapabilityConfig = {
  capability: "embeddings",
  provider: "openai-compatible",
  model: "text-embedding-3-small",
  apiKey: "compatible-secret",
  baseUrl: "https://embeddings.example/v1/",
};
const otherCompatible: LlmCapabilityConfig = {
  ...compatible,
  apiKey: "other-compatible-secret",
  baseUrl: "https://other-embeddings.example/v1",
};
const gemini: LlmCapabilityConfig = {
  capability: "embeddings",
  provider: "gemini",
  model: "gemini-embedding-001",
  apiKey: "gemini-secret",
};

describe("embedding provider binding resolution", () => {
  it("uses the catalog descriptor, not model-name prefixes", () => {
    expect(resolveEmbeddingProviderBinding("gemini-embedding-001", openai, [openai, gemini]).provider)
      .toBe("gemini");
    expect(() => resolveEmbeddingProviderBinding("gemini-lookalike", openai, [openai, gemini]))
      .toThrow("Unsupported embedding model");
  });

  it("honors an explicit configured provider binding", () => {
    expect(resolveEmbeddingProviderBinding(
      "text-embedding-3-small",
      openai,
      [openai, compatible],
      { provider: "openai-compatible" },
    )).toBe(compatible);
  });

  it("selects an exact endpoint scope and fails closed when it is unavailable", () => {
    const requestedFingerprint = endpointScopeFingerprint(compatible);

    expect(resolveEmbeddingProviderBinding(
      "text-embedding-3-small",
      otherCompatible,
      [otherCompatible, compatible],
      {
        provider: "openai-compatible",
        endpointScopeFingerprint: requestedFingerprint,
      },
    )).toBe(compatible);
    expect(() => resolveEmbeddingProviderBinding(
      "text-embedding-3-small",
      otherCompatible,
      [otherCompatible],
      {
        provider: "openai-compatible",
        endpointScopeFingerprint: requestedFingerprint,
      },
    )).toThrow("No configured embedding provider can serve model");
  });

  it("fingerprints endpoint scope without credentials or trailing-slash variance", () => {
    const first = endpointScopeFingerprint(compatible);
    const rotated = endpointScopeFingerprint({ ...compatible, apiKey: "rotated", baseUrl: "https://embeddings.example/v1" });
    const other = endpointScopeFingerprint({ ...compatible, baseUrl: "https://other.example/v1" });

    expect(first).toBe(rotated);
    expect(first).not.toBe(other);
    expect(first).not.toContain("embeddings.example");
    expect(first).not.toContain("secret");
  });
});
