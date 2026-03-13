import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

const getBearerToken = async (app: ReturnType<typeof createTestApp>["app"]) => {
  const register = await request(app).post("/api/v1/auth/register").send({
    email: "chat@example.com",
    password: "verysecurepassword",
  });
  const token = await request(app)
    .get("/api/v1/account/token")
    .set("Cookie", register.headers["set-cookie"][0]);
  return token.body.token as string;
};

describe("chat contract", () => {
  it("returns a non-streaming chat response with a conversation id", async () => {
    const { app } = createTestApp();
    const token = await getBearerToken(app);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "What does this page do?", stream: false });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["answer", "citations", "conversationId"]);
    expect(response.body.conversationId).toBeDefined();
    expect(response.body.answer).toContain("This page parses content");
    expect(Array.isArray(response.body.citations)).toBe(true);
    expect(response.body).not.toHaveProperty("retrieval");
  });

  it("returns an SSE response when streaming is requested", async () => {
    const { app } = createTestApp();
    const token = await getBearerToken(app);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString();
        });
        res.on("end", () => callback(null, body));
      })
      .send({ query: "What does this page do?", stream: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: conversation");
    expect(response.body).toContain("event: done");
  });

  it("accepts an existing conversation id without changing the request shape", async () => {
    const { app } = createTestApp();
    const token = await getBearerToken(app);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const first = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "What does this page do?", stream: false });

    const second = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: first.body.conversationId,
        query: "And what does it answer?",
        stream: false,
      });

    expect(second.status).toBe(200);
    expect(Object.keys(second.body).sort()).toEqual(["answer", "citations", "conversationId"]);
    expect(second.body.conversationId).toBe(first.body.conversationId);
  });
});
