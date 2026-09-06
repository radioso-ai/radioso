import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
    embeddings = { create: vi.fn() };

    withOptions(options: { fetch?: typeof fetch }) {
      return {
        chat: {
          completions: {
            create: async (...args: unknown[]) => {
              const requestOptions = args[1] as { signal?: AbortSignal } | undefined;
              if (requestOptions?.signal?.aborted) {
                throw requestOptions.signal.reason;
              }
              const request = args[0] as { model?: string };
              const transportAttempts = request.model?.includes("sdk-retry") ? 2 : 1;
              for (let attempt = 0; attempt < transportAttempts; attempt += 1) {
                await options.fetch?.("https://api.openai.test/v1/chat/completions", {
                  signal: requestOptions?.signal,
                });
              }
              return createMock(...args);
            },
          },
        },
      };
    }
  },
}));

import {
  buildChatSamplingParams,
  createChatCompletionWithSamplingFallback,
  OpenAITextGenerationClient,
  type ChatSamplingParams,
} from "../../src/shared/infra/llm/openaiProvider.js";
import type {
  LlmCapabilityConfig,
  ProviderDispatchRecord,
} from "../../src/shared/infra/llm/providerTypes.js";

// The learned-support caches are module-global by design (they outlive a single
// client), so every case uses a model id of its own to stay independent. None of
// them look like a gpt-5 id, so reasoning-effort normalization is a passthrough.
const chatConfig = (model: string): LlmCapabilityConfig => ({
  capability: "chat",
  provider: "openai",
  model,
  apiKey: "sk-test",
});

const compatibleChatConfig = (model: string, baseUrl: string): LlmCapabilityConfig => ({
  capability: "chat",
  provider: "openai-compatible",
  model,
  apiKey: "sk-test",
  baseUrl,
});

const openAIError = (fields: {
  message: string;
  code?: string;
  param?: string;
  status?: number;
}): Error =>
  Object.assign(new Error(fields.message), {
    status: fields.status ?? 400,
    type: "invalid_request_error",
    code: fields.code,
    param: fields.param,
  });

const unsupportedTemperatureError = (): Error =>
  openAIError({
    code: "unsupported_value",
    param: "temperature",
    message:
      "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
  });

const unsupportedReasoningEffortError = (): Error =>
  openAIError({
    code: "unsupported_value",
    param: "reasoning_effort",
    message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.",
  });

const completion = (content: string) => ({
  id: "resp-test",
  choices: [{ message: { content } }],
});

const asyncIterableOf = <T>(items: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

const drain = async (stream: AsyncIterable<string>): Promise<string[]> => {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

const recordingDispatchRecord = () => {
  let dispatched = false;
  let assignmentCount = 0;
  const dispatchRecord: ProviderDispatchRecord = {
    get dispatched() {
      return dispatched;
    },
    set dispatched(value: boolean) {
      assignmentCount += 1;
      dispatched = value;
    },
  };
  return { dispatchRecord, assignmentCount: () => assignmentCount };
};

beforeEach(() => {
  createMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildChatSamplingParams", () => {
  it("sends temperature and a completion-token cap by default", () => {
    expect(buildChatSamplingParams("openai", { temperature: 0, maxOutputTokens: 80 })).toEqual({
      temperature: 0,
      max_completion_tokens: 80,
    });
  });

  it("forwards reasoning_effort and drops temperature for openai reasoning calls", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "minimal",
    });

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "minimal" });
    expect(params).not.toHaveProperty("temperature");
  });

  it("does not send reasoning_effort to openai-compatible endpoints", () => {
    const params = buildChatSamplingParams("openai-compatible", {
      temperature: 0.2,
      maxOutputTokens: 100,
      reasoningEffort: "minimal",
    });

    expect(params).toEqual({ temperature: 0.2, max_tokens: 100 });
  });

  it("normalizes none to minimal for pre-5.4 gpt-5 models", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "none",
    }, "gpt-5-nano");

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "minimal" });
  });

  it("normalizes minimal to none for gpt-5.4 models", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "minimal",
    }, "gpt-5.4-mini");

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "none" });
  });

  it("normalizes minimal to none for gpt-5.6-luna", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "minimal",
    }, "gpt-5.6-luna");

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "none" });
  });
});

