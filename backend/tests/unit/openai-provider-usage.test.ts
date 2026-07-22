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
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";

const chatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai",
  model: "gpt-test",
  apiKey: "sk-test",
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
      reasoningTokens: 2,
      providerRequestId: "resp-1",
      quality: "actual",
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
      // eslint-disable-next-line require-yield
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
