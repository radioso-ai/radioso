import { describe, expect, it } from "vitest";

import { resolvedProviderEndpointIdentity } from "../../src/shared/infra/llm/providerTypes.js";
import type { LlmCapabilityDefault } from "../../src/shared/infra/llm/providerTypes.js";

const openai = (overrides: Partial<LlmCapabilityDefault> = {}): LlmCapabilityDefault => ({
  capability: "embeddings",
  provider: "openai",
  model: "text-embedding-3-small",
  ...overrides,
});

describe("resolvedProviderEndpointIdentity", () => {
  it("is always defined for native openai — global, residency, and Azure all resolve to a concrete host", () => {
    expect(resolvedProviderEndpointIdentity(openai())).toBe("https://api.openai.com/v1");
    expect(resolvedProviderEndpointIdentity(openai({ openAIDataResidency: "global" }))).toBe(
      "https://api.openai.com/v1",
    );
    expect(resolvedProviderEndpointIdentity(openai({ openAIDataResidency: "eu" }))).toBe(
      "https://eu.api.openai.com/v1",
    );
    expect(resolvedProviderEndpointIdentity(openai({ openAIDataResidency: "us" }))).toBe(
      "https://us.api.openai.com/v1",
    );
    expect(
      resolvedProviderEndpointIdentity(
        openai({ openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1" }),
      ),
    ).toBe("https://radioso-eu-1.openai.azure.com/openai/v1");
  });

  it("never collapses a platform-Azure identity onto a BYOK-global identity, even with baseUrl unset on both", () => {
    const byokGlobal = openai();
    const platformAzure = openai({ openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1" });

    expect(byokGlobal.baseUrl).toBeUndefined();
    expect(platformAzure.baseUrl).toBeUndefined();
    expect(resolvedProviderEndpointIdentity(byokGlobal)).not.toBe(resolvedProviderEndpointIdentity(platformAzure));
  });

  it("distinguishes two different Azure resources", () => {
    const first = resolvedProviderEndpointIdentity(
      openai({ openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1" }),
    );
    const second = resolvedProviderEndpointIdentity(
      openai({ openAIAzureBaseUrl: "https://radioso-eu-2.openai.azure.com/openai/v1" }),
    );
    expect(first).not.toBe(second);
  });

  it("falls back to baseUrl for non-openai providers", () => {
    const compatible: LlmCapabilityDefault = {
      capability: "embeddings",
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      baseUrl: "https://compat.example.com/v1",
    };
    const gemini: LlmCapabilityDefault = {
      capability: "embeddings",
      provider: "gemini",
      model: "gemini-embedding-001",
    };
    expect(resolvedProviderEndpointIdentity(compatible)).toBe("https://compat.example.com/v1");
    expect(resolvedProviderEndpointIdentity(gemini)).toBeUndefined();
  });
});
