import { describe, expect, it } from "vitest";

import { openAIBaseUrlForResidency, resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";

const baseEnv = {
  OPENAI_API_KEY: "sk-test",
} as const;

describe("openAIBaseUrlForResidency", () => {
  it("maps each residency value, and leaves the default (global) as the SDK default", () => {
    expect(openAIBaseUrlForResidency("global")).toBeUndefined();
    expect(openAIBaseUrlForResidency("us")).toBe("https://us.api.openai.com/v1");
    expect(openAIBaseUrlForResidency("eu")).toBe("https://eu.api.openai.com/v1");
    expect(openAIBaseUrlForResidency(undefined)).toBeUndefined();
  });

  it("never resolves a prototype property name, even when handed one directly", () => {
    // The map is looked up through a literal-equality guard, not a bracket lookup on an
    // untrusted string, so no Object.prototype property can ever surface as a "base URL".
    expect(openAIBaseUrlForResidency("constructor")).toBeUndefined();
    expect(openAIBaseUrlForResidency("toString")).toBeUndefined();
    expect(openAIBaseUrlForResidency("hasOwnProperty")).toBeUndefined();
    expect(openAIBaseUrlForResidency("__proto__")).toBeUndefined();
  });
});

describe("resolveLlmConfig OpenAI data residency", () => {
  it("passes no base URL for openai when OPENAI_DATA_RESIDENCY is unset", () => {
    const config = resolveLlmConfig({ ...baseEnv });
    expect(config.chat).not.toHaveProperty("baseUrl");
    expect(config.embeddings).not.toHaveProperty("baseUrl");
  });

  it("passes no base URL when OPENAI_DATA_RESIDENCY is explicitly global", () => {
    const config = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "global" });
    expect(config.chat).not.toHaveProperty("baseUrl");
  });

  it("resolves the eu endpoint for every openai capability default", () => {
    const config = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    expect(config.chat.baseUrl).toBe("https://eu.api.openai.com/v1");
    expect(config.rewrite.baseUrl).toBe("https://eu.api.openai.com/v1");
    expect(config.rerank.baseUrl).toBe("https://eu.api.openai.com/v1");
    expect(config.embeddings.baseUrl).toBe("https://eu.api.openai.com/v1");
  });

  it("resolves the us endpoint", () => {
    const config = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "us" });
    expect(config.chat.baseUrl).toBe("https://us.api.openai.com/v1");
  });

  it("carries the residency base URL onto the supplemental openai embedding config", () => {
    const config = resolveLlmConfig({
      ...baseEnv,
      LLM_EMBEDDING_PROVIDER: "gemini",
      GEMINI_API_KEY: "gemini-test",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    const openaiSupplement = config.embeddingProviderConfigs.find((entry) => entry.provider === "openai");
    expect(openaiSupplement?.baseUrl).toBe("https://eu.api.openai.com/v1");
  });

  it("leaves a non-openai provider's base URL untouched by the residency setting", () => {
    const config = resolveLlmConfig({
      ...baseEnv,
      ANTHROPIC_API_KEY: "claude-test",
      LLM_CHAT_PROVIDER: "claude",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    expect(config.chat).not.toHaveProperty("baseUrl");
  });

  it("leaves openai-compatible's own base URL requirement untouched by the residency setting", () => {
    const config = resolveLlmConfig({
      ...baseEnv,
      LLM_CHAT_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL: "https://compat.example.com/v1",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    expect(config.chat.baseUrl).toBe("https://compat.example.com/v1");
  });

  it("stamps openAIDataResidency on every openai capability default, independent of baseUrl", () => {
    const config = resolveLlmConfig({ ...baseEnv });
    expect(config.chat.openAIDataResidency).toBe("global");
    expect(config.embeddings.openAIDataResidency).toBe("global");

    const euConfig = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    expect(euConfig.chat.openAIDataResidency).toBe("eu");
  });

  it("derives openAIPlatformResidency once, present only when a platform OpenAI key is configured", () => {
    const withKey = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    expect(withKey.openAIPlatformResidency).toEqual({
      residency: "eu",
      baseUrl: "https://eu.api.openai.com/v1",
    });

    const withoutKey = resolveLlmConfig({
      ANTHROPIC_API_KEY: "claude-test",
      LLM_PROVIDER: "claude",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    expect(withoutKey.openAIPlatformResidency).toBeUndefined();
  });

  it("derives openAIPlatformResidency at the default (global) residency with no base URL", () => {
    const config = resolveLlmConfig({ ...baseEnv });
    expect(config.openAIPlatformResidency).toEqual({ residency: "global", baseUrl: undefined });
  });
});
