import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";
import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";

describe("public chat contract", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  const enableAnonymousChat = async (
    app: any,
    session: { cookie: string; workspaceId: string },
    anonymousRateLimit?: number,
  ) => {
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
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
    const session = await issueTestSession(app, "public-chat-create@example.com");

    // Ingest a document so the bot has something to respond with
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Test Doc", content: "The answer is 42." });

    const chatToken = await enableAnonymousChat(app, session);

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
    const session = await issueTestSession(app, "public-chat-session@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Hello world" });

    const chatToken = await enableAnonymousChat(app, session);

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
    const session = await issueTestSession(app, "public-chat-list@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, session);

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
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.hasMore).toBe(false);
  });

  it("rejects malformed anonymous history cursors with a client error", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-bad-cursor@example.com");
    const chatToken = await enableAnonymousChat(app, session);

    const first = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "hello", stream: false });

    const cookies = first.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    const response = await request(app)
      .get(`/api/v1/public/chat/${chatToken}?cursor=not-a-cursor`)
      .set("Cookie", anonCookie!);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid cursor",
    });
  });

  it("GET /api/v1/public/chat/:token/history/:conversationId returns messages", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-history@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chatToken = await enableAnonymousChat(app, session);

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
    expect(detail.body.nextCursor).toBeNull();
    expect(detail.body.hasOlderMessages).toBe(false);
  });

  it("supports cursor pagination for anonymous chat history lists", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-list-cursor@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, session);

    const firstConversation = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "first", stream: false });

    const cookies = firstConversation.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("Cookie", anonCookie!)
      .send({ query: "second", stream: false });

    await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("Cookie", anonCookie!)
      .send({ query: "third", stream: false });

    const firstPage = await request(app)
      .get(`/api/v1/public/chat/${chatToken}?limit=2`)
      .set("Cookie", anonCookie!);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.conversations).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(`/api/v1/public/chat/${chatToken}?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set("Cookie", anonCookie!);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.conversations).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("applies the workspace answer support policy to anonymous chat", async () => {
    const { app } = createTestApp({
      chatGateway: {
        async answer() {
          return "Narayani is a teacher and author.";
        },
        async *streamAnswer() {
          yield "Narayani is a teacher and author.";
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-policy@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Event listing", content: "Narayani leads a satsang this weekend." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep the query standalone.",
        lexicalRewriteInstructions: "Prefer exact literals.",
        answerSupportPolicy: "warn",
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [],
        customInstruction: "",
      })
      .expect(200);

    const chatToken = await enableAnonymousChat(app, session);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "Who is Narayani?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("Narayani is a teacher and author.");
    expect(response.body.answer).not.toBe("I couldn't verify that from the retrieved documents.");
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
    const session = await issueTestSession(app, "public-chat-disabled@example.com");
    const chatToken = await enableAnonymousChat(app, session);

    // Disable
    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: false });

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ query: "hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("exceeding rate limit returns 429 with retryAfterSeconds", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-rate-limit@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, session, 1);

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
    expect(second.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: {
        retryAfterSeconds: expect.any(Number),
      },
    });
  });
});
