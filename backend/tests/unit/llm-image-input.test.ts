import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { ClaudeTextGenerationClient } from "../../src/shared/infra/llm/claudeProvider.js";
import { GeminiTextGenerationClient } from "../../src/shared/infra/llm/geminiProvider.js";
import { knownModelsByProvider } from "../../src/shared/infra/llm/knownModels.js";
import {
  estimateTextGenerationInputTokens,
  ModelInferencePipelineService,
} from "../../src/shared/infra/llm/modelInferencePipeline.js";
import { OpenAITextGenerationClient } from "../../src/shared/infra/llm/openaiProvider.js";
import type {
  LlmCapabilityConfig,
  LlmProviderMetadata,
  TextGenerationClient,
  TextGenerationImage,
  TextGenerationRequest,
} from "../../src/shared/infra/llm/providerTypes.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import { captureModelCallTrace } from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import { initializeTracing, shutdownTracing } from "../../src/shared/observability/tracing/index.js";
import { streamResult, textResult } from "../support/llmStubs.js";

const openAIConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai",
  model: "gpt-5.4-mini",
  apiKey: "sk-test",
  openAIDataResidency: "global",
};

const compatibleConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "openai-compatible",
  model: "local-model",
  apiKey: "sk-test",
  baseUrl: "http://localhost:1234/v1",
};

const claudeConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "claude",
  model: "claude-sonnet-5",
  apiKey: "sk-ant-test",
};

const geminiConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "gemini",
  model: "gemini-3.5-flash",
  apiKey: "key-test",
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

const images: TextGenerationImage[] = [
  { mediaType: "image/jpeg", base64Data: "SkpFRy1ERU1P" },
  { mediaType: "image/png", base64Data: "UE5HLURFTU8=" },
];

const asyncIterableOf = <T>(items: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

const jsonResponse = (payload: unknown) =>
  ({ ok: true, async json() { return payload; } }) as unknown as Response;

const sseResponse = (events: string[]) => {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        }
        controller.close();
      },
    }),
  } as unknown as Response;
};

const drain = async (textStream: AsyncIterable<string>): Promise<void> => {
  for await (const _chunk of textStream) {
    // drain
  }
};

const sentBody = (fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> =>
  JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;

beforeEach(() => {
  createMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAI chat completions with images", () => {
  const imageParts = [
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,SkpFRy1ERU1P", detail: "auto" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,UE5HLURFTU8=", detail: "auto" } },
  ];

  it("attaches the images after the prompt text in the user turn when completing", async () => {
    createMock.mockResolvedValue({ id: "r", choices: [{ message: { content: "ok" } }] });

    await new OpenAITextGenerationClient(openAIConfig).complete({
      prompt: "What is this?",
      systemPrompt: "Be brief.",
      images,
    });

    expect(createMock.mock.calls[0]?.[0].messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What is this?" }, ...imageParts] },
    ]);
  });

  it("attaches the images in the user turn when streaming", async () => {
    createMock.mockResolvedValue(asyncIterableOf([]));

    const { textStream } = new OpenAITextGenerationClient(openAIConfig).stream({ prompt: "What is this?", images });
    await drain(textStream);

    expect(createMock.mock.calls[0]?.[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "What is this?" }, ...imageParts] },
    ]);
  });

  it("keeps strict JSON schema output when images are attached", async () => {
    createMock.mockResolvedValue({ id: "r", choices: [{ message: { content: "{}" } }] });

    await new OpenAITextGenerationClient(openAIConfig).complete({ prompt: "Hi", images, responseFormat });

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_schema", json_schema: { name: responseFormat.name } },
    });
  });

  it("sends the same string-content request as before when no images are given", async () => {
    createMock.mockResolvedValue({ id: "r", choices: [{ message: { content: "ok" } }] });
    const client = new OpenAITextGenerationClient(openAIConfig);

    await client.complete({ prompt: "Hi", systemPrompt: "Be brief." });
    await client.complete({ prompt: "Hi", systemPrompt: "Be brief.", images: [] });

    const expected = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ];
    expect(createMock.mock.calls[0]?.[0].messages).toEqual(expected);
    expect(createMock.mock.calls[1]?.[0].messages).toEqual(expected);
  });
});

