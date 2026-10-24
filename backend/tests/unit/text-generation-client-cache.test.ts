import { describe, expect, it } from "vitest";

import { TextGenerationClientCache } from "../../src/shared/infra/llm/textClientFactory.js";
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";

const baseConfig = (overrides: Partial<LlmCapabilityConfig> = {}): LlmCapabilityConfig => ({
  capability: "chat",
  provider: "claude",
  model: "claude-sonnet-4-6",
  apiKey: "sk-original",
  ...overrides,
});

describe("TextGenerationClientCache", () => {
  it("reuses the same client for identical configs", () => {
    const cache = new TextGenerationClientCache();
    const a = cache.getOrCreate(baseConfig());
    const b = cache.getOrCreate(baseConfig());
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it("creates a new client when the apiKey changes (rotation lookups skip stale entries)", () => {
    const cache = new TextGenerationClientCache();
    const before = cache.getOrCreate(baseConfig({ apiKey: "sk-old" }));
    const after = cache.getOrCreate(baseConfig({ apiKey: "sk-new" }));
    expect(after).not.toBe(before);
    expect(cache.size).toBe(2);
  });

  it("evicts the oldest entry once the LRU bound is exceeded", () => {
    const cache = new TextGenerationClientCache({ maxEntries: 2 });
    cache.getOrCreate(baseConfig({ apiKey: "k1" }));
    cache.getOrCreate(baseConfig({ apiKey: "k2" }));
    cache.getOrCreate(baseConfig({ apiKey: "k3" }));
    expect(cache.size).toBe(2);
    // k1 should have been evicted (oldest); requesting it again creates a fresh entry,
    // which means cache.size momentarily becomes 3 → 2 after evicting k2 (the new oldest).
    const sizeBefore = cache.size;
    cache.getOrCreate(baseConfig({ apiKey: "k1" }));
    expect(cache.size).toBe(sizeBefore);
  });

  it("touching an entry refreshes its LRU position", () => {
    const cache = new TextGenerationClientCache({ maxEntries: 2 });
    const first = cache.getOrCreate(baseConfig({ apiKey: "k1" }));
    cache.getOrCreate(baseConfig({ apiKey: "k2" }));
    // Re-touch k1; now k2 is the oldest.
    cache.getOrCreate(baseConfig({ apiKey: "k1" }));
    cache.getOrCreate(baseConfig({ apiKey: "k3" }));
    // k2 was evicted; k1 should still be the same instance.
    const k1Again = cache.getOrCreate(baseConfig({ apiKey: "k1" }));
    expect(k1Again).toBe(first);
  });
});

describe("TextGenerationClientCache native openai endpoint identity", () => {
  const openaiConfig = (overrides: Partial<LlmCapabilityConfig> = {}): LlmCapabilityConfig => ({
    capability: "chat",
    provider: "openai",
    model: "gpt-5.4-mini",
    apiKey: "sk-shared",
    ...overrides,
  });

  it("never shares a client between a platform-Azure config and a BYOK-global config, even with the same apiKey", () => {
    const cache = new TextGenerationClientCache();
    const azure = cache.getOrCreate(
      openaiConfig({ openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1" }),
    );
    const global = cache.getOrCreate(openaiConfig());

    expect(azure).not.toBe(global);
    expect(cache.size).toBe(2);
  });

  it("never shares a client between two distinct Azure resources", () => {
    const cache = new TextGenerationClientCache();
    const first = cache.getOrCreate(
      openaiConfig({ openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1" }),
    );
    const second = cache.getOrCreate(
      openaiConfig({ openAIAzureBaseUrl: "https://radioso-eu-2.openai.azure.com/openai/v1" }),
    );

    expect(first).not.toBe(second);
  });

  it("never shares a client between platform-EU residency and BYOK-global residency", () => {
    const cache = new TextGenerationClientCache();
    const eu = cache.getOrCreate(openaiConfig({ openAIDataResidency: "eu" }));
    const global = cache.getOrCreate(openaiConfig());

    expect(eu).not.toBe(global);
  });

  it("reuses the same client for two identical Azure configs", () => {
    const cache = new TextGenerationClientCache();
    const azureConfig = openaiConfig({ openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1" });
    const a = cache.getOrCreate(azureConfig);
    const b = cache.getOrCreate({ ...azureConfig });

    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });
});
