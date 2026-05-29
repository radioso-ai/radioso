import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient } from "../../src/index.js";

const encoder = new TextEncoder();

describe("sdk stream integration", () => {
  it("exposes streaming chat through the public client", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: conversation\ndata: {"conversationId":"c1"}\n\n'));
            controller.enqueue(encoder.encode('event: chunk\ndata: {"text":"hel"}\n\n'));
            controller.enqueue(encoder.encode('event: chunk\ndata: {"text":"lo"}\n\n'));
            controller.enqueue(encoder.encode('event: suggestions\ndata: {"conversationId":"c1","suggestions":[{"text":"Ask about sources"}]}\n\n'));
            controller.enqueue(encoder.encode('event: done\ndata: {"conversationId":"c1","assistantMessageId":"m1","answer":"hello","suggestions":[{"text":"Ask about sources"}],"debug":{"route":{"type":"retrieval","reason":"evidence_required"},"activitySummary":{},"activityTrace":{}}}\n\n'));
            controller.close();
          },
        }),
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
    for await (const event of client.chat.stream({ message: "hello" })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["conversation", "chunk", "chunk", "suggestions", "done"]);
    expect(events[3]).toMatchObject({
      type: "suggestions",
      conversationId: "c1",
      suggestions: [{ text: "Ask about sources" }],
    });
    expect(events[4]).toMatchObject({
      type: "done",
      conversationId: "c1",
      assistantMessageId: "m1",
      answer: "hello",
      suggestions: [{ text: "Ask about sources" }],
      debug: {
        route: { type: "retrieval", reason: "evidence_required" },
      },
    });
  });
});