describe("Claude Messages with images", () => {
  const imageBlocks = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "SkpFRy1ERU1P" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "UE5HLURFTU8=" } },
  ];

  it("places the images before the prompt text when completing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );

    await new ClaudeTextGenerationClient(claudeConfig).complete({ prompt: "What is this?", images });

    expect(sentBody(fetchMock).messages).toEqual([
      { role: "user", content: [...imageBlocks, { type: "text", text: "What is this?" }] },
    ]);
  });

  it("places the images before the prompt text when streaming", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([]));

    const { textStream } = new ClaudeTextGenerationClient(claudeConfig).stream({ prompt: "What is this?", images });
    await drain(textStream);

    expect(sentBody(fetchMock).messages).toEqual([
      { role: "user", content: [...imageBlocks, { type: "text", text: "What is this?" }] },
    ]);
  });

  it("keeps the forced schema tool and the cached system prefix when images are attached", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "tool_use", input: { answer: "ok" } }] }),
    );

    await new ClaudeTextGenerationClient(claudeConfig).complete({
      prompt: "Hi",
      images,
      responseFormat,
      systemPrompt: "StableDynamic",
      reusableInputBoundary: { stableSystemPrefix: "Stable", dynamicSystemSuffix: "Dynamic" },
    });

    expect(sentBody(fetchMock)).toMatchObject({
      tool_choice: { type: "tool", name: responseFormat.name },
      system: [
        { type: "text", text: "Stable", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Dynamic" },
      ],
    });
  });

  it("sends the same string-content request as before when no images are given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );
    const client = new ClaudeTextGenerationClient(claudeConfig);

    await client.complete({ prompt: "Hi" });
    await client.complete({ prompt: "Hi", images: [] });

    expect(sentBody(fetchMock).messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toBe(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
  });
});

describe("Gemini generateContent with images", () => {
  const imageParts = [
    { inlineData: { mimeType: "image/jpeg", data: "SkpFRy1ERU1P" } },
    { inlineData: { mimeType: "image/png", data: "UE5HLURFTU8=" } },
  ];

  it("places the images before the prompt text when completing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    );

    await new GeminiTextGenerationClient(geminiConfig).complete({ prompt: "What is this?", images });

    expect(sentBody(fetchMock).contents).toEqual([
      { role: "user", parts: [...imageParts, { text: "What is this?" }] },
    ]);
  });

  it("places the images before the prompt text when streaming", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([]));

    const { textStream } = new GeminiTextGenerationClient(geminiConfig).stream({ prompt: "What is this?", images });
    await drain(textStream);

    expect(sentBody(fetchMock).contents).toEqual([
      { role: "user", parts: [...imageParts, { text: "What is this?" }] },
    ]);
  });

  it("keeps structured output when images are attached", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
    );

    await new GeminiTextGenerationClient(geminiConfig).complete({ prompt: "Hi", images, responseFormat });

    expect(sentBody(fetchMock)).toMatchObject({
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: responseFormat.schema },
    });
  });

  it("sends the same text-only request as before when no images are given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    );
    const client = new GeminiTextGenerationClient(geminiConfig);

    await client.complete({ prompt: "Hi" });
    await client.complete({ prompt: "Hi", images: [] });

    expect(sentBody(fetchMock).contents).toEqual([{ role: "user", parts: [{ text: "Hi" }] }]);
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toBe(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
  });
});

describe("image input capability", () => {
  const catalogClients = (model: string): Record<"openai" | "gemini" | "claude", TextGenerationClient> => ({
    openai: new OpenAITextGenerationClient({ ...openAIConfig, model }),
    gemini: new GeminiTextGenerationClient({ ...geminiConfig, model }),
    claude: new ClaudeTextGenerationClient({ ...claudeConfig, model }),
  });

  it.each(["openai", "gemini", "claude"] as const)("is supported for every catalog model of %s", (provider) => {
    for (const model of knownModelsByProvider[provider]) {
      expect(catalogClients(model)[provider].metadata.imageInputCapability, `${provider}:${model}`).toBe("supported");
    }
  });

  it("is unsupported for an OpenAI-compatible endpoint, whose model is unknown", () => {
    expect(new OpenAITextGenerationClient(compatibleConfig).metadata.imageInputCapability).toBe("unsupported");
  });

  it("is unsupported for a model outside the closed catalog", () => {
    expect(new OpenAITextGenerationClient({ ...openAIConfig, model: "gpt-3.5-turbo" }).metadata.imageInputCapability)
      .toBe("unsupported");
  });
});

