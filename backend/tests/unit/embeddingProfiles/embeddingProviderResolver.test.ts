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
    const rotatedConfig = { ...compatible, apiKey: "rotated", baseUrl: "https://embeddings.example/v1" };
    const rotated = endpointScopeFingerprint(rotatedConfig);
    const other = endpointScopeFingerprint({ ...compatible, baseUrl: "https://other.example/v1" });

    expect(first).toBe(rotated);
    expect(first).not.toBe(other);
    expect(first).not.toContain("embeddings.example");
    expect(first).not.toContain("secret");
  });

  it("keeps one persisted scope across every native openai endpoint — global, regional residency, and Azure", () => {
    // CRITICAL: every one of these endpoints serves identical OpenAI model weights (verified
    // empirically 2026-10-24 for text-embedding-3-small: Azure EU Data Zone vs. OpenAI global,
    // cosine 1.000000, max |diff| 1.2e-4, EN+IT). A persisted embedding space's fingerprint must
    // never depend on which of these endpoints answered it, or flipping OPENAI_DATA_RESIDENCY or
    // AZURE_OPENAI_ENDPOINT after a workspace has already ingested documents would strand every
    // persisted space with no resolvable binding.
    const global = endpointScopeFingerprint(openai);
    const globalExplicit = endpointScopeFingerprint({ ...openai, openAIDataResidency: "global" });
    const eu = endpointScopeFingerprint({ ...openai, openAIDataResidency: "eu" });
    const us = endpointScopeFingerprint({ ...openai, openAIDataResidency: "us" });
    const azure = endpointScopeFingerprint({
      ...openai,
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    });
    const otherAzureResource = endpointScopeFingerprint({
      ...openai,
      openAIAzureBaseUrl: "https://radioso-eu-2.openai.azure.com/openai/v1",
    });

    // Pinned to the exact pre-data-residency value: a deployment that predates residency or
    // Azure never sees its persisted embedding spaces' fingerprint change underneath it.
    expect(global).toBe("de82d5077cc230354de650bce4c29d57c8a74e2ea95b6de9c193a649e328845d");
    expect(globalExplicit).toBe(global);
    expect(eu).toBe(global);
    expect(us).toBe(global);
    expect(azure).toBe(global);
    expect(otherAzureResource).toBe(global);
  });

  it("resolves a space persisted under the global fingerprint when OPENAI_DATA_RESIDENCY or AZURE_OPENAI_ENDPOINT changes", () => {
    const persistedFingerprint = endpointScopeFingerprint(openai);
    const platformEu: LlmCapabilityConfig = { ...openai, openAIDataResidency: "eu" };
    const platformAzure: LlmCapabilityConfig = {
      ...openai,
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    };

    expect(
      resolveEmbeddingProviderBinding("text-embedding-3-small", platformEu, [platformEu], {
        endpointScopeFingerprint: persistedFingerprint,
      }),
    ).toBe(platformEu);
    expect(
      resolveEmbeddingProviderBinding("text-embedding-3-small", platformAzure, [platformAzure], {
        endpointScopeFingerprint: persistedFingerprint,
      }),
    ).toBe(platformAzure);
  });
});
