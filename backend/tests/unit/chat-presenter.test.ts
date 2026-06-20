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
        assistantMessageId: "assistant-message-1",
        route: {
          type: "retrieval",
          reason: "evidence_required",
        },
        answer: "Answer",
        citations: [],
        answerSegments: [{ text: "Answer" }],
        suggestions: [
          {
            text: "Ask about parser validation rules",
            kind: "deeper",
            citation: {
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "Parser Notes",
            },
          },
        ],
        activitySummary: {
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
        activityTrace: {
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
    expect(donePayload).toContain("\"assistantMessageId\":\"assistant-message-1\"");
    expect(donePayload).toContain("\"suggestions\":[");
    expect(donePayload).toContain("\"kind\":\"deeper\"");
  });

  it("forwards the ownership ack on a streamed human-owned (suppressed) done event", async () => {
    const { response, writes } = createMockResponse();
    const suppressedDone: ChatStreamEvent = {
      type: "done",
      conversationId: "conversation-1",
      assistantMessageId: "",
      route: { type: "direct", reason: "social_only" },
      answer: "",
      citations: [],
      answerSegments: [],
      suggestions: [],
      activitySummary: {
        status: "skipped",
        outcome: "human_owned_suppressed",
        retrievalSkipped: true,
      },
      activityTrace: {
        traceId: "trace-suppressed",
        startedAt: new Date().toISOString(),
        stages: [],
        links: [],
      },
      ownership: { state: "human_owned", suppressed: true },
    };

    await sendChatSse(response as never, (async function* () {
      yield suppressedDone;
    })());

    const donePayload = writes.find((entry) => entry.startsWith("data: {") && entry.includes("\"answer\":\"\""));
    expect(donePayload).toContain("\"ownership\":{\"state\":\"human_owned\",\"suppressed\":true}");
  });

  it("omits ownership from a normal streamed done event", async () => {
    const { response, writes } = createMockResponse();
    const normalDone: ChatStreamEvent = {
      type: "done",
      conversationId: "conversation-1",
      assistantMessageId: "assistant-message-1",
      route: { type: "direct", reason: "social_only" },
      answer: "Answer",
      citations: [],
      answerSegments: [{ text: "Answer" }],
      suggestions: [],
      activitySummary: {
        status: "skipped",
        outcome: "non_retrieval_response",
        retrievalSkipped: true,
      },
      activityTrace: {
        traceId: "trace-normal",
        startedAt: new Date().toISOString(),
        stages: [],
        links: [],
      },
    };

    await sendChatSse(response as never, (async function* () {
      yield normalDone;
    })());

    const donePayload = writes.find((entry) => entry.startsWith("data: {") && entry.includes("\"answer\":\"Answer\""));
    expect(donePayload).not.toContain("\"ownership\"");
  });

  it("surfaces the turn-trace envelope under debug only when debug is included", async () => {
    const turnTrace = {
      version: 1,
      spine: {
        traceId: "conversation-turn-1",
        startedAt: new Date().toISOString(),
        stages: [
          {
            id: "dispatch:retrieval.answer",
            kind: "skill_dispatch",
            status: "applied",
            subTrace: { namespace: "retrieval", version: 1, payload: { traceId: "trace-1" } },
          },
        ],
      },
      openTelemetry: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        sampled: true,
      },
    };
    const doneEvent: ChatStreamEvent = {
      type: "done",
      conversationId: "conversation-1",
      assistantMessageId: "assistant-message-1",
      route: { type: "retrieval", reason: "evidence_required" },
      answer: "Answer",
      citations: [],
      activitySummary: {
        candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
        fallbackApplied: false,
        rerankStatus: "skipped",
        rewrite: { status: "skipped", eligible: false, ran: false, materialDisagreement: false },
      },
      activityTrace: { traceId: "trace-1", startedAt: new Date().toISOString(), stages: [], links: [] },
      turnTrace: turnTrace as never,
    };

    const withDebug = createMockResponse();
    await sendChatSse(withDebug.response as never, (async function* () {
      yield doneEvent;
    })(), { includeDebug: true });
    const debugDone = withDebug.writes.find((entry) => entry.includes("\"answer\":\"Answer\""));
    expect(debugDone).toContain("\"turnTrace\":");
    expect(debugDone).toContain("\"namespace\":\"retrieval\"");
    expect(debugDone).toContain("\"openTelemetry\":");
    expect(debugDone).toContain("\"spanId\":\"00f067aa0ba902b7\"");

    const noDebug = createMockResponse();
    await sendChatSse(noDebug.response as never, (async function* () {
      yield doneEvent;
    })());
    const publicDone = noDebug.writes.find((entry) => entry.includes("\"answer\":\"Answer\""));
    expect(publicDone).not.toContain("turnTrace");
    expect(publicDone).not.toContain("openTelemetry");
    expect(publicDone).not.toContain("\"debug\"");
  });

  it("includes skill display metadata in streamed skill events", async () => {
    const { response, writes } = createMockResponse();
    const events: ChatStreamEvent[] = [
      { type: "conversation", conversationId: "conversation-1" },
      {
        type: "skill",
        conversationId: "conversation-1",
        skillName: "human_contact.request",
        phase: "completed",
        display: {
          icon: "handshake",
          title: "Contact us",
        },
        localizedTitle: "Contact us",
      },
    ];

    await sendChatSse(response as never, (async function* () {
      yield* events;
    })());

    const skillPayload = writes.find((entry) => entry.startsWith("data: {") && entry.includes("\"skillName\":\"human_contact.request\""));
    expect(skillPayload).toContain("\"display\":{\"icon\":\"handshake\",\"title\":\"Contact us\"}");
  });
});
