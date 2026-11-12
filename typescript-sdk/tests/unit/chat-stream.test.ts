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
  it("declares reply blocks and parses a block event and the blocks on done", async () => {
    const block = {
      type: "item_list",
      id: "b1",
      layout: "carousel",
      selection: "none",
      caption: "Two hiking guides",
      items: [{
        key: "image-1",
        title: "Field Guide",
        image: { src: "https://app.example/backend/api/v1/public/reply-images/image-1/640", alt: "", width: 1280, height: 960 },
        actions: [{ type: "open", url: "https://shop.example/books/field-guide" }],
      }],
    };
    const fetchMock = vi.fn(async () =>
      new Response(
        streamFromText(
          [
            'event: chunk\ndata: {"text":"We carry two."}\n\n',
            `event: block\ndata: ${JSON.stringify({ conversationId: "c1", assistantMessageId: "m1", block })}\n\n`,
            `event: done\ndata: ${JSON.stringify({ conversationId: "c1", assistantMessageId: "m1", answer: "We carry two.", blocks: [block] })}\n\n`,
          ].join(""),
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const client = createRadiosoClient({ baseUrl: "https://api.example.com", apiToken: "token-123", fetch: fetchMock });

    const clientContextCapabilities = { "reply.blocks": { item_list: { layouts: ["carousel", "grid"] } } };
    const events = [];
    for await (const event of client.chat.stream({ message: "hi", conversationId: undefined, clientContextCapabilities })) {
      events.push(event);
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ message: "hi", stream: true, clientContextCapabilities });
    expect(events).toEqual([
      { type: "chunk", text: "We carry two." },
      { type: "block", conversationId: "c1", assistantMessageId: "m1", block },
      { type: "done", conversationId: "c1", assistantMessageId: "m1", answer: "We carry two.", blocks: [block] },
    ]);
  });

  it("parses ordered stream events", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        streamFromText(
          [
            'event: status\ndata: {"stage":"interpreting"}\n\n',
            'event: conversation\ndata: {"conversationId":"c1"}\n\n',
            'event: status\ndata: {"stage":"composing"}\n\n',
            'event: chunk\ndata: {"text":"hello"}\n\n',
            'event: future-progress\ndata: {"value":1}\n\n',
            'event: suggestions\ndata: {"conversationId":"c1","suggestions":[{"text":"What next?"}]}\n\n',
            'event: done\ndata: {"conversationId":"c1","assistantMessageId":"m1","answer":"hello","suggestions":[{"text":"What next?"}],"debug":{"route":{"type":"retrieval","reason":"evidence_required"},"activitySummary":{},"activityTrace":{}}}\n\n',
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
      fetch: fetchMock,
    });

    const events = [];
    for await (const event of client.chat.stream({ message: "hi", conversationId: undefined })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", stage: "interpreting" },
      { type: "conversation", conversationId: "c1" },
      { type: "status", stage: "composing" },
      { type: "chunk", text: "hello" },
      {
        type: "suggestions",
        conversationId: "c1",
        suggestions: [{ text: "What next?" }],
      },
      {
        type: "done",
        conversationId: "c1",
        assistantMessageId: "m1",
        answer: "hello",
        suggestions: [{ text: "What next?" }],
        debug: {
          route: { type: "retrieval", reason: "evidence_required" },
          activitySummary: {},
          activityTrace: {},
        },
      },
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
      fetch: fetchMock,
    });

    const events = [];
    for await (const event of client.chat.stream({ message: "hi", conversationId: undefined })) {
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

  it("parses a terminal cancelled frame", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        streamFromText(
          [
            'event: cancelled\ndata: {"conversationId":"c1","reason":"superseded","stage":"routing"}\n\n',
            'event: status\ndata: {"stage":"composing"}\n\n',
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
      fetch: fetchMock,
    });

    const events = [];
    for await (const event of client.chat.stream({ message: "hi", conversationId: "c1" })) {
      events.push(event);
    }

    expect(events).toEqual([{
      type: "cancelled",
      conversationId: "c1",
      reason: "superseded",
      stage: "routing",
    }]);
  });
});
