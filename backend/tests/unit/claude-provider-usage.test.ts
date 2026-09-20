import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeTextGenerationClient } from "../../src/shared/infra/llm/claudeProvider.js";
import type {
  LlmCapabilityConfig,
  ProviderDispatchRecord,
} from "../../src/shared/infra/llm/providerTypes.js";

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

const errorResponse = (status: number, payload: unknown) =>
  ({ ok: false, status, async text() { return JSON.stringify(payload); } }) as unknown as Response;

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClaudeTextGenerationClient.complete", () => {
  it("records one logical call exactly once and only after the transport is invoked", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(dispatchRecord.dispatched).toBe(false);
      return jsonResponse({ content: [{ type: "text", text: "Hi" }] });
    });

    await new ClaudeTextGenerationClient(chatConfig).complete({
      prompt: "Hi",
      dispatchRecord,
    });

    expect(dispatchRecord.dispatched).toBe(true);
    expect(assignmentCount()).toBe(1);
  });

  it("does not record a call when the signal was already aborted", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(controller.signal.reason);

    await expect(new ClaudeTextGenerationClient(chatConfig).complete({
      prompt: "Hi",
      signal: controller.signal,
      dispatchRecord,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(dispatchRecord.dispatched).toBe(false);
    expect(assignmentCount()).toBe(0);
  });

  it("forces a schema-backed tool and returns its input as structured JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "tool_use", input: { answer: "Hi" } }] }),
    );

    const result = await new ClaudeTextGenerationClient(chatConfig).complete({ prompt: "Hi", responseFormat });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
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
      cacheAccounting: { state: "reported", readInputTokens: 4 },
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

  it("puts a supported model's exact stable prefix in a native checkpointed system block", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "Hi" }] }),
    );
    const client = new ClaudeTextGenerationClient({ ...chatConfig, model: "claude-sonnet-4-20250514" });

    await client.complete({
      prompt: "current question",
      systemPrompt: "stable instructions\ndynamic steering",
      reusableInputBoundary: { stableSystemPrefix: "stable instructions", dynamicSystemSuffix: "\ndynamic steering" },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      system: [
        { type: "text", text: "stable instructions", cache_control: { type: "ephemeral" } },
        { type: "text", text: "\ndynamic steering" },
      ],
    });
  });

  it("keeps an unsupported same-family model and invalid boundary as ordinary system text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "Hi" }] }),
    );
    const client = new ClaudeTextGenerationClient({ ...chatConfig, model: "claude-test" });

    await client.complete({
      prompt: "current question",
      systemPrompt: "ordinary",
      reusableInputBoundary: { stableSystemPrefix: "different", dynamicSystemSuffix: "ordinary" },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).system).toBe("ordinary");
  });

  it("normalizes cache reads and writes independently without inventing missing values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        content: [{ type: "text", text: "Hi" }],
        usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 3 },
      }),
    );

    const result = await new ClaudeTextGenerationClient(chatConfig).complete({ prompt: "Hi" });

    expect(result.usage?.cacheAccounting).toEqual({ state: "reported", readInputTokens: 0, writeInputTokens: 3 });
  });

  it("does not retry a fabricated cache-specific error code", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(400, { error: { type: "cache_control_invalid" } }));
    const client = new ClaudeTextGenerationClient({ ...chatConfig, model: "claude-sonnet-4-20250514" });

    await expect(client.complete({
      prompt: "current question",
      systemPrompt: "stable",
      reusableInputBoundary: { stableSystemPrefix: "stable", dynamicSystemSuffix: "" },
    })).rejects.toMatchObject({ status: 400 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unclassified provider failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(400, { error: { type: "invalid_request_error" } }));
    const client = new ClaudeTextGenerationClient({ ...chatConfig, model: "claude-sonnet-4-20250514" });

    await expect(client.complete({
      prompt: "current question",
      systemPrompt: "stable",
      reusableInputBoundary: { stableSystemPrefix: "stable", dynamicSystemSuffix: "" },
    })).rejects.toMatchObject({ status: 400 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeTextGenerationClient.stream", () => {
  it("does not retry a generic validation rejection before streamed text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(400, { error: { type: "invalid_request_error" } }));
    const client = new ClaudeTextGenerationClient({ ...chatConfig, model: "claude-sonnet-4-20250514" });

    const { textStream } = client.stream({
      prompt: "current question",
      systemPrompt: "stable",
      reusableInputBoundary: { stableSystemPrefix: "stable", dynamicSystemSuffix: "" },
    });
    await expect(async () => {
      for await (const _chunk of textStream) {
        // drain
      }
    }).rejects.toMatchObject({ status: 400 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records a streamed request only after the transport has been invoked", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(dispatchRecord.dispatched).toBe(false);
      return sseResponse([]);
    });

    const { textStream } = new ClaudeTextGenerationClient(chatConfig).stream({
      prompt: "Hi",
      dispatchRecord,
    });
    for await (const _chunk of textStream) {
      // drain
    }

    expect(dispatchRecord.dispatched).toBe(true);
    expect(assignmentCount()).toBe(1);
  });

  it("does not record a streamed call when the signal was already aborted", async () => {
    const { dispatchRecord, assignmentCount } = recordingDispatchRecord();
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(controller.signal.reason);

    const { textStream } = new ClaudeTextGenerationClient(chatConfig).stream({
      prompt: "Hi",
      signal: controller.signal,
      dispatchRecord,
    });
    await expect(async () => {
      for await (const _chunk of textStream) {
        // drain
      }
    }).rejects.toMatchObject({ name: "AbortError" });

    expect(dispatchRecord.dispatched).toBe(false);
    expect(assignmentCount()).toBe(0);
  });

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
      cacheAccounting: { state: "reported", readInputTokens: 2 },
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