describe("createChatCompletionWithSamplingFallback", () => {
  const rejectsBothModel = "fallback-rejects-both";

  it("converges when the model rejects both reasoning_effort and temperature", async () => {
    const create = vi.fn(async (sampling: ChatSamplingParams) => {
      if (sampling.reasoning_effort !== undefined) {
        throw unsupportedReasoningEffortError();
      }
      if (sampling.temperature !== undefined) {
        throw unsupportedTemperatureError();
      }
      return "generated";
    });

    await expect(
      createChatCompletionWithSamplingFallback(
        rejectsBothModel,
        { temperature: 0, reasoning_effort: "minimal", max_completion_tokens: 32 },
        create,
      ),
    ).resolves.toBe("generated");

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2]?.[0]).toEqual({ max_completion_tokens: 32 });
  });

  it("pre-strips both remembered params on a later call to the same model", async () => {
    const create = vi.fn(async (_sampling: ChatSamplingParams) => "generated");

    await createChatCompletionWithSamplingFallback(
      rejectsBothModel,
      { temperature: 0, reasoning_effort: "minimal", max_completion_tokens: 32 },
      create,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({ max_completion_tokens: 32 });
  });

  it("rethrows a sampling rejection when the rejected param was not sent", async () => {
    const create = vi.fn(async () => {
      throw unsupportedTemperatureError();
    });

    await expect(
      createChatCompletionWithSamplingFallback(
        "fallback-nothing-strippable",
        { max_completion_tokens: 32 },
        create,
      ),
    ).rejects.toThrow("Unsupported value: 'temperature'");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAITextGenerationClient.complete sampling reconciliation", () => {
  it("records one completed call across SDK transport retries", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const dispatchedBeforeTransportReturns: boolean[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      dispatchedBeforeTransportReturns.push(dispatchRecord.dispatched);
      return new Response();
    });
    createMock.mockResolvedValueOnce(completion("Hello"));

    await new OpenAITextGenerationClient(chatConfig("complete-sdk-retry")).complete({
      prompt: "Hi",
      dispatchRecord,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(dispatchedBeforeTransportReturns).toEqual([false, true]);
    expect(dispatchRecord.dispatched).toBe(true);
    expect(assignmentCount()).toBe(1);
  });

  it("records one logical call after transport invocation when provider dispatch retries", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const dispatchedBeforeTransportReturns: boolean[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      dispatchedBeforeTransportReturns.push(dispatchRecord.dispatched);
      return new Response();
    });
    createMock
      .mockRejectedValueOnce(unsupportedTemperatureError())
      .mockResolvedValueOnce(completion("Hello"));

    await new OpenAITextGenerationClient(chatConfig("complete-dispatch-retry")).complete({
      prompt: "Hi",
      temperature: 0,
      dispatchRecord,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(dispatchedBeforeTransportReturns).toEqual([false, true]);
    expect(dispatchRecord.dispatched).toBe(true);
    expect(assignmentCount()).toBe(1);
  });

  it("does not record a call when cancellation stops SDK preparation before transport dispatch", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const controller = new AbortController();
    controller.abort();

    await expect(new OpenAITextGenerationClient(chatConfig("complete-pre-dispatch-abort")).complete({
      prompt: "Hi",
      signal: controller.signal,
      dispatchRecord,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(dispatchRecord.dispatched).toBe(false);
    expect(assignmentCount()).toBe(0);
  });

  it("retries without temperature when the model rejects the requested value", async () => {
    createMock
      .mockRejectedValueOnce(unsupportedTemperatureError())
      .mockResolvedValueOnce(completion("Hello"));

    const result = await new OpenAITextGenerationClient(
      chatConfig("complete-temp-reject"),
    ).complete({ prompt: "Hi", temperature: 0, maxOutputTokens: 64 });

    expect(result.text).toBe("Hello");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ temperature: 0 });
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty("temperature");
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({ max_completion_tokens: 64 });
  });

  it("omits temperature on the first attempt of every later call to that model", async () => {
    createMock
      .mockRejectedValueOnce(unsupportedTemperatureError())
      .mockResolvedValue(completion("Hello"));
    const client = new OpenAITextGenerationClient(chatConfig("complete-temp-remembered"));

    await client.complete({ prompt: "Hi", temperature: 0 });
    expect(createMock).toHaveBeenCalledTimes(2);

    // A different temperature value: these models accept only their own default,
    // so the rejection is remembered per model rather than per (model, value).
    await client.complete({ prompt: "Again", temperature: 0.7 });

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls[2]?.[0]).not.toHaveProperty("temperature");
  });

  it("keeps learned sampling support isolated between compatible endpoints with the same model id", async () => {
    createMock
      .mockRejectedValueOnce(unsupportedTemperatureError())
      .mockResolvedValueOnce(completion("Fallback endpoint"))
      .mockResolvedValueOnce(completion("Temperature endpoint"));
    const model = "shared-compatible-model";

    await new OpenAITextGenerationClient(
      compatibleChatConfig(model, "https://fallback.example/v1"),
    ).complete({ prompt: "Hi", temperature: 0 });
    await new OpenAITextGenerationClient(
      compatibleChatConfig(model, "https://temperature.example/v1"),
    ).complete({ prompt: "Again", temperature: 0.7 });

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty("temperature");
    expect(createMock.mock.calls[2]?.[0]).toMatchObject({
      model,
      temperature: 0.7,
    });
  });

  it("rethrows an unrelated server error without retrying", async () => {
    createMock.mockRejectedValue(
      openAIError({ message: "server had a problem", status: 500, code: "server_error" }),
    );

    await expect(
      new OpenAITextGenerationClient(chatConfig("complete-unrelated-500")).complete({
        prompt: "Hi",
        temperature: 0,
      }),
    ).rejects.toThrow("server had a problem");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows a 400 about a different parameter without retrying", async () => {
    createMock.mockRejectedValue(
      openAIError({
        message: "Invalid value for 'max_completion_tokens'",
        code: "invalid_value",
        param: "max_completion_tokens",
      }),
    );

    await expect(
      new OpenAITextGenerationClient(chatConfig("complete-unrelated-400")).complete({
        prompt: "Hi",
        temperature: 0,
      }),
    ).rejects.toThrow("Invalid value for 'max_completion_tokens'");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("retries without reasoning_effort when the model rejects the value", async () => {
    createMock
      .mockRejectedValueOnce(unsupportedReasoningEffortError())
      .mockResolvedValueOnce(completion("Effort dropped"));

    const result = await new OpenAITextGenerationClient(
      chatConfig("complete-effort-reject"),
    ).complete({ prompt: "Hi", reasoningEffort: "minimal" });

    expect(result.text).toBe("Effort dropped");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: "minimal" });
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty("reasoning_effort");
  });

  it("still sends a different reasoning effort to a model that rejected another value", async () => {
    createMock
      .mockRejectedValueOnce(unsupportedReasoningEffortError())
      .mockResolvedValue(completion("ok"));
    const client = new OpenAITextGenerationClient(chatConfig("complete-effort-per-value"));

    await client.complete({ prompt: "Hi", reasoningEffort: "minimal" });
    await client.complete({ prompt: "Hi", reasoningEffort: "low" });

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls[2]?.[0]).toMatchObject({ reasoning_effort: "low" });
  });
});

