import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp, issueTestToken } from "../support/testApp.js";
import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";

describe("public chat contract", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  const enableAnonymousChat = async (app: any, token: string, anonymousRateLimit?: number) => {
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({
        anonymousChatEnabled: true,
        ...(anonymousRateLimit ? { anonymousRateLimit } : {}),
      });
    // Extract the chat token from the URL
    const url: string = response.body.anonymousChatUrl;
    return url.split("/chat/")[1];
  };

  const findAnonymousCookie = (cookies: string[] | string | undefined) =>
    (Array.isArray(cookies) ? cookies : [cookies]).find((cookie: string | undefined) =>
      typeof cookie === "string" && cookie.startsWith("anon_session_"),
    );

  it("POST /api/v1/public/chat/:token creates conversation and returns response", async () => {
    const { app } = createTestApp();
    const { token: bearerToken } = await issueTestToken(app);

    // Ingest a document so the bot has something to respond with
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ title: "Test Doc", content: "The answer is 42." });

    const chatToken = await enableAnonymousChat(app, bearerToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "What is the answer?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBeDefined();
    expect(response.body.answer).toBeDefined();
    // Should set anon_session cookie
    const cookies = response.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const anonCookie = findAnonymousCookie(cookies);
    expect(anonCookie).toBeDefined();
  });

  it("subsequent requests with cookie reuse the same session", async () => {
    const { app } = createTestApp();
    const { token: bearerToken } = await issueTestToken(app);
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ title: "Doc", content: "Hello world" });

    const chatToken = await enableAnonymousChat(app, bearerToken);

    // First request — get cookie
    const first = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "hello", stream: false });

    const cookies = first.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    // Second request with cookie and conversationId
    const second = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("Cookie", anonCookie!)
      .send({ query: "follow up", stream: false, conversationId: first.body.conversationId });

    expect(second.status).toBe(200);
    expect(second.body.conversationId).toBe(first.body.conversationId);
  });

  it("GET /api/v1/public/chat/:token returns conversations for the session", async () => {
    const { app } = createTestApp();
    const { token: bearerToken } = await issueTestToken(app);
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, bearerToken);

    // Create a conversation
    const chat = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "test", stream: false });

    const cookies = chat.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    // List conversations
    const list = await request(app)
      .get(`/api/v1/public/chat/${chatToken}`)
      .set("Cookie", anonCookie!);

    expect(list.status).toBe(200);
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0].id).toBe(chat.body.conversationId);
  });

  it("GET /api/v1/public/chat/:token/history/:conversationId returns messages", async () => {
    const { app } = createTestApp();
    const { token: bearerToken } = await issueTestToken(app);
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chatToken = await enableAnonymousChat(app, bearerToken);

    const chat = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "What does this page do?", stream: false });

    const cookies = chat.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    const detail = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${chat.body.conversationId}`)
      .set("Cookie", anonCookie!);

    expect(detail.status).toBe(200);
    expect(detail.body.messages).toBeDefined();
    expect(detail.body.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(detail.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          citations: expect.any(Array),
          answerSegments: expect.any(Array),
        }),
      ]),
    );
  });

  it("invalid token returns 404", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .post("/api/v1/public/chat/nonexistent-token")
      .send({ query: "hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("disabled workspace returns 404", async () => {
    const { app } = createTestApp();
    const { token: bearerToken } = await issueTestToken(app);
    const chatToken = await enableAnonymousChat(app, bearerToken);

    // Disable
    await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ anonymousChatEnabled: false });

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("exceeding rate limit returns 429 with retryAfterSeconds", async () => {
    const { app } = createTestApp();
    const { token: bearerToken } = await issueTestToken(app);
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, bearerToken, 1);

    // First message should succeed
    const first = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "first", stream: false });
    expect(first.status).toBe(200);

    const cookies = first.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    // Second message should be rate limited
    const second = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("Cookie", anonCookie!)
      .send({ query: "second", stream: false });

    expect(second.status).toBe(429);
    expect(second.body.code).toBe("rate_limit_exceeded");
    expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
