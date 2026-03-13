import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("chat integration", () => {
  it("creates a new conversation and reuses it on follow-up questions", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "followup@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const first = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });
    const second = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        query: "And who is it for?",
        stream: false,
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.conversationId).toEqual(first.body.conversationId);
    expect(second.body.answer).toContain("history:2");
  });

  it("returns a safe answer when no relevant chunks are found", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "empty@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token.body.token}`)
      .send({ query: "What is the capital of France?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("could not find relevant information");
  });

  it("keeps conversations account scoped", async () => {
    const { app } = createTestApp();

    const firstRegister = await request(app).post("/api/v1/auth/register").send({
      email: "scope-a@example.com",
      password: "verysecurepassword",
    });
    const secondRegister = await request(app).post("/api/v1/auth/register").send({
      email: "scope-b@example.com",
      password: "verysecurepassword",
    });
    const firstToken = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", firstRegister.headers["set-cookie"][0]);
    const secondToken = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", secondRegister.headers["set-cookie"][0]);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${firstToken.body.token}`)
      .send({ title: "A", content: "Account A data only." });

    const firstChat = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${firstToken.body.token}`)
      .send({ query: "What data is here?", stream: false });
    const secondChat = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${secondToken.body.token}`)
      .send({
        conversationId: firstChat.body.conversationId,
        query: "Can I reuse this conversation?",
        stream: false,
      });

    expect(firstChat.status).toBe(200);
    expect(secondChat.status).toBe(404);
  });
});
