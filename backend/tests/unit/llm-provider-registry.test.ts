import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRerankGateway, OpenAISemanticRerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { OpenAIEmbeddingClient, OpenAITextGenerationClient } from "../../src/shared/infra/llm/openaiProvider.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type {
  LlmCapabilityConfig,
  TextGenerationClient,
  TextGenerationRequest,
} from "../../src/shared/infra/llm/providerTypes.js";
import {
  endpointScopeFingerprint,
} from "../../src/shared/infra/llm/embeddingProviderResolver.js";
import type {
  EmbeddingUsageEvent,
  ModelUsageEvent,
  UsageEventRecorder,
} from "../../src/shared/domain/usageEventRecorder.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { captureModelCallTrace } from "../../src/shared/observability/tracing/modelCallTraceContext.js";
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

  it("routes the catalogued Gemini model explicitly with its native vector width", async () => {
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
      return Response.json({
        embedding: { values: [1, ...new Array(3071).fill(0)] },
      });
    });

    const registry = new LlmProviderRegistry(config);
    expect(registry.canServeEmbeddingModel("gemini-embedding-001")).toBe(true);
    expect(registry.identifyEmbeddingModel("gemini-embedding-001")).toEqual({
      capability: "embeddings",
      provider: "gemini",
      model: "gemini-embedding-001",
    });
    expect(registry.resolveEmbeddingModelBinding("gemini-embedding-001")).toEqual({
      provider: "gemini",
      endpointScopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const embeddings = await registry.createEmbeddingGateway().embedTexts(["hello"], {
      model: "gemini-embedding-001",
    });

    expect(embeddings).toEqual([[1, ...new Array(3071).fill(0)]]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/gemini-embedding-001:embedContent");
    expect(requests[0]?.url).toContain("key=gemini-key");
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]?.body).toMatchObject({
      model: "models/gemini-embedding-001",
      outputDimensionality: 3072,
      taskType: "RETRIEVAL_DOCUMENT",
      content: {
        parts: [{ text: "hello" }],
      },
    });
  });

  it("rejects malformed provider vectors through the production gateway", async () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
    });
    vi.stubGlobal("fetch", async () =>
      Response.json({ embedding: { values: [1, 0] } }),
    );

    await expect(
      new LlmProviderRegistry(config)
        .createEmbeddingGateway()
        .embedTexts(["hello"], { model: "gemini-embedding-001" }),
    ).rejects.toThrow(
      "dimensions 2 do not match expected dimensions 3072",
    );
  });

  it("rejects caller dimensions that disagree with the catalog descriptor", async () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      new LlmProviderRegistry(config)
        .createEmbeddingGateway()
        .embedTexts(["hello"], {
          model: "text-embedding-3-small",
          dimensions: 3072,
        }),
    ).rejects.toThrow(
      "requested dimensions 3072 do not match descriptor dimensions 1536",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records the routed provider identity rather than primary embedding metadata", async () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
    });
    const embeddingEvents: EmbeddingUsageEvent[] = [];
    const recorder: UsageEventRecorder = {
      async recordEmbedding(event) {
        embeddingEvents.push(event);
      },
      async recordModelCall(_event: ModelUsageEvent) {},
    };
    vi.stubGlobal("fetch", async () =>
      Response.json({
        embedding: { values: [1, ...new Array(3071).fill(0)] },
      }),
    );

    await new LlmProviderRegistry(config)
      .createEmbeddingGateway(recorder)
      .embedTexts(["hello"], {
        model: "gemini-embedding-001",
        provider: "gemini",
      });

    expect(embeddingEvents).toHaveLength(1);
    expect(embeddingEvents[0]).toMatchObject({
      provider: "gemini",
      model: "gemini-embedding-001",
    });
    expect(embeddingEvents[0]?.idempotencyKey).toContain(
      ":gemini:gemini-embedding-001:",
    );
  });

  it("routes pinned embedding generation to the exact persisted endpoint scope", async () => {
    const baseConfig = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
    });
    const endpointA: LlmCapabilityConfig = {
      capability: "embeddings",
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      apiKey: "endpoint-a-key",
      baseUrl: "https://endpoint-a.example/v1",
    };
    const endpointB: LlmCapabilityConfig = {
      ...endpointA,
      apiKey: "endpoint-b-key",
      baseUrl: "https://endpoint-b.example/v1",
    };
    const unavailableEndpoint: LlmCapabilityConfig = {
      ...endpointA,
      baseUrl: "https://unavailable.example/v1",
    };
    const encodedEmbedding = Buffer.alloc(1536 * Float32Array.BYTES_PER_ELEMENT);
    encodedEmbedding.writeFloatLE(1, 0);
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      requestedUrls.push(
        input instanceof Request ? input.url : String(input),
      );
      return Response.json({
        data: [{
          index: 0,
          embedding: encodedEmbedding.toString("base64"),
        }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    });

    const registry = new LlmProviderRegistry({
      ...baseConfig,
      embeddings: endpointB,
      embeddingProviderConfigs: [endpointB, endpointA],
    });
    const gateway = registry.createEmbeddingGateway();

    await expect(gateway.embedTexts(["hello"], {
      model: "text-embedding-3-small",
      provider: "openai-compatible",
      endpointScopeFingerprint: endpointScopeFingerprint(endpointA),
    })).resolves.toHaveLength(1);
    expect(requestedUrls).toEqual([
      "https://endpoint-a.example/v1/embeddings",
    ]);

    await expect(gateway.embedTexts(["hello"], {
      model: "text-embedding-3-small",
      provider: "openai-compatible",
      endpointScopeFingerprint: endpointScopeFingerprint(unavailableEndpoint),
    })).rejects.toThrow("No configured embedding provider can serve model");
    expect(requestedUrls).toHaveLength(1);
  });

  it("constructs a production fixed-input probe for transition orchestration", async () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
    });
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        embedding: { values: [1, ...new Array(3071).fill(0)] },
      });
    });

    const result = await new LlmProviderRegistry(config)
      .createEmbeddingModelProbe("gemini-embedding-001", "gemini")
      .probe();

    expect(result.vectors).toHaveLength(1);
    expect(requestBody).toMatchObject({
      outputDimensionality: 3072,
      taskType: "RETRIEVAL_DOCUMENT",
      content: {
        parts: [{ text: "Radioso embedding compatibility probe." }],
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
            return {
              output_text: JSON.stringify({ scores: [{ candidateIndex: 1, relevanceScore: 0.91 }] }),
              usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
            };
          },
        },
      },
      "gpt-5-nano",
    );

    await gateway.rerank({ query: "retreats", today: "2026-01-01", contexts: [context], usageContext });

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
            return {
              output_text: JSON.stringify({ scores: [{ candidateIndex: 1, relevanceScore: 0.91 }] }),
              usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
            };
          },
        },
      },
      "gpt-4.1-mini",
    );

    const { calls } = await captureModelCallTrace(() =>
      gateway.rerank({ query: "retreats", today: "2026-01-01", contexts: [context], usageContext }));

    expect(request).toMatchObject({ model: "gpt-4.1-mini", temperature: 0.2 });
    expect(request).not.toHaveProperty("reasoning");
    expect(calls).toEqual([expect.objectContaining({
      operation: "rerank",
      model: "gpt-4.1-mini",
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
    })]);
  });

  it("retries without reasoning and reranks when the model rejects the effort", async () => {
    const requests: Record<string, unknown>[] = [];
    const gateway = new OpenAISemanticRerankGateway(
      {
        responses: {
          async create(input: Record<string, unknown>) {
            requests.push(input);
            if ("reasoning" in input) {
              throw Object.assign(new Error("Unsupported value: 'reasoning.effort' does not support 'minimal'."), {
                status: 400,
                code: "unsupported_value",
                param: "reasoning.effort",
              });
            }
            return {
              output_text: JSON.stringify({ scores: [{ candidateIndex: 1, relevanceScore: 0.93 }] }),
              usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
            };
          },
        },
      },
      "gpt-5.4-nano-rerank-test",
    );

    const { result, calls } = await captureModelCallTrace(() =>
      gateway.rerank({ query: "retreats", today: "2026-01-01", contexts: [context], usageContext }));

    // First attempt sends reasoning; on rejection it retries without it and still
    // reranks (rather than throwing through to the similarity fallback).
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning");
    expect(requests[1]).not.toHaveProperty("reasoning");
    expect(result).toEqual([{ chunkId: "chunk-1", relevanceScore: 0.93 }]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual([
      expect.objectContaining({ operation: "rerank", model: "gpt-5.4-nano-rerank-test" }),
      expect.objectContaining({
        operation: "rerank",
        model: "gpt-5.4-nano-rerank-test",
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      }),
    ]);
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
      today: "2026-01-01",
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

  it("retries chat completion without reasoning_effort when the model rejects the normalized value", async () => {
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
    expect(requests[0]).toHaveProperty("reasoning_effort", "none");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
  });

  it("uses the older gpt-5 family effort floor instead of stripping unsupported none to provider default", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai",
      model: "gpt-5-nano",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async (input) => {
      requests.push(input);
      if (input.reasoning_effort === "none") {
        throw unsupportedReasoningEffortError();
      }
      return { choices: [{ message: { content: "ok" } }] };
    });

    const result = await client.complete({ prompt: "hi", reasoningEffort: "none" });

    expect(result.text).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveProperty("reasoning_effort", "minimal");
  });

  it("retries cap-exhausted empty chat completions at explicit low effort", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async (input) => {
      requests.push(input);
      if (requests.length === 1) {
        return {
          id: "resp-empty",
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: {
            prompt_tokens: 6000,
            completion_tokens: 4096,
            total_tokens: 10096,
            prompt_tokens_details: { cached_tokens: 120 },
            completion_tokens_details: { reasoning_tokens: 4096 },
          },
        };
      }
      return {
        id: "resp-retry",
        choices: [{ finish_reason: "stop", message: { content: "Recovered answer" } }],
        usage: {
          prompt_tokens: 6000,
          completion_tokens: 12,
          total_tokens: 6012,
          prompt_tokens_details: { cached_tokens: 120 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      };
    });

    const result = await client.complete({
      prompt: "hi",
      reasoningEffort: "none",
      maxOutputTokens: 4096,
    });

    expect(result.text).toBe("Recovered answer");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning_effort", "none");
    expect(requests[1]).toHaveProperty("reasoning_effort", "low");
    expect(result.usage).toEqual({
      inputTokens: 12000,
      outputTokens: 4108,
      totalTokens: 16108,
      cachedInputTokens: 240,
      reasoningTokens: 4097,
      providerRequestId: "resp-retry",
      quality: "actual",
    });
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

  it("retries streaming without reasoning_effort when the model rejects the normalized value", async () => {
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
    expect(requests[0]).toHaveProperty("reasoning_effort", "none");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
  });

  it("retries cap-exhausted empty streams at explicit low effort", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async (input) => {
      requests.push(input);
      if (requests.length === 1) {
        return (async function* () {
          yield {
            id: "s1",
            choices: [{ delta: {}, finish_reason: "length" }],
            usage: {
              prompt_tokens: 6000,
              completion_tokens: 4096,
              total_tokens: 10096,
              prompt_tokens_details: { cached_tokens: 80 },
              completion_tokens_details: { reasoning_tokens: 4096 },
            },
          };
        })();
      }
      return (async function* () {
        yield { id: "s2", choices: [{ delta: { content: "Recovered" } }] };
        yield { id: "s2", choices: [{ delta: { content: " stream" }, finish_reason: "stop" }] };
        yield {
          id: "s2",
          choices: [],
          usage: {
            prompt_tokens: 6000,
            completion_tokens: 3,
            total_tokens: 6003,
            prompt_tokens_details: { cached_tokens: 80 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        };
      })();
    });

    const chunks: string[] = [];
    const { textStream, usage } = client.stream({
      prompt: "hi",
      reasoningEffort: "none",
      maxOutputTokens: 4096,
    });
    for await (const chunk of textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Recovered", " stream"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning_effort", "none");
    expect(requests[1]).toHaveProperty("reasoning_effort", "low");
    expect(await usage).toEqual({
      inputTokens: 12000,
      outputTokens: 4099,
      totalTokens: 16099,
      cachedInputTokens: 160,
      reasoningTokens: 4097,
      providerRequestId: "s2",
      quality: "actual",
    });
  });

  it("only strips the rejected effort, not a different supported effort on the same model", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAITextGenerationClient({
      capability: "chat",
      provider: "openai",
      model: "gpt-5.4-nano-mixed-test",
      apiKey: "openai-key",
    });
    stubChatCreate(client, async (input) => {
      requests.push(input);
      // This model rejects "minimal" but accepts other efforts (e.g. "low").
      if (input.reasoning_effort === "minimal") {
        throw unsupportedReasoningEffortError();
      }
      return { choices: [{ message: { content: "ok" } }] };
    });

    // A minimal-effort call (e.g. query interpretation) is rejected and retried.
    await client.complete({ prompt: "a", reasoningEffort: "minimal" });
    // A later low-effort call (e.g. answer synthesis) on the SAME model must still
    // send "low" — the minimal rejection must not strip it back to provider default.
    await client.complete({ prompt: "b", reasoningEffort: "low" });

    expect(requests.some((request) => request.reasoning_effort === "low")).toBe(true);
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
