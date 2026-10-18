import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const embeddingsCreateMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
    embeddings = { create: embeddingsCreateMock };
  },
}));

import { OpenAIEmbeddingClient, OpenAITextGenerationClient } from "../../src/shared/infra/llm/openaiProvider.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { captureModelCallTrace } from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import {
  buildTurnPlanResponseFormat,
  buildTurnPlanningPrompt,
} from "../../src/modules/chat/services/turnPlanService.js";

const chatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai",
  model: "gpt-test",
  apiKey: "sk-test",
  openAIDataResidency: "global",
};

const euResidencyChatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai",
  model: "gpt-test",
  apiKey: "sk-test",
  baseUrl: "https://eu.api.openai.com/v1",
  openAIDataResidency: "eu",
};

const usResidencyChatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai",
  model: "gpt-test",
  apiKey: "sk-test",
  baseUrl: "https://us.api.openai.com/v1",
  openAIDataResidency: "us",
};

const compatibleChatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai-compatible",
  model: "compat-test",
  apiKey: "sk-test",
  baseUrl: "http://localhost:1234/v1",
};

const embeddingConfig: LlmCapabilityConfig = {
  capability: "embeddings",
  provider: "openai",
  model: "text-embedding-test",
  apiKey: "sk-test",
};

const responseFormat = {
  type: "json_schema" as const,
  name: "answer_envelope",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
};

const asyncIterableOf = <T>(items: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

beforeEach(() => {
  createMock.mockReset();
  embeddingsCreateMock.mockReset();
});

describe("OpenAITextGenerationClient.complete", () => {
  it("forwards strict JSON schema output to chat completions", async () => {
    createMock.mockResolvedValue({
      id: "resp-structured",
      choices: [{ message: { content: '{"answer":"Hello"}' } }],
    });

    await new OpenAITextGenerationClient(chatConfig).complete({ prompt: "Hi", responseFormat });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: responseFormat.name,
          strict: true,
          schema: responseFormat.schema,
        },
      },
    }));
  });

  it("omits strict JSON schema output for OpenAI-compatible completions", async () => {
    createMock.mockResolvedValue({
      id: "resp-compatible-structured",
      choices: [{ message: { content: '{"answer":"Hello"}' } }],
    });

    await new OpenAITextGenerationClient(compatibleChatConfig).complete({ prompt: "Hi", responseFormat });

    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("response_format");
  });

  it.each([chatConfig, compatibleChatConfig])("passes AbortSignal to %s completion requests", async (config) => {
    createMock.mockResolvedValue({
      id: "resp-signal",
      choices: [{ message: { content: "Hello" } }],
    });
    const controller = new AbortController();

    await new OpenAITextGenerationClient(config).complete({ prompt: "Hi", signal: controller.signal });

    expect(createMock).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  it("returns generated text plus provider-reported usage marked actual", async () => {
    createMock.mockResolvedValue({
      id: "resp-1",
      choices: [{ message: { content: "Hello" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 5,
        total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });

    const result = await new OpenAITextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.text).toBe("Hello");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      cachedInputTokens: 3,
      cacheAccounting: { state: "reported", readInputTokens: 3 },
      reasoningTokens: 2,
      providerRequestId: "resp-1",
      quality: "actual",
    });
  });

  it("keeps a reported zero cache read distinct from absent cache accounting", async () => {
    createMock
      .mockResolvedValueOnce({
        id: "resp-zero",
        choices: [{ message: { content: "Hello" } }],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16, prompt_tokens_details: { cached_tokens: 0 } },
      })
      .mockResolvedValueOnce({
        id: "resp-absent",
        choices: [{ message: { content: "Hello" } }],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      });
    const client = new OpenAITextGenerationClient(chatConfig);

    const reportedZero = await client.complete({ prompt: "Hi" });
    const absent = await client.complete({ prompt: "Hi" });

    expect(reportedZero.usage?.cacheAccounting).toEqual({ state: "reported", readInputTokens: 0 });
    expect(absent.usage?.cacheAccounting).toEqual({ state: "unknown" });
  });

  it("sums cache reads across the low-reasoning retry of an empty capped completion", async () => {
    createMock
      .mockResolvedValueOnce({
        id: "resp-capped",
        choices: [{ finish_reason: "length", message: { content: "" } }],
        usage: { prompt_tokens: 2000, completion_tokens: 64, total_tokens: 2064, prompt_tokens_details: { cached_tokens: 1024 } },
      })
      .mockResolvedValueOnce({
        id: "resp-retried",
        choices: [{ finish_reason: "stop", message: { content: "Hello" } }],
        usage: { prompt_tokens: 2000, completion_tokens: 10, total_tokens: 2010, prompt_tokens_details: { cached_tokens: 1920 } },
      });

    const result = await new OpenAITextGenerationClient(chatConfig).complete({
      prompt: "Hi",
      reasoningEffort: "medium",
    });

    expect(result.text).toBe("Hello");
    expect(result.usage).toMatchObject({
      cachedInputTokens: 2944,
      cacheAccounting: { state: "reported", readInputTokens: 2944 },
    });
  });

  it("omits usage when the provider returns none", async () => {
    createMock.mockResolvedValue({
      id: "resp-2",
      choices: [{ message: { content: "Hello" } }],
    });

    const result = await new OpenAITextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.text).toBe("Hello");
    expect(result.usage).toBeUndefined();
  });
});

