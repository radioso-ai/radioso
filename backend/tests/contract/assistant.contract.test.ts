import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      assistantMessageId: expect.stringMatching(uuidPattern),
      answer: expect.any(String),
      citations: expect.any(Array),
      answerSegments: expect.any(Array),
    });
    expect(response.body).not.toHaveProperty("route");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body).not.toHaveProperty("debug");
  });

  it("returns assistant diagnostics only when requested", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "assistant-debug@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Assistant Debug", content: "Debug responses preserve diagnostic traces." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({
        message: "What do debug responses preserve?",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("route");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body.debug).toMatchObject({
      route: {
        type: "retrieval",
        reason: "evidence_required",
      },
      activitySummary: expect.objectContaining({
        candidateCounts: expect.any(Object),
      }),
      activityTrace: expect.objectContaining({
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
    expect(response.body).not.toHaveProperty("conversationId");
    expect(response.body).toMatchObject({
      answer: expect.any(String),
      citations: [],
      answerSegments: expect.any(Array),
    });
    expect(response.body).not.toHaveProperty("route");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
  });

  it("documents assistant chat in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/assistant/chat:");
    expect(spec).toContain("AssistantChatRequest:");
    expect(spec).toContain("AssistantChatResponse:");
    expect(spec).not.toContain("/api/v1/chat/:");
  });
});
