import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("assistant contract", () => {
  it("answers authenticated chat through the assistant surface", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "assistant-contract@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Assistant Intro", content: "This workspace explains assistant-owned chat contracts." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({
        message: "What does this workspace explain?",
        stream: false,
        inputMetadata: {
          method: "typed",
        },
        sourceContext: {
          surface: "authenticated_chat",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId: expect.any(String),
      route: {
        type: "retrieval",
        reason: "evidence_required",
      },
      answer: expect.any(String),
      citations: expect.any(Array),
      answerSegments: expect.any(Array),
      conversationMode: expect.any(String),
      conversationModeMetadata: expect.objectContaining({
        conversationMode: expect.any(String),
      }),
      retrievalInfo: expect.objectContaining({
        candidateCounts: expect.any(Object),
      }),
      retrievalTrace: expect.objectContaining({
        traceId: expect.any(String),
        stages: expect.any(Array),
      }),
    });
  });

  it("can start an assistant-owned conversation without a separate bootstrap endpoint", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "assistant-start@example.com");

    await request(app)
      .put("/api/v1/settings")
      .set(adminSessionHeaders(session))
      .send({
        assistant: {
          assistantName: "Marta",
          greetingInstruction: "Warm and concise",
          proactiveGreetingEnabled: true,
        },
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({
        startConversation: true,
        stream: false,
        sourceContext: {
          surface: "authenticated_chat",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId: expect.any(String),
      route: {
        type: "direct",
        reason: "conversation_start",
      },
      answer: expect.any(String),
      citations: [],
      answerSegments: expect.any(Array),
      retrievalInfo: expect.objectContaining({
        retrievalSkipped: true,
      }),
    });
  });

  it("documents assistant chat in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/assistant/chat:");
    expect(spec).toContain("AssistantChatRequest:");
    expect(spec).toContain("AssistantChatResponse:");
    expect(spec).not.toContain("/api/v1/chat/:");
  });
});