describe("OpenAITextGenerationClient.stream", () => {
  it("forwards strict JSON schema output to streaming chat completions", async () => {
    createMock.mockResolvedValue(asyncIterableOf([]));

    const { textStream } = new OpenAITextGenerationClient(chatConfig).stream({
      prompt: "Hi",
      responseFormat,
    });
    for await (const _chunk of textStream) {
      // drain
    }

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: responseFormat.name,
          strict: true,
          schema: responseFormat.schema,
        },
      },
    }));
  });

  it("omits strict JSON schema output for OpenAI-compatible streams", async () => {
    createMock.mockResolvedValue(asyncIterableOf([]));

    const { textStream } = new OpenAITextGenerationClient(compatibleChatConfig).stream({
      prompt: "Hi",
      responseFormat,
    });
    for await (const _chunk of textStream) {
      // drain
    }

    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("response_format");
  });

  it.each([chatConfig, compatibleChatConfig])("passes AbortSignal to %s streaming requests", async (config) => {
    createMock.mockResolvedValue(asyncIterableOf([]));
    const controller = new AbortController();

    const { textStream } = new OpenAITextGenerationClient(config).stream({
      prompt: "Hi",
      signal: controller.signal,
    });
    for await (const _chunk of textStream) {
      // drain
    }

    expect(createMock).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  it("yields text chunks and resolves usage from the final usage-only chunk", async () => {
    createMock.mockResolvedValue(
      asyncIterableOf([
        { id: "resp-3", choices: [{ delta: { content: "Hel" } }] },
        { id: "resp-3", choices: [{ delta: { content: "lo" } }] },
        { id: "resp-3", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
      ]),
    );

    const { textStream, usage } = new OpenAITextGenerationClient(chatConfig).stream({ prompt: "Hi" });

    const chunks: string[] = [];
    for await (const chunk of textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(await usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      cachedInputTokens: undefined,
      cacheAccounting: { state: "unknown" },
      reasoningTokens: undefined,
      providerRequestId: "resp-3",
      quality: "actual",
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, stream_options: { include_usage: true } }),
    );
  });

  it("does not send OpenAI-only stream usage options to compatible endpoints", async () => {
    createMock.mockResolvedValue(
      asyncIterableOf([{ id: "resp-compatible", choices: [{ delta: { content: "Hi" } }] }]),
    );

    const { textStream } = new OpenAITextGenerationClient(compatibleChatConfig).stream({
      prompt: "Hi",
      maxOutputTokens: 20,
    });

    for await (const _chunk of textStream) {
      // drain
    }

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, max_tokens: 20 }),
    );
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("stream_options");
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("resolves usage to undefined when the stream carries no usage chunk", async () => {
    createMock.mockResolvedValue(
      asyncIterableOf([{ id: "resp-4", choices: [{ delta: { content: "Hi" } }] }]),
    );

    const { textStream, usage } = new OpenAITextGenerationClient(chatConfig).stream({ prompt: "Hi" });

    for await (const _chunk of textStream) {
      // drain
    }

    expect(await usage).toBeUndefined();
  });

  it("resolves usage without rejecting when the stream errors mid-flight", async () => {
    createMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        throw new Error("stream blew up");
      },
    });

    const { textStream, usage } = new OpenAITextGenerationClient(chatConfig).stream({ prompt: "Hi" });

    await expect((async () => {
      for await (const _chunk of textStream) {
        // drain
      }
    })()).rejects.toThrow("stream blew up");

    await expect(usage).resolves.toBeUndefined();
  });
});