describe("OpenAITextGenerationClient.stream sampling reconciliation", () => {
  it("records one streamed call across SDK transport retries", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const dispatchedBeforeTransportReturns: boolean[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      dispatchedBeforeTransportReturns.push(dispatchRecord.dispatched);
      return new Response();
    });
    createMock.mockResolvedValueOnce(
      asyncIterableOf([{ id: "s-sdk", choices: [{ delta: { content: "Hi" } }] }]),
    );

    const { textStream } = new OpenAITextGenerationClient(
      chatConfig("stream-sdk-retry"),
    ).stream({ prompt: "Hi", dispatchRecord });

    expect(await drain(textStream)).toEqual(["Hi"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(dispatchedBeforeTransportReturns).toEqual([false, true]);
    expect(dispatchRecord.dispatched).toBe(true);
    expect(assignmentCount()).toBe(1);
  });

  it("records one streamed call after transport invocation when provider dispatch retries", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const dispatchedBeforeTransportReturns: boolean[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      dispatchedBeforeTransportReturns.push(dispatchRecord.dispatched);
      return new Response();
    });
    createMock
      .mockRejectedValueOnce(unsupportedTemperatureError())
      .mockResolvedValueOnce(
        asyncIterableOf([{ id: "s-1", choices: [{ delta: { content: "Hi there" } }] }]),
      );

    const { textStream, usage } = new OpenAITextGenerationClient(
      chatConfig("stream-temp-reject"),
    ).stream({ prompt: "Hi", temperature: 0, dispatchRecord });

    expect(await drain(textStream)).toEqual(["Hi there"]);
    await expect(usage).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ temperature: 0, stream: true });
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty("temperature");
    expect(dispatchedBeforeTransportReturns).toEqual([false, true]);
    expect(dispatchRecord.dispatched).toBe(true);
    expect(assignmentCount()).toBe(1);
  });

  it("does not record a streamed call when cancellation stops SDK preparation before dispatch", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const controller = new AbortController();
    controller.abort();

    const { textStream, usage } = new OpenAITextGenerationClient(
      chatConfig("stream-pre-dispatch-abort"),
    ).stream({ prompt: "Hi", signal: controller.signal, dispatchRecord });

    await expect(drain(textStream)).rejects.toMatchObject({ name: "AbortError" });
    await expect(usage).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(dispatchRecord.dispatched).toBe(false);
    expect(assignmentCount()).toBe(0);
  });

  it("rethrows an unrelated stream error without retrying", async () => {
    createMock.mockRejectedValue(openAIError({ message: "stream refused", status: 500 }));

    const { textStream, usage } = new OpenAITextGenerationClient(
      chatConfig("stream-unrelated-500"),
    ).stream({ prompt: "Hi", temperature: 0 });

    await expect(drain(textStream)).rejects.toThrow("stream refused");
    await expect(usage).resolves.toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
