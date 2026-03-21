import { describe, expect, it } from "vitest";

import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import {
  LlmProviderRegistry,
  ProviderConfigurationError,
} from "../../src/shared/infra/llm/providerRegistry.js";

describe("llm provider config", () => {
  it("derives provider-neutral capability config from legacy OpenAI env vars", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5-mini",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      OPENAI_RERANK_MODEL: "gpt-4.1-mini",
    });

    expect(config.chat).toMatchObject({
      capability: "chat",
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: "openai-key",
    });
    expect(config.rewrite).toMatchObject({
      capability: "rewrite",
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: "openai-key",
    });
    expect(config.rerank).toMatchObject({
      capability: "rerank",
      provider: "openai",
      model: "gpt-4.1-mini",
      apiKey: "openai-key",
    });
    expect(config.embeddings).toMatchObject({
      capability: "embeddings",
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "openai-key",
    });
  });

  it("resolves provider-neutral overrides independently per capability", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_CHAT_PROVIDER: "gemini",
      LLM_CHAT_MODEL: "gemini-2.5-flash",
      GEMINI_API_KEY: "gemini-key",
      LLM_REWRITE_PROVIDER: "claude",
      LLM_REWRITE_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_API_KEY: "anthropic-key",
      LLM_RERANK_PROVIDER: "openai-compatible",
      LLM_RERANK_MODEL: "gpt-oss-20b",
      OPENAI_COMPATIBLE_API_KEY: "compat-key",
      OPENAI_COMPATIBLE_BASE_URL: "https://llm.example/v1",
      LLM_EMBEDDING_PROVIDER: "openai",
      LLM_EMBEDDING_MODEL: "text-embedding-3-large",
    });

    expect(config.chat).toMatchObject({
      capability: "chat",
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "gemini-key",
    });
    expect(config.rewrite).toMatchObject({
      capability: "rewrite",
      provider: "claude",
      model: "claude-sonnet-4-5",
      apiKey: "anthropic-key",
    });
    expect(config.rerank).toMatchObject({
      capability: "rerank",
      provider: "openai-compatible",
      model: "gpt-oss-20b",
      apiKey: "compat-key",
      baseUrl: "https://llm.example/v1",
    });
    expect(config.embeddings).toMatchObject({
      capability: "embeddings",
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "openai-key",
    });
  });

  it("uses provider-specific text defaults for non-openai shared providers", () => {
    const geminiConfig = resolveLlmConfig({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "gemini-key",
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
    });

    expect(geminiConfig.chat).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(geminiConfig.rewrite).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(geminiConfig.rerank).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(geminiConfig.embeddings).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });

    const claudeConfig = resolveLlmConfig({
      LLM_PROVIDER: "claude",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      OPENAI_CHAT_MODEL: "gpt-5.2",
    });

    expect(claudeConfig.chat).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    expect(claudeConfig.rewrite).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    expect(claudeConfig.rerank).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    expect(claudeConfig.embeddings).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });
});

describe("LlmProviderRegistry", () => {
  it("rejects claude embeddings before use", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_EMBEDDING_PROVIDER: "claude",
      ANTHROPIC_API_KEY: "anthropic-key",
      LLM_EMBEDDING_MODEL: "claude-sonnet-4-5",
    });

    expect(() => new LlmProviderRegistry(config)).toThrowError(ProviderConfigurationError);
    expect(() => new LlmProviderRegistry(config)).toThrowError(
      "Provider claude does not support embeddings",
    );
  });

  it("rejects gemini embeddings before use because the storage contract is fixed-width", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_EMBEDDING_PROVIDER: "gemini",
      GEMINI_API_KEY: "gemini-key",
      LLM_EMBEDDING_MODEL: "gemini-embedding-001",
    });

    expect(() => new LlmProviderRegistry(config)).toThrowError(ProviderConfigurationError);
    expect(() => new LlmProviderRegistry(config)).toThrowError(
      "Provider gemini does not support embeddings",
    );
  });

  it("describes the resolved provider and model for each capability", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_CHAT_PROVIDER: "openai-compatible",
      LLM_CHAT_MODEL: "gpt-oss-20b",
      OPENAI_COMPATIBLE_API_KEY: "compat-key",
      OPENAI_COMPATIBLE_BASE_URL: "https://llm.example/v1",
    });

    const registry = new LlmProviderRegistry(config);

    expect(registry.describe()).toEqual({
      chat: { capability: "chat", provider: "openai-compatible", model: "gpt-oss-20b" },
      rewrite: { capability: "rewrite", provider: "openai", model: "gpt-5.2" },
      rerank: { capability: "rerank", provider: "openai", model: "gpt-5.2" },
      embeddings: { capability: "embeddings", provider: "openai", model: "text-embedding-3-small" },
    });
  });
});