describe("OpenAITextGenerationClient prompt cache routing", () => {
  const stableSystemPrefix = "STANDING RULES workspace-7f3a conversation-91bd";
  const boundaryRequest = (dynamicSystemSuffix: string, prompt: string, format = responseFormat) => ({
    prompt,
    systemPrompt: `${stableSystemPrefix}${dynamicSystemSuffix}`,
    reusableInputBoundary: { stableSystemPrefix, dynamicSystemSuffix },
    responseFormat: format,
  });
  const sentRequest = (call = 0): Record<string, unknown> =>
    createMock.mock.calls[call]?.[0] as Record<string, unknown>;
  const completeWith = async (config: LlmCapabilityConfig, request: Parameters<OpenAITextGenerationClient["complete"]>[0]) => {
    createMock.mockResolvedValueOnce({ id: "resp-cache", choices: [{ message: { content: "ok" } }] });
    await new OpenAITextGenerationClient(config).complete(request);
  };

  it("sends a content-derived prompt_cache_key when a first-party request declares a reusable prefix", async () => {
    await completeWith(chatConfig, boundaryRequest("\n\nTurn steering", "Hi"));

    expect(sentRequest().prompt_cache_key).toMatch(/^rpc1_[0-9a-f]{32}$/);
  });

  it("sends the same key on streaming requests", async () => {
    await completeWith(chatConfig, boundaryRequest("", "Hi"));
    createMock.mockResolvedValueOnce(asyncIterableOf([]));
    const { textStream } = new OpenAITextGenerationClient(chatConfig).stream(boundaryRequest("", "Hi"));
    for await (const _chunk of textStream) {
      // drain
    }

    expect(sentRequest(1)).toMatchObject({ stream: true, prompt_cache_key: sentRequest(0).prompt_cache_key });
  });

  it("derives one key per stable prefix and response schema, whatever the turn adds", async () => {
    await completeWith(chatConfig, boundaryRequest("\n\nSteering A", "First question"));
    await completeWith(chatConfig, boundaryRequest("\n\nSteering B", "Second question"));
    await completeWith(chatConfig, {
      ...boundaryRequest("", "Hi"),
      systemPrompt: "OTHER RULES",
      reusableInputBoundary: { stableSystemPrefix: "OTHER RULES", dynamicSystemSuffix: "" },
    });
    await completeWith(chatConfig, boundaryRequest("", "Hi", { ...responseFormat, name: "other_schema" }));

    const [first, second, otherPrefix, otherSchema] = [0, 1, 2, 3].map((call) => sentRequest(call).prompt_cache_key);
    expect(second).toBe(first);
    expect(otherPrefix).not.toBe(first);
    expect(otherSchema).not.toBe(first);
  });

  // The #1282 follow-up: on a real agent, the turn planner's embedding prefilter
  // returns a different routine-candidate subset, in a different score order, as
  // the conversation moves — this is the actual turn-to-turn shape the planner
  // sends, built through the production prompt/schema builders, not a synthetic
  // boundary. Two such turns must still land on the provider's same cache.
  it("gives the turn planner the same prompt_cache_key across turns with different routine candidate subsets", async () => {
    const turnOnePrompt = buildTurnPlanningPrompt({
      query: "I'd like to book a call about pricing.",
      history: [],
      routineCandidates: [
        { routineId: "book-call", title: "Book a call", triggerSummary: "wants a call", priority: 0 },
        { routineId: "cancel-order", title: "Cancel an order", triggerSummary: "wants to cancel", priority: 0 },
      ],
      directiveCandidates: [],
    });
    const turnOneFormat = buildTurnPlanResponseFormat({
      routineIds: ["book-call", "cancel-order"],
      directiveNames: [],
    });
    const turnTwoPrompt = buildTurnPlanningPrompt({
      query: "Actually, never mind — what's your refund policy?",
      history: [{ role: "user", content: "I'd like to book a call about pricing." } as never],
      routineCandidates: [
        { routineId: "refund-policy", title: "Refund policy", triggerSummary: "asks about refunds", priority: 0 },
      ],
      directiveCandidates: [],
    });
    const turnTwoFormat = buildTurnPlanResponseFormat({ routineIds: ["refund-policy"], directiveNames: [] });

    await completeWith(chatConfig, {
      systemPrompt: turnOnePrompt.systemPrompt,
      reusableInputBoundary: turnOnePrompt.reusableInputBoundary,
      prompt: turnOnePrompt.prompt,
      responseFormat: turnOneFormat,
    });
    await completeWith(chatConfig, {
      systemPrompt: turnTwoPrompt.systemPrompt,
      reusableInputBoundary: turnTwoPrompt.reusableInputBoundary,
      prompt: turnTwoPrompt.prompt,
      responseFormat: turnTwoFormat,
    });

    expect(sentRequest(0).prompt_cache_key).toMatch(/^rpc1_[0-9a-f]{32}$/);
    expect(sentRequest(1).prompt_cache_key).toBe(sentRequest(0).prompt_cache_key);
  });

  it("keeps request content and identifiers out of the key", async () => {
    await completeWith(chatConfig, boundaryRequest("\n\nTurn steering", "Hi"));

    const key = String(sentRequest().prompt_cache_key);
    for (const fragment of ["STANDING", "workspace-7f3a", "conversation-91bd", "answer_envelope", "steering"]) {
      expect(key).not.toContain(fragment);
    }
  });

  it("never sends the key to OpenAI-compatible endpoints", async () => {
    await completeWith(compatibleChatConfig, boundaryRequest("", "Hi"));

    expect(sentRequest()).not.toHaveProperty("prompt_cache_key");
  });

  it("omits the key when the request declares no reusable prefix or a mismatched one", async () => {
    await completeWith(chatConfig, { prompt: "Hi", systemPrompt: "RULES" });
    await completeWith(chatConfig, {
      prompt: "Hi",
      systemPrompt: "RULES plus something else",
      reusableInputBoundary: { stableSystemPrefix: "RULES", dynamicSystemSuffix: "" },
    });

    expect(sentRequest(0)).not.toHaveProperty("prompt_cache_key");
    expect(sentRequest(1)).not.toHaveProperty("prompt_cache_key");
  });

  it("keeps the key out of usage events, the turn trace, and metrics", async () => {
    createMock.mockResolvedValueOnce({
      id: "resp-observed",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 2000, completion_tokens: 5, total_tokens: 2005, prompt_tokens_details: { cached_tokens: 1920 } },
    });
    const events: unknown[] = [];
    const metrics = new MetricsRegistry();
    const pipeline = new ModelInferencePipelineService(
      new OpenAITextGenerationClient(chatConfig),
      { async recordEmbedding() {}, async recordModelCall(event) { events.push(event); } },
      metrics,
    );

    const { calls } = await captureModelCallTrace(() => pipeline.complete({
      ...boundaryRequest("", "Hi"),
      operation: {
        workspaceId: "workspace-7f3a",
        conversationId: "conversation-91bd",
        surface: "assistant",
        operation: "answer",
        attemptKey: "attempt-1",
      },
    }));

    const key = String(sentRequest().prompt_cache_key);
    expect(key).toMatch(/^rpc1_/);
    expect(calls[0]).toMatchObject({ cacheAccounting: { state: "reported", readInputTokens: 1920 } });
    for (const observed of [JSON.stringify(events), JSON.stringify(calls), metrics.renderPrometheus()]) {
      expect(observed).not.toContain(key);
    }
  });

  it("declares implicit cache capability only for first-party OpenAI", () => {
    expect(new OpenAITextGenerationClient(chatConfig).metadata.cacheCapability).toBe("implicit");
    expect(new OpenAITextGenerationClient(compatibleChatConfig).metadata.cacheCapability).toBe("unsupported");
  });

  it("keeps implicit cache capability and prompt-cache routing for an eu or us data-residency endpoint", async () => {
    expect(new OpenAITextGenerationClient(euResidencyChatConfig).metadata.cacheCapability).toBe("implicit");
    expect(new OpenAITextGenerationClient(usResidencyChatConfig).metadata.cacheCapability).toBe("implicit");

    await completeWith(euResidencyChatConfig, boundaryRequest("\n\nTurn steering", "Hi"));
    expect(sentRequest().prompt_cache_key).toMatch(/^rpc1_[0-9a-f]{32}$/);

    await completeWith(usResidencyChatConfig, boundaryRequest("\n\nTurn steering", "Hi"));
    expect(sentRequest().prompt_cache_key).toMatch(/^rpc1_[0-9a-f]{32}$/);
  });

  it("still withholds prompt-cache routing for openai-compatible with a custom URL", async () => {
    expect(new OpenAITextGenerationClient(compatibleChatConfig).metadata.cacheCapability).toBe("unsupported");

    await completeWith(compatibleChatConfig, boundaryRequest("\n\nTurn steering", "Hi"));
    expect(sentRequest()).not.toHaveProperty("prompt_cache_key");
  });
});

describe("OpenAIEmbeddingClient.embedTexts", () => {
  it("returns vectors plus provider-reported usage", async () => {
    embeddingsCreateMock.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });

    const result = await new OpenAIEmbeddingClient(embeddingConfig).embedTexts(["a", "b"]);

    expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(result.usage).toMatchObject({ inputTokens: 8, totalTokens: 8, quality: "actual" });
  });
});
