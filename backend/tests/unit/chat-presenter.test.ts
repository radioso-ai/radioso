import { describe, expect, it } from "vitest";

import { sendChatSse } from "../../src/app/http/presenters/chatPresenter.js";
import type { ChatStreamEvent } from "../../src/modules/chat/services/chatService.js";

const createMockResponse = () => {
  let closeHandler: (() => void) | undefined;
  const writes: string[] = [];

  return {
    response: {
      headersSent: false,
      writableEnded: false,
      on(event: string, handler: () => void) {
        if (event === "close") {
          closeHandler = handler;
        }
      },
      status() {
        return this;
      },
      setHeader() {},
      flushHeaders() {
        this.headersSent = true;
      },
      write(chunk: string) {
        writes.push(chunk);
      },
      end() {
        this.writableEnded = true;
      },
    },
    writes,
    close() {
      closeHandler?.();
    },
  };
};

describe("chat presenter", () => {
  it("includes conversation mode metadata in streamed done events", async () => {
    const { response, writes } = createMockResponse();
    const events: ChatStreamEvent[] = [
      { type: "conversation", conversationId: "conversation-1" },
      {
        type: "done",
        conversationId: "conversation-1",
        answer: "Answer",
        citations: [],
        answerSegments: [{ text: "Answer" }],
        suggestions: [
          {
            text: "Ask about parser validation rules",
            citation: {
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "Parser Notes",
            },
          },
        ],
        conversationMode: "guided",
        conversationModeMetadata: {
          conversationMode: "guided",
          brevityOverrideApplied: false,
          expansionApplied: true,
          expansionKind: "focused",
          suggestionCount: 2,
          followUpQuestionApplied: false,
        },
        retrievalInfo: {
          candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
          fallbackApplied: false,
          rerankStatus: "skipped",
          rewrite: {
            status: "skipped",
            eligible: false,
            ran: false,
            materialDisagreement: false,
          },
        },
        retrievalTrace: {
          traceId: "trace-1",
          startedAt: new Date().toISOString(),
          stages: [],
          links: [],
        },
      },
    ];

    await sendChatSse(response as never, (async function* () {
      yield* events;
    })());

    const donePayload = writes.find((entry) => entry.startsWith("data: {") && entry.includes("\"answer\":\"Answer\""));
    expect(donePayload).toContain("\"conversationMode\":\"guided\"");
    expect(donePayload).toContain("\"conversationModeMetadata\":");
    expect(donePayload).toContain("\"expansionKind\":\"focused\"");
    expect(donePayload).toContain("\"suggestions\":[");
  });
});
