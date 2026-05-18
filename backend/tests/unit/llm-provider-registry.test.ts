import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRerankGateway, OpenAISemanticRerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { OpenAIEmbeddingClient, OpenAITextGenerationClient } from "../../src/shared/infra/llm/openaiProvider.js";
import {
  LlmProviderRegistry,
  ProviderConfigurationError,
} from "../../src/shared/infra/llm/providerRegistry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("routes Gemini embedding models to Gemini with the storage vector width", async () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      GEMINI_API_KEY: "gemini-key",
    });
    const requests: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        signal: init?.signal,
      });
      return Response.json({ embedding: { values: new Array(1536).fill(0.25) } });
    });

    const registry = new LlmProviderRegistry(config);
    expect(registry.canServeEmbeddingModel("gemini-embedding-001")).toBe(true);
    const embeddings = await registry.createEmbeddingGateway().embedTexts(["hello"], {
      model: "gemini-embedding-001",
    });

    expect(embeddings).toEqual([new Array(1536).fill(0.25)]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/gemini-embedding-001:embedContent");
    expect(requests[0]?.url).toContain("key=gemini-key");
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]?.body).toMatchObject({
      model: "models/gemini-embedding-001",
      output_dimensionality: 1536,
      content: {
        parts: [{ text: "hello" }],
      },
    });
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

  it("uses the legacy chat-completions rerank gateway for openai-compatible providers", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_RERANK_PROVIDER: "openai-compatible",
      LLM_RERANK_MODEL: "gpt-oss-20b",
      OPENAI_COMPATIBLE_API_KEY: "compat-key",
      OPENAI_COMPATIBLE_BASE_URL: "https://llm.example/v1",
    });

    const registry = new LlmProviderRegistry(config);

    expect(registry.createRerankGateway()).toBeInstanceOf(ModelRerankGateway);
  });

  it("uses the Responses API rerank gateway only for native OpenAI", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      OPENAI_RERANK_MODEL: "gpt-5.2",
    });

    const registry = new LlmProviderRegistry(config);

    expect(registry.createRerankGateway()).toBeInstanceOf(OpenAISemanticRerankGateway);
  });
});

describe("OpenAITextGenerationClient", () => {
  it("uses max_tokens for openai-compatible chat completions", async () => {
    let request: Record<string, unknown> | undefined;
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai-compatible",
      model: "gpt-oss-20b",
      apiKey: "compat-key",
      baseUrl: "https://llm.example/v1",
    });

    (
      client as unknown as {
        client: {
          chat: {
            completions: {
              create(input: Record<string, unknown>): Promise<{ choices: Array<{ message: { content: string } }> }>;
            };
          };
        };
      }
    ).client.chat.completions.create = async (input) => {
      request = input;
      return { choices: [{ message: { content: "ok" } }] };
    };

    await client.complete({
      prompt: "hello",
      maxOutputTokens: 123,
    });

    expect(request).toMatchObject({
      max_tokens: 123,
    });
    expect(request).not.toHaveProperty("max_completion_tokens");
  });

  it("uses max_completion_tokens for native OpenAI chat completions", async () => {
    let request: Record<string, unknown> | undefined;
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai",
      model: "gpt-5.2",
      apiKey: "openai-key",
    });

    (
      client as unknown as {
        client: {
          chat: {
            completions: {
              create(input: Record<string, unknown>): Promise<{ choices: Array<{ message: { content: string } }> }>;
            };
          };
        };
      }
    ).client.chat.completions.create = async (input) => {
      request = input;
      return { choices: [{ message: { content: "ok" } }] };
    };

    await client.complete({
      prompt: "hello",
      maxOutputTokens: 123,
    });

    expect(request).toMatchObject({
      max_completion_tokens: 123,
    });
    expect(request).not.toHaveProperty("max_tokens");
  });
});

describe("OpenAIEmbeddingClient", () => {
  it("requests the storage vector dimensions for native OpenAI text-embedding-3 models", async () => {
    let request: Record<string, unknown> | undefined;
    const client = new OpenAIEmbeddingClient({
      capability: "embeddings",
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "openai-key",
    });

    (
      client as unknown as {
        client: {
          embeddings: {
            create(input: Record<string, unknown>): Promise<{ data: Array<{ embedding: number[] }> }>;
          };
        };
      }
    ).client.embeddings.create = async (input) => {
      request = input;
      return { data: [{ embedding: [0.1, 0.2] }] };
    };

    await client.embedTexts(["hello"]);

    expect(request).toMatchObject({
      model: "text-embedding-3-large",
      input: ["hello"],
      dimensions: 1536,
    });
  });

  it("does not send dimensions to OpenAI-compatible embedding endpoints", async () => {
    let request: Record<string, unknown> | undefined;
    const client = new OpenAIEmbeddingClient({
      capability: "embeddings",
      provider: "openai-compatible",
      model: "text-embedding-3-large",
      apiKey: "compat-key",
      baseUrl: "https://llm.example/v1",
    });

    (
      client as unknown as {
        client: {
          embeddings: {
            create(input: Record<string, unknown>): Promise<{ data: Array<{ embedding: number[] }> }>;
          };
        };
      }
    ).client.embeddings.create = async (input) => {
      request = input;
      return { data: [{ embedding: [0.1, 0.2] }] };
    };

    await client.embedTexts(["hello"]);

    expect(request).toMatchObject({
      model: "text-embedding-3-large",
      input: ["hello"],
    });
    expect(request).not.toHaveProperty("dimensions");
  });
});
