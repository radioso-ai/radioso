import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRerankGateway, OpenAISemanticRerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { OpenAIEmbeddingClient, OpenAITextGenerationClient } from "../../src/shared/infra/llm/openaiProvider.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { TextGenerationClient, TextGenerationRequest } from "../../src/shared/infra/llm/providerTypes.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { streamResult, textResult } from "../support/llmStubs.js";
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
    expect(registry.identifyEmbeddingModel("gemini-embedding-001")).toEqual({
      capability: "embeddings",
      provider: "gemini",
      model: "gemini-embedding-001",
    });
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

describe("OpenAISemanticRerankGateway", () => {
  const usageContext = {
    workspaceId: "ws-1",
    surface: "assistant",
    operation: "rerank",
    attemptKey: "rerank:0",
  } as const;

  const context: RetrievedCandidate = {
    chunkId: "chunk-1",
    documentId: "doc-1",
    title: "Doc",
    content: "Relevant content",
    similarity: 0.8,
    metadata: {},
    retrievalSources: [],
    retrievalText: "Relevant content",
    semanticScore: 0.8,
    lexicalScore: 0,
  };

  it("omits temperature and requests minimal reasoning for GPT-5 rerank models", async () => {
    let request: Record<string, unknown> | undefined;
    const gateway = new OpenAISemanticRerankGateway(
      {
        responses: {
          async create(input: Record<string, unknown>) {
            request = input;
            return { output_text: JSON.stringify({ scores: [{ candidateIndex: 1, relevanceScore: 0.91 }] }) };
          },
        },
      },
      "gpt-5-nano",
    );

    await gateway.rerank({ query: "retreats", contexts: [context], usageContext });

    expect(request).toMatchObject({ model: "gpt-5-nano", reasoning: { effort: "minimal" } });
    expect(request).not.toHaveProperty("temperature");
  });

  it("keeps temperature for non-reasoning OpenAI rerank models", async () => {
    let request: Record<string, unknown> | undefined;
    const gateway = new OpenAISemanticRerankGateway(
      {
        responses: {
          async create(input: Record<string, unknown>) {
            request = input;
            return { output_text: JSON.stringify({ scores: [{ candidateIndex: 1, relevanceScore: 0.91 }] }) };
          },
        },
      },
      "gpt-4.1-mini",
    );

    await gateway.rerank({ query: "retreats", contexts: [context], usageContext });

    expect(request).toMatchObject({ model: "gpt-4.1-mini", temperature: 0.2 });
    expect(request).not.toHaveProperty("reasoning");
  });
});

describe("ModelRerankGateway", () => {
  it("requests minimal reasoning effort for openai-compatible rerank models", async () => {
    const requests: TextGenerationRequest[] = [];
    const gateway = new ModelRerankGateway(new ModelInferencePipelineService({
      metadata: { capability: "rerank", provider: "openai-compatible", model: "rerank-model" },
      async complete(input) {
        requests.push(input);
        return textResult(JSON.stringify({ scores: [{ candidateIndex: 1, relevanceScore: 0.9 }] }));
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient));

    await gateway.rerank({
      query: "retreats",
      contexts: [{
        chunkId: "chunk-1",
        documentId: "doc-1",
        title: "Doc",
        content: "Relevant content",
        similarity: 0.8,
        metadata: {},
        retrievalSources: [],
        retrievalText: "Relevant content",
        semanticScore: 0.8,
        lexicalScore: 0,
      }],
      usageContext: {
        workspaceId: "ws-1",
        surface: "assistant",
        operation: "rerank",
        attemptKey: "rerank:0",
      },
    });

    expect(requests[0]?.reasoningEffort).toBe("minimal");
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

  const unsupportedReasoningEffortError = () =>
    Object.assign(new Error("Unsupported value: 'reasoning_effort' does not support 'minimal'."), {
      status: 400,
      code: "unsupported_value",
      param: "reasoning_effort",
    });

  const stubChatCreate = (
    client: OpenAITextGenerationClient,
    create: (input: Record<string, unknown>) => Promise<unknown>,
  ) => {
    (
      client as unknown as {
        client: { chat: { completions: { create(input: Record<string, unknown>): Promise<unknown> } } };
      }
    ).client.chat.completions.create = create;
  };

  it("retries chat completion without reasoning_effort when the model rejects the value", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAITextGenerationClient({
      capability: "rewrite",
      provider: "openai",
      model: "gpt-5.4-nano-complete-test",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async (input) => {
      requests.push(input);
      if ("reasoning_effort" in input) {
        throw unsupportedReasoningEffortError();
      }
      return { choices: [{ message: { content: "ok" } }] };
    });

    const result = await client.complete({ prompt: "hi", reasoningEffort: "minimal" });

    expect(result.text).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning_effort", "minimal");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
  });

  it("rethrows chat completion errors unrelated to reasoning_effort", async () => {
    const client = new OpenAITextGenerationClient({
      capability: "rewrite",
      provider: "openai",
      model: "gpt-5.4-nano-rethrow-test",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async () => {
      throw Object.assign(new Error("rate limited"), { status: 429, code: "rate_limit_exceeded" });
    });

    await expect(client.complete({ prompt: "hi", reasoningEffort: "minimal" })).rejects.toThrow("rate limited");
  });

  it("retries streaming without reasoning_effort when the model rejects the value", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai",
      model: "gpt-5.4-nano-stream-test",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async (input) => {
      requests.push(input);
      if ("reasoning_effort" in input) {
        throw unsupportedReasoningEffortError();
      }
      return (async function* () {
        yield { id: "c1", choices: [{ delta: { content: "A" } }] };
        yield { id: "c1", choices: [{ delta: { content: "B" } }] };
      })();
    });

    const chunks: string[] = [];
    const { textStream } = client.stream({ prompt: "hi", reasoningEffort: "minimal" });
    for await (const chunk of textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["A", "B"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning_effort", "minimal");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
  });
});

describe("OpenAIEmbeddingClient", () => {
  it("does not force storage dimensions for native OpenAI text-embedding-3 models", async () => {
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
    });
    expect(request).not.toHaveProperty("dimensions");
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
