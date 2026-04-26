import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("history contract", () => {
  it("lists and fetches assistant conversation history from the platform history routes", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "history-contract@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "History Intro", content: "History uses assistant conversation records." });

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({ message: "What records does history use?", stream: false });

    const list = await request(app)
      .get("/api/v1/history")
      .set(adminSessionHeaders(session));
    const detail = await request(app)
      .get(`/api/v1/history/${chat.body.conversationId}`)
      .set(adminSessionHeaders(session));

    expect(chat.status).toBe(200);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      conversations: [
        expect.objectContaining({
          id: chat.body.conversationId,
          messageCount: 2,
          userMessageCount: 1,
          assistantMessageCount: 1,
        }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      conversationId: chat.body.conversationId,
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "What records does history use?" }),
        expect.objectContaining({
          role: "assistant",
          debug: expect.objectContaining({
            route: expect.objectContaining({
              generator: "assistant",
              routeType: "retrieval",
              retrievalInvoked: true,
            }),
          }),
        }),
      ]),
    });
  });

  it("documents shared history in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/history:");
    expect(spec).toContain("/api/v1/history/{conversationId}:");
    expect(spec).not.toContain("/api/v1/chat/history:");
  });
});
