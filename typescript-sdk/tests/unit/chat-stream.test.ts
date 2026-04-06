import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient } from "../../src/index.js";

const encoder = new TextEncoder();

const streamFromText = (value: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });

describe("chat stream", () => {
  it("parses ordered stream events", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        streamFromText(
          [
            'event: conversation\ndata: {"conversationId":"c1"}\n\n',
            'event: chunk\ndata: {"text":"hello"}\n\n',
            'event: done\ndata: {"conversationId":"c1","answer":"hello","retrievalInfo":{},"retrievalTrace":{}}\n\n',
          ].join(""),
        ),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );

    const client = createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "token-123",
      fetch: fetchMock as typeof fetch,
    });

    const events = [];
    for await (const event of client.chat.stream({ query: "hi", conversationId: undefined })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "conversation", conversationId: "c1" },
      { type: "chunk", text: "hello" },
      { type: "done", conversationId: "c1", answer: "hello", retrievalInfo: {}, retrievalTrace: {} },
    ]);
  });

  it("emits an explicit error event when the request fails", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "No token",
        },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "token-123",
      fetch: fetchMock as typeof fetch,
    });

    const events = [];
    for await (const event of client.chat.stream({ query: "hi", conversationId: undefined })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "error",
        error: expect.objectContaining({
          code: "UNAUTHORIZED",
        }),
      },
    ]);
  });
});
