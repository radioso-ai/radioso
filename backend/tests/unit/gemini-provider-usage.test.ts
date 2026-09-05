import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiEmbeddingClient, GeminiTextGenerationClient } from "../../src/shared/infra/llm/geminiProvider.js";
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";

const chatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "gemini",
  model: "gemini-test",
  apiKey: "key-test",
};

const embeddingConfig: LlmCapabilityConfig = {
  capability: "embeddings",
  provider: "gemini",
  model: "text-embedding-004",
  apiKey: "key-test",
};

const responseFormat = {
  type: "json_schema" as const,
  name: "answer_envelope",
  strict: true,
  schema: {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
};

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GeminiTextGenerationClient.complete", () => {
  it("forwards JSON schema output through generationConfig", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{"answer":"Hi"}' }] } }] }),
    );

    await new GeminiTextGenerationClient(chatConfig).complete({ prompt: "Hi", responseFormat });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: responseFormat.schema,
      },
    });
  });

  it("passes AbortSignal to fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }),
    );
    const controller = new AbortController();

    await new GeminiTextGenerationClient(chatConfig).complete({ prompt: "Hi", signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  it("returns text plus usageMetadata as actual usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Bonjour" }] } }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 4,
          totalTokenCount: 16,
          cachedContentTokenCount: 1,
        },
      }),
    );

    const result = await new GeminiTextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.text).toBe("Bonjour");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      cachedInputTokens: 1,
      quality: "actual",
    });
  });

  it("omits usage when usageMetadata is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }),
    );

    const result = await new GeminiTextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.usage).toBeUndefined();
  });
});

describe("GeminiTextGenerationClient.stream", () => {
  it("passes AbortSignal to streaming fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([]));
    const controller = new AbortController();

    const { textStream } = new GeminiTextGenerationClient(chatConfig).stream({
      prompt: "Hi",
      signal: controller.signal,
    });
    for await (const _chunk of textStream) {
      // drain
    }

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  it("yields text and resolves usage from the final cumulative chunk", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "Bon" }] } }] }),
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "jour" }] } }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
        }),
      ]),
    );

    const { textStream, usage } = new GeminiTextGenerationClient(chatConfig).stream({ prompt: "Hi" });

    const chunks: string[] = [];
    for await (const chunk of textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Bon", "jour"]);
    expect(await usage).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12, quality: "actual" });
  });
});

describe("GeminiEmbeddingClient.embedTexts", () => {
  it("returns vectors and aggregates token usage across calls when present", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ embedding: { values: [0.1] }, usageMetadata: { promptTokenCount: 4 } }))
      .mockResolvedValueOnce(jsonResponse({ embedding: { values: [0.2] }, usageMetadata: { promptTokenCount: 6 } }));

    const result = await new GeminiEmbeddingClient(embeddingConfig).embedTexts(["a", "b"]);

    expect(result.vectors).toEqual([[0.1], [0.2]]);
    expect(result.usage).toMatchObject({ inputTokens: 10, totalTokens: 10, quality: "actual" });
  });

  it("omits usage when the provider returns no token counts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ embedding: { values: [0.5] } }));

    const result = await new GeminiEmbeddingClient(embeddingConfig).embedTexts(["a"]);

    expect(result.vectors).toEqual([[0.5]]);
    expect(result.usage).toBeUndefined();
  });
});
