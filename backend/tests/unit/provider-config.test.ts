import { describe, expect, it } from "vitest";

import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";

const baseEnv = {
  OPENAI_API_KEY: "sk-test",
} as const;

describe("resolveLlmConfig OpenAI data residency", () => {
  it("passes no base URL and no openAIDataResidency for openai when OPENAI_DATA_RESIDENCY is unset", () => {
    const config = resolveLlmConfig({ ...baseEnv });
    expect(config.chat).not.toHaveProperty("baseUrl");
    expect(config.chat).not.toHaveProperty("openAIDataResidency");
    expect(config.embeddings).not.toHaveProperty("baseUrl");
  });

  it("passes no base URL when OPENAI_DATA_RESIDENCY is explicitly global", () => {
    const config = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "global" });
    expect(config.chat).not.toHaveProperty("baseUrl");
    expect(config.chat).not.toHaveProperty("openAIDataResidency");
  });

  it("resolves the eu endpoint and residency tag for every openai capability default", () => {
    const config = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" });
    for (const capability of [config.chat, config.rewrite, config.rerank, config.embeddings]) {
      expect(capability.baseUrl).toBe("https://eu.api.openai.com/v1");
      expect(capability.openAIDataResidency).toBe("eu");
    }
  });

  it("resolves the us endpoint", () => {
    const config = resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "us" });
    expect(config.chat.baseUrl).toBe("https://us.api.openai.com/v1");
    expect(config.chat.openAIDataResidency).toBe("us");
  });

  it("throws on an OPENAI_DATA_RESIDENCY value outside the allowed list, rather than coercing to global", () => {
    expect(() =>
      resolveLlmConfig({ ...baseEnv, OPENAI_DATA_RESIDENCY: "apac" } as unknown as Record<string, string>),
    ).toThrow(ProviderConfigurationError);
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
    expect(openaiSupplement?.openAIDataResidency).toBe("eu");
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
    expect(config.chat).not.toHaveProperty("openAIDataResidency");
  });

  it("stamps no regional baseUrl or residency on any openai capability default when no platform key is configured", () => {
    // WorkspaceLlmCapabilityResolver would never reach a regional endpoint here either: without
    // a platform key, a native openai call only ever happens through a workspace's own (BYOK)
    // key, which always resolves as global. The capability defaults agree with that.
    const config = resolveLlmConfig({
      ANTHROPIC_API_KEY: "claude-test",
      LLM_PROVIDER: "claude",
      LLM_EMBEDDING_PROVIDER: "claude",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    expect(config.chat).not.toHaveProperty("baseUrl");
    expect(config.chat).not.toHaveProperty("openAIDataResidency");
    expect(config.openAIPlatformResidency).toBeUndefined();
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
    expect(config.openAIPlatformResidency).toEqual({ residency: "global" });
    expect(config.openAIPlatformResidency).not.toHaveProperty("baseUrl");
  });
});
