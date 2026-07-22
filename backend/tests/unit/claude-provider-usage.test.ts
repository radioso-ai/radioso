import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeTextGenerationClient } from "../../src/shared/infra/llm/claudeProvider.js";
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";

const chatConfig: LlmCapabilityConfig = {
  capability: "chat",
  provider: "claude",
  model: "claude-test",
  apiKey: "sk-ant-test",
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

describe("ClaudeTextGenerationClient.complete", () => {
  it("forces a schema-backed tool and returns its input as structured JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "tool_use", input: { answer: "Hi" } }] }),
    );

    const result = await new ClaudeTextGenerationClient(chatConfig).complete({ prompt: "Hi", responseFormat });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      tools: [{ name: "answer_envelope", input_schema: responseFormat.schema }],
      tool_choice: { type: "tool", name: "answer_envelope" },
    });
    expect(result.text).toBe('{"answer":"Hi"}');
  });

  it("passes AbortSignal to fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "Hi" }] }),
    );
    const controller = new AbortController();

    await new ClaudeTextGenerationClient(chatConfig).complete({ prompt: "Hi", signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  it("returns text plus message usage as actual usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: "msg-1",
        content: [{ type: "text", text: "Hello" }],
        usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 4 },
      }),
    );

    const result = await new ClaudeTextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.text).toBe("Hello");
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 6,
      totalTokens: 26,
      cachedInputTokens: 4,
      providerRequestId: "msg-1",
      quality: "actual",
    });
  });

  it("omits usage when the provider returns none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ id: "msg-2", content: [{ type: "text", text: "Hello" }] }),
    );

    const result = await new ClaudeTextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.usage).toBeUndefined();
  });
});

describe("ClaudeTextGenerationClient.stream", () => {
  it("streams schema-backed tool input JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Preamble" } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"answer":"' } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: 'Hi"}' } }),
      ]),
    );

    const { textStream } = new ClaudeTextGenerationClient(chatConfig).stream({ prompt: "Hi", responseFormat });
    const chunks: string[] = [];
    for await (const chunk of textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['{"answer":"', 'Hi"}']);
  });

  it("passes AbortSignal to streaming fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([]));
    const controller = new AbortController();

    const { textStream } = new ClaudeTextGenerationClient(chatConfig).stream({
      prompt: "Hi",
      signal: controller.signal,
    });
    for await (const _chunk of textStream) {
      // drain
    }

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  it("assembles usage from message_start (input) and message_delta (output)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        JSON.stringify({ type: "message_start", message: { id: "msg-3", usage: { input_tokens: 15, cache_read_input_tokens: 2 } } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }),
        JSON.stringify({ type: "message_delta", usage: { output_tokens: 8 } }),
      ]),
    );

    const { textStream, usage } = new ClaudeTextGenerationClient(chatConfig).stream({ prompt: "Hi" });

    const chunks: string[] = [];
    for await (const chunk of textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(await usage).toEqual({
      inputTokens: 15,
      outputTokens: 8,
      totalTokens: 23,
      cachedInputTokens: 2,
      providerRequestId: "msg-3",
      quality: "actual",
    });
  });

  it("resolves usage to undefined when no usage events arrive", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }),
      ]),
    );

    const { textStream, usage } = new ClaudeTextGenerationClient(chatConfig).stream({ prompt: "Hi" });

    for await (const _chunk of textStream) {
      // drain
    }

    expect(await usage).toBeUndefined();
  });
});
