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

  it("distinguishes native openai's data-residency endpoints, without shifting the default (global) scope", () => {
    const global = endpointScopeFingerprint(openai);
    const globalExplicit = endpointScopeFingerprint({ ...openai, openAIDataResidency: "global" });
    const eu = endpointScopeFingerprint({ ...openai, openAIDataResidency: "eu" });
    const us = endpointScopeFingerprint({ ...openai, openAIDataResidency: "us" });

    // Pinned to the exact pre-data-residency value: an unset residency and an explicit
    // "global" one both match it, so no deployment that predates this setting sees its
    // persisted embedding spaces' fingerprint change underneath it.
    expect(global).toBe("de82d5077cc230354de650bce4c29d57c8a74e2ea95b6de9c193a649e328845d");
    expect(globalExplicit).toBe(global);
    expect(eu).not.toBe(global);
    expect(us).not.toBe(global);
    expect(eu).not.toBe(us);
  });

  it("distinguishes a platform Azure OpenAI endpoint by its host, from the global scope, and from another Azure resource", () => {
    const global = endpointScopeFingerprint(openai);
    const azure = endpointScopeFingerprint({
      ...openai,
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    });
    const azureTrailingSlash = endpointScopeFingerprint({
      ...openai,
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1/",
    });
    const otherAzureResource = endpointScopeFingerprint({
      ...openai,
      openAIAzureBaseUrl: "https://radioso-eu-2.openai.azure.com/openai/v1",
    });

    expect(azure).not.toBe(global);
    expect(azure).not.toBe(otherAzureResource);
    // Trailing-slash variance collapses, matching the openai-compatible fingerprint's own
    // normalization.
    expect(azure).toBe(azureTrailingSlash);
    expect(azure).not.toContain("radioso-eu-1");
  });

  it("never binds a platform-Azure capability and a BYOK-global capability to the same embedding provider instance", () => {
    const byokGlobal: LlmCapabilityConfig = { ...openai, apiKey: "byok-secret" };
    const platformAzure: LlmCapabilityConfig = {
      ...openai,
      apiKey: "azure-secret",
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    };

    expect(endpointScopeFingerprint(byokGlobal)).not.toBe(endpointScopeFingerprint(platformAzure));
  });
});