describe("ModelInferencePipelineService with images", () => {
  const operation = {
    workspaceId: "workspace-1",
    requestId: "request-1",
    surface: "assistant",
    operation: "answer",
    attemptKey: "attempt-1",
  } as const;

  const visionMetadata: LlmProviderMetadata = {
    capability: "chat",
    provider: "claude",
    model: "claude-sonnet-5",
    imageInputCapability: "supported",
  };

  const clientWith = (metadata: LlmProviderMetadata) => {
    const complete = vi.fn(async (_request: TextGenerationRequest) => textResult("Answer"));
    const stream = vi.fn((_request: TextGenerationRequest) => streamResult(["Answer"]));
    const client: TextGenerationClient = { metadata, complete, stream };
    return { client, complete, stream };
  };

  const recordingUsage = () => {
    const events: ModelUsageEvent[] = [];
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall(event) {
        events.push(event);
      },
    };
    return { recorder, events };
  };

  it("hands the images to the provider when completing", async () => {
    const { client, complete } = clientWith(visionMetadata);

    await new ModelInferencePipelineService(client).complete({ operation, prompt: "Hi", images });

    expect(complete.mock.calls[0]?.[0].images).toEqual(images);
  });

  it("hands the images to the provider when streaming", async () => {
    const { client, stream } = clientWith(visionMetadata);

    const result = new ModelInferencePipelineService(client).stream({ operation, prompt: "Hi", images });
    await drain(result.textStream);

    expect(stream.mock.calls[0]?.[0].images).toEqual(images);
  });

  it("forwards no images key when none, or an empty list, are given", async () => {
    const { client, complete } = clientWith(visionMetadata);
    const pipeline = new ModelInferencePipelineService(client);

    await pipeline.complete({ operation, prompt: "Hi" });
    await pipeline.complete({ operation, prompt: "Hi", images: [] });

    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("images");
    expect(complete.mock.calls[1]?.[0]).not.toHaveProperty("images");
  });

  it("refuses images for a model that cannot read them before calling the provider", async () => {
    const { client, complete } = clientWith({ capability: "chat", provider: "openai-compatible", model: "local-model" });

    await expect(
      new ModelInferencePipelineService(client).complete({ operation, prompt: "Hi", images }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "image_input_unsupported",
      details: { surface: "assistant", operation: "answer" },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses images for a streaming call before calling the provider", () => {
    const { client, stream } = clientWith({
      capability: "chat",
      provider: "openai",
      model: "gpt-3.5-turbo",
      imageInputCapability: "unsupported",
    });

    expect(() =>
      new ModelInferencePipelineService(client).stream({ operation, prompt: "Hi", images }),
    ).toThrowError(expect.objectContaining({ code: "image_input_unsupported" }));
    expect(stream).not.toHaveBeenCalled();
  });

  it("still serves text-only requests on a model that cannot read images", async () => {
    const { client, complete } = clientWith({ capability: "chat", provider: "openai-compatible", model: "local-model" });

    await expect(
      new ModelInferencePipelineService(client).complete({ operation, prompt: "Hi" }),
    ).resolves.toMatchObject({ text: "Answer" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("counts each image against the input budget, before the provider is called", async () => {
    const { client, complete } = clientWith(visionMetadata);
    const pipeline = new ModelInferencePipelineService(client);

    // "Hi" is one token; two images are well over a 3,000-token budget but a text-only call is not.
    await expect(pipeline.complete({ operation, prompt: "Hi", maxInputTokens: 3_000 })).resolves.toBeDefined();
    await expect(
      pipeline.complete({ operation, prompt: "Hi", images, maxInputTokens: 3_000 }),
    ).rejects.toMatchObject({ statusCode: 413, code: "payload_too_large" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("estimates input tokens as the text estimate plus a fixed amount per image", () => {
    const text = estimateTextGenerationInputTokens({ prompt: "Hi" });
    const withOne = estimateTextGenerationInputTokens({ prompt: "Hi", images: images.slice(0, 1) });
    const withTwo = estimateTextGenerationInputTokens({ prompt: "Hi", images });

    expect(withOne).toBeGreaterThan(text);
    expect(withTwo - withOne).toBe(withOne - text);
  });

  it("keeps image data out of exported spans and the turn's model-call trace", async () => {
    const spans: ReadableSpan[] = [];
    const spanExporter: SpanExporter = {
      export(batch, callback) {
        spans.push(...batch);
        callback({ code: 0 });
      },
      shutdown: async () => {},
    };
    initializeTracing({
      enabled: true,
      environment: "test",
      otlpEndpoint: "http://localhost:4318/v1/traces",
      runtimeRole: "api",
      serviceName: "radioso-api",
      spanExporter,
    });
    const { client } = clientWith(visionMetadata);

    try {
      const { calls } = await captureModelCallTrace(() =>
        new ModelInferencePipelineService(client).complete({ operation, prompt: "Hi", images }));

      expect(spans).toHaveLength(1);
      const exported = JSON.stringify([calls, spans.map((span) => ({ attributes: span.attributes, events: span.events }))]);
      for (const image of images) {
        expect(exported).not.toContain(image.base64Data);
      }
    } finally {
      await shutdownTracing();
    }
  });

  it("keeps image data out of the recorded usage event and the usage estimate's byte count", async () => {
    const { recorder, events } = recordingUsage();
    const { client } = clientWith(visionMetadata);

    await new ModelInferencePipelineService(client, recorder).complete({ operation, prompt: "Hi", images });

    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events);
    for (const image of images) {
      expect(serialized).not.toContain(image.base64Data);
    }
    expect(events[0]?.inputBytes).toBe(Buffer.byteLength("\nHi", "utf8"));
    // The provider reported no usage, so the estimate must not ignore the images.
    expect(events[0]?.inputTokens).toBeGreaterThan(estimateTextGenerationInputTokens({ prompt: "Hi" }));
  });
});
