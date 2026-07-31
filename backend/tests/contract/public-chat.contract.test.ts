import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";
import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { signVisitorIdentity } from "../../src/modules/context-variables/public.js";
import {
  DEGRADED_V2_VISIBLE,
  FOCUSED_NO_SUPPORT_REPLY,
  GROUNDED_V2_VISIBLE,
  NO_SUPPORT_V2_BODY,
  degradedV2Envelope,
  groundedV2Envelope,
  noSupportV2Envelope,
} from "../support/answerEnvelopeV2Fixtures.js";

describe("public chat contract", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  const enableAnonymousChat = async (
    app: any,
    session: { cookie: string; workspaceId: string },
  ) => {
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });
    // Extract the chat token from the URL
    const url: string = response.body.anonymousChatUrl;
    return url.split("/chat/")[1];
  };

  const findAnonymousCookie = (cookies: string[] | string | undefined) =>
    (Array.isArray(cookies) ? cookies : [cookies]).find((cookie: string | undefined) =>
      typeof cookie === "string" && cookie.startsWith("anon_session_"),
    );

  const createPublicSession = async (
    app: any,
    chatToken: string,
    resumeToken?: string,
  ): Promise<{ publicSessionToken: string; publicSessionId: string }> => {
    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}/sessions`)
      .send({
        channel: "anonymous_link",
        ...(resumeToken ? { resumeToken } : {}),
      });

    expect(response.status).toBe(200);
    return response.body;
  };

  const updateRetrievalSkillSettings = async (
    dependencies: ReturnType<typeof createTestApp>["dependencies"],
    workspaceId: string,
    settings: Record<string, unknown>,
  ) => {
    const agent = await dependencies.agentService.resolve(workspaceId);
    return dependencies.agentService.update(workspaceId, agent.id, {
      skillSettings: {
        "retrieval.answer": settings,
      },
    });
  };

  it("answers a message sent together with startConversation instead of dropping it", async () => {
    // A caller may set startConversation:true on the first user message ("start a
    // conversation with this message"). The message must be answered, not
    // silently dropped for an empty greeting (which 204s and looks like a failure
    // to browser clients).
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-startconv-message@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Test Doc", content: "The answer is 42." });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "What is the answer?", startConversation: true, stream: false });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBeDefined();
    expect(response.body.answer).toBeDefined();
  });

  it("POST /api/v1/public/chat/:token creates conversation and returns response", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-create@example.com");

    // Ingest a document so the bot has something to respond with
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Test Doc", content: "The answer is 42." });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "What is the answer?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBeDefined();
    expect(response.body.answer).toBeDefined();
    expect(response.body).not.toHaveProperty("route");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body).not.toHaveProperty("debug");
    // Should set anon_session cookie
    const cookies = response.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const anonCookie = findAnonymousCookie(cookies);
    expect(anonCookie).toBeDefined();
  });

  it("does not expose diagnostics when public callers request debug", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-debug-request@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Debug Doc", content: "The public debug answer is hidden." });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "What is hidden?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBeDefined();
    expect(response.body).not.toHaveProperty("route");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body).not.toHaveProperty("debug");
  });

  it("accepts embedded page context but gates it out of model input when no classifier selects it", async () => {
    // The page-read gate requires a positive classification (planner, staged
    // interpreter, or routine dependency) before any page byte reaches a model.
    // The contract app has no classifier model, so the documented failure
    // default applies: the request is accepted, the turn answers normally, and
    // page context contributes nothing to model input.
    const prompts: string[] = [];
    const contextualGateway: ChatGateway = {
      async answer(input) {
        prompts.push(input.prompt);
        return "Answered without page context.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({ chatGateway: contextualGateway });
    const session = await issueTestSession(app, "public-chat-page-context@example.com");
    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({
        message: "What is this page about?",
        stream: false,
        pageContext: {
          pageUrl: "https://example.com/retreats",
          pageTitle: "Summer Retreats",
          pageLocale: "en",
          browserLocale: "en-US",
          content: "Summer retreats are open for registration.",
        },
        clientContextCapabilities: {
          "page.read": {
            available: true,
            mode: "content",
            supportedOperations: ["metadata", "lookup", "summarize"],
          },
        },
      });

    expect(response.status).toBe(200);
    const allPrompts = prompts.join("\n");
    expect(allPrompts).not.toContain("https://example.com/retreats");
    expect(allPrompts).not.toContain("Summer retreats are open for registration.");
    expect(allPrompts).not.toContain("Visible page excerpt");
  });

  it("uses a valid signed identity to unlock customer-scoped context and treats invalid identity as anonymous", async () => {
    const prompts: string[] = [];
    const contextualGateway: ChatGateway = {
      async answer(input) {
        prompts.push(input.prompt);
        return "ok";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: contextualGateway });
    const session = await issueTestSession(app, "public-chat-signed-identity@example.com");
    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });
    expect(settings.status).toBe(200);
    const embedToken = settings.body.websiteEmbedToken as string;
    const agent = await dependencies.agentService.resolve(session.workspaceId);
    const resolveForAgent = vi.spyOn(dependencies.contextVariableRepository, "resolveForAgent")
      .mockImplementation(async (_workspaceId, _agentId, scopes) =>
        scopes.some((scope) => scope.type === "customer" && scope.id === "customer-123")
          ? [{
              name: "cart",
              description: "current cart",
              value: { items: ["sku-1"] },
              surfacing: "always",
              sensitive: false,
              trust: "verified",
            }]
          : [],
      );
    const publicSession = await request(app)
      .post(`/api/v1/public/chat/${embedToken}/sessions`)
      .set("Origin", "https://example.com")
      .send({ channel: "website_embed" });
    expect(publicSession.status).toBe(200);
    const signedIdentity = signVisitorIdentity(
      dependencies.env.WORKSPACE_TOKEN_SECRET!,
      session.workspaceId,
      agent.id,
      {
        customerId: "customer-123",
        sessionId: publicSession.body.publicSessionId,
        origin: "https://example.com",
        issuedAt: Date.now(),
        nonce: "nonce-route-valid",
        attributes: { plan: "pro" },
      },
    );

    const valid = await request(app)
      .post(`/api/v1/public/chat/${embedToken}`)
      .set("Origin", "https://example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "What is in my cart?", stream: false, signedIdentity });
    expect(valid.status).toBe(200);
    expect(resolveForAgent).toHaveBeenLastCalledWith(session.workspaceId, agent.id, [
      { type: "session", id: publicSession.body.publicSessionId },
      { type: "customer", id: "customer-123" },
      { type: "agent", id: agent.id },
      { type: "workspace", id: session.workspaceId },
    ]);
    expect(prompts.at(-1)).toContain('"items"');

    const invalid = await request(app)
      .post(`/api/v1/public/chat/${embedToken}`)
      .set("Origin", "https://example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "What is in my cart now?", stream: false, signedIdentity: `${signedIdentity}x` });
    expect(invalid.status).toBe(200);
    expect(resolveForAgent).toHaveBeenLastCalledWith(session.workspaceId, agent.id, [
      { type: "session", id: publicSession.body.publicSessionId },
      { type: "agent", id: agent.id },
      { type: "workspace", id: session.workspaceId },
    ]);
  });

  it("subsequent requests with cookie reuse the same session", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-session@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Hello world" });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    // First request — get cookie
    const first = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "hello", stream: false });

    const cookies = first.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    // Second request with cookie and conversationId
    const second = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .send({ message: "follow up", stream: false, conversationId: first.body.conversationId });

    expect(second.status).toBe(200);
    expect(second.body.conversationId).toBe(first.body.conversationId);
  });

  it("GET /api/v1/public/chat/:token returns conversations for the session", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
    });
    const session = await issueTestSession(app, "public-chat-list@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    // Create a conversation
    const chat = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "test", stream: false });

    // List conversations
    const list = await request(app)
      .get(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken);

    expect(list.status).toBe(200);
    expect(list.body.assistantBootstrapActive).toBe(false);
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0].id).toBe(chat.body.conversationId);
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.hasMore).toBe(false);
  }, 10_000);

  it("GET /api/v1/public/chat/:token returns a cache-keyed assistant logo URL", async () => {
    const { app, dependencies } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
    });
    const session = await issueTestSession(app, "public-chat-list-logo@example.com");

    await request(app)
      .post("/api/v1/settings/general/assistant-logo")
      .set(adminSessionHeaders(session))
      .attach("logo", Buffer.from("fake-logo"), {
        filename: "assistant.png",
        contentType: "image/png",
      })
      .expect(200);

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);
    const agent = await dependencies.agentService.resolve(session.workspaceId);
    if (!agent.logo) {
      throw new Error("Expected uploaded logo");
    }

    const list = await request(app)
      .get(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken);

    expect(list.status).toBe(200);
    const assistantAvatarUrl = new URL(list.body.assistantAvatarUrl, "https://app.example.com");
    expect(assistantAvatarUrl.pathname).toBe(`/api/v1/public/chat/${chatToken}/assistant-logo`);
    expect(assistantAvatarUrl.searchParams.get("v")).toMatch(/^[a-z0-9]+:[^:]*:\d+$/);
    expect(assistantAvatarUrl.searchParams.get("v")).not.toContain(agent.logo.objectPath);
  }, 10_000);

  it("rejects malformed anonymous history cursors with a client error", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
    });
    const session = await issueTestSession(app, "public-chat-bad-cursor@example.com");
    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const first = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "hello", stream: false });

    const cookies = first.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    const response = await request(app)
      .get(`/api/v1/public/chat/${chatToken}?cursor=not-a-cursor`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid cursor",
    });
  });

  it("GET /api/v1/public/chat/:token/history/:conversationId returns messages", async () => {
    let expectedAnonymousSessionId = "";
    const { app } = createTestApp({
      answerFeedbackHistoryProvider: {
        async listByAssistantMessageIds(_workspaceId, assistantMessageIds) {
          return new Map(assistantMessageIds.map((assistantMessageId) => [
            assistantMessageId,
            [
              {
                id: "11111111-1111-1111-1111-111111111111",
                value: "down" as const,
                comment: "Needs more detail.",
                actorType: "anonymous_user" as const,
                actorId: expectedAnonymousSessionId,
                accountId: null,
                userId: null,
                anonymousSessionId: expectedAnonymousSessionId,
                createdAt: "2026-05-08T10:00:00.000Z",
                updatedAt: "2026-05-08T10:00:00.000Z",
              },
              {
                id: "22222222-2222-2222-2222-222222222222",
                value: "up" as const,
                comment: "Internal note.",
                actorType: "authenticated_user" as const,
                actorId: "operator-user",
                accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                anonymousSessionId: null,
                createdAt: "2026-05-08T10:01:00.000Z",
                updatedAt: "2026-05-08T10:01:00.000Z",
              },
              {
                id: "33333333-3333-3333-3333-333333333333",
                value: "up" as const,
                comment: "Other anonymous session.",
                actorType: "anonymous_user" as const,
                actorId: "55555555-5555-5555-5555-555555555555",
                accountId: null,
                userId: null,
                anonymousSessionId: "55555555-5555-5555-5555-555555555555",
                createdAt: "2026-05-08T10:02:00.000Z",
                updatedAt: "2026-05-08T10:02:00.000Z",
              },
            ],
          ]));
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-history@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);
    expectedAnonymousSessionId = publicSession.publicSessionId;

    const chat = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({
        message: "What does this page do?",
        stream: false,
        inputMetadata: {
          method: "typed",
        },
      });

    // Public answers expose sanitized sources (labels + links) but never the
    // internal document/chunk identifiers.
    expect(Array.isArray(chat.body.citations)).toBe(true);
    for (const citation of chat.body.citations) {
      expect(citation.documentId).toBe("");
      expect(citation.chunkId).toBe("");
    }
    expect(Array.isArray(chat.body.answerSegments)).toBe(true);

    const cookies = chat.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    const detail = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${chat.body.conversationId}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!);

    expect(detail.status).toBe(200);
    expect(detail.body.messages).toBeDefined();
    expect(detail.body.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(detail.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          inputMetadata: {
            method: "typed",
          },
        }),
        expect.objectContaining({
          role: "assistant",
          answerFeedbackEntries: [
            expect.objectContaining({
              value: "down",
              comment: "Needs more detail.",
              actorType: "anonymous_user",
            }),
          ],
        }),
      ]),
    );
    const assistantTurn = detail.body.messages.find((message: { role: string }) => message.role === "assistant");
    expect(Array.isArray(assistantTurn?.citations)).toBe(true);
    for (const citation of assistantTurn.citations) {
      expect(citation.documentId).toBe("");
      expect(citation.chunkId).toBe("");
    }
    expect(assistantTurn).not.toHaveProperty("debug");
    expect(assistantTurn?.answerFeedbackEntries).toHaveLength(1);
    expect(assistantTurn?.answerFeedbackEntries).toEqual([
      expect.objectContaining({
        value: "down",
        comment: "Needs more detail.",
        actorType: "anonymous_user",
        anonymousSessionId: publicSession.publicSessionId,
      }),
    ]);
    expect(assistantTurn?.answerFeedbackEntries).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          comment: "Internal note.",
        }),
        expect.objectContaining({
          anonymousSessionId: "55555555-5555-5555-5555-555555555555",
        }),
      ]),
    );
    expect(Array.isArray(assistantTurn?.answerSegments)).toBe(true);
    expect(detail.body.nextCursor).toBeNull();
    expect(detail.body.hasOlderMessages).toBe(false);
  });

  it("streams public chat responses with SSE event framing", async () => {
    const streamingGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "Streaming ";
        yield "works[[1]].";
      },
    };
    // Force the retrieval path so this test exercises grounded streaming +
    // citation reconciliation rather than the greeting/direct shortcut.
    const { app } = createTestApp({
      chatGateway: streamingGateway,
      turnRouter: {
        async classify() {
          return { route: "retrieval" as const, framing: { isIdentityQuestion: false } };
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-stream@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Hello. Streaming works." });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => callback(null, body));
      })
      .send({ message: "Hello", stream: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.body).toContain("event: conversation");
    expect(response.body).toContain("event: chunk");
    expect(response.body).toContain('data: {"text":"Streaming works."}');
    expect(response.body).toContain("event: done");
  });

  it.each([
    ["grounded", groundedV2Envelope, GROUNDED_V2_VISIBLE, ["stream_grounded"]],
    ["partial", degradedV2Envelope, DEGRADED_V2_VISIBLE, ["stream_grounded"]],
    [
      "no-support",
      noSupportV2Envelope,
      FOCUSED_NO_SUPPORT_REPLY,
      ["stream_grounded", "stream_envelope_decline_body"],
    ],
  ] as const)("streams the sanitized v2 %s fixture through public chat", async (
    _name,
    buildRaw,
    visibleAnswer,
    expectedAttemptKeys,
  ) => {
    const attemptKeys: string[] = [];
    const raw = buildRaw();
    const streamingGateway: ChatGateway = {
      async answer(input) {
        attemptKeys.push(input.usageContext.attemptKey);
        return raw;
      },
      async *streamAnswer(input) {
        attemptKeys.push(input.usageContext.attemptKey);
        for (let offset = 0; offset < raw.length; offset += 9) {
          yield raw.slice(offset, offset + 9);
        }
      },
    };
    const { app } = createTestApp({
      chatGateway: streamingGateway,
      fallbackReplyComposer: {
        async composeNoContext(input) {
          attemptKeys.push(input.usageContext.attemptKey);
          return { text: FOCUSED_NO_SUPPORT_REPLY, declineReason: "content_gap" };
        },
      },
      turnRouter: {
        async classify() {
          return { route: "retrieval" as const, framing: { isIdentityQuestion: false } };
        },
      },
    });
    const session = await issueTestSession(app, `public-v2-${_name}@example.com`);
    for (const [title, content] of [
      ["Workshop dates", "The advanced workshop runs in June."],
      ["Returning students", "Returning students can register online."],
      ["Registration", "Online registration is available for returning students."],
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set(adminSessionHeaders(session))
        .send({ title, content });
    }
    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => callback(null, body));
      })
      .send({ message: "Tell me about the advanced workshop.", stream: true });

    expect(response.status).toBe(200);
    expect(response.body).toContain(JSON.stringify(visibleAnswer));
    if (_name === "no-support") {
      expect(response.body).not.toContain(NO_SUPPORT_V2_BODY);
    }
    expect(response.body).not.toContain("RADIOSO_FOLLOWUPS_JSON");
    expect(response.body).not.toContain("[[");
    expect(response.body).toContain("event: done");
    expect(attemptKeys).toEqual(expectedAttemptKeys);
  });

  it("supports cursor pagination for anonymous chat history lists", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-list-cursor@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const firstConversation = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "first", stream: false });

    const cookies = firstConversation.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .send({ message: "second", stream: false });

    await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .send({ message: "third", stream: false });

    const firstPage = await request(app)
      .get(`/api/v1/public/chat/${chatToken}?limit=2`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.conversations).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(`/api/v1/public/chat/${chatToken}?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.conversations).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("grounds anonymous chat answers using retrieval validation defaults", async () => {
    const { app, dependencies } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
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
    const { workspaceId } = session;
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Event listing", content: "Narayani leads a satsang this weekend." });

    await updateRetrievalSkillSettings(dependencies, workspaceId, {
      queryRewriteEnabled: false,
      semanticRewriteInstructions: "Keep the query standalone.",
      lexicalRewriteInstructions: "Prefer exact literals.",
      rerankEnabled: false,
      vectorTopK: 15,
      rerankTopK: 5,
      metadataRules: [],
      customInstruction: "",
    });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "Who is Narayani?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
  });

  it("invalid token returns 404", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .post("/api/v1/public/chat/nonexistent-token")
      .send({ message: "hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("returns 204 (benign no-greeting) when a bootstrap has no response", async () => {
    // A startConversation bootstrap with no proactive greeting is a benign
    // "no content" outcome — the website embed client treats 204 as "no
    // greeting" and proceeds to normal chat. It must NOT be a 503 error, which
    // the widget surfaces as a fatal "Chat Unavailable".
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
    });
    const session = await issueTestSession(app, "public-chat-empty-bootstrap@example.com");
    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ startConversation: true, stream: false });

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
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
      .send({ message: "hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("exceeding rate limit returns 429 with retryAfterSeconds", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
    });
    const session = await issueTestSession(app, "public-chat-rate-limit@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "Content" });

    const chatToken = await enableAnonymousChat(app, session);
    const publicSession = await createPublicSession(app, chatToken);

    // First message should succeed
    const first = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "first", stream: false });
    expect(first.status).toBe(200);

    const cookies = first.headers["set-cookie"];
    const anonCookie = findAnonymousCookie(cookies);

    // Second message should be rate limited
    const second = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .send({ message: "second", stream: false });

    expect(second.status).toBe(429);
    expect(second.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: {
        retryAfterSeconds: expect.any(Number),
      },
    });
  });

  it("creates a public bootstrap greeting with request locale for a new session", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
      chatGateway: {
        async answer() {
          return "Hello! I'm Marta and I can help with your documents.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-bootstrap@example.com");
    const chatToken = await enableAnonymousChat(app, session);

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        proactiveGreetingEnabled: true,
      })
      .expect(200);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ startConversation: true, stream: false, userExpectedLocale: "en" });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("uses embedded page locale for the public bootstrap greeting when no request locale is set", async () => {
    const prompts: string[] = [];
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
      chatGateway: {
        async answer(input) {
          prompts.push(input.prompt);
          return "Tere! Olen Marta ja saan aidata dokumentidega.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-bootstrap-page-locale@example.com");
    const chatToken = await enableAnonymousChat(app, session);

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        assistantDefaultLocale: "en-US",
        proactiveGreetingEnabled: true,
      })
      .expect(200);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({
        startConversation: true,
        stream: false,
        pageContext: {
          pageLocale: "et",
          browserLocale: "en-US",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("Tere! Olen Marta ja saan aidata dokumentidega.");
    expect(prompts[0]).toContain("Write the greeting in locale et.");
  });

  it("ignores malformed public bootstrap locale hints and falls back safely", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
      chatGateway: {
        async answer(input) {
          if (input.query.length === 0) {
            return "Hello! I'm Marta and I can help with your documents.";
          }
          return "unused";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-bootstrap-invalid-locale@example.com");
    const chatToken = await enableAnonymousChat(app, session);

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        proactiveGreetingEnabled: true,
      })
      .expect(200);
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ startConversation: true, stream: false, userExpectedLocale: "bad_locale_value" });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body).not.toHaveProperty("conversationId");
  });

  it("counts bootstrap greeting requests against the anonymous rate limit", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
        PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      },
      chatGateway: {
        async answer(input) {
          if (input.query.length === 0) {
            return "Hello! I'm Marta and I can help with your documents.";
          }
          return "The answer is 42.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });
    const session = await issueTestSession(app, "public-chat-bootstrap-rate-limit@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Doc", content: "The answer is 42." });

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        proactiveGreetingEnabled: true,
      });
    const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];
    const publicSession = await createPublicSession(app, chatToken);

    const bootstrap = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ startConversation: true, stream: false, userExpectedLocale: "en-US" });
    const anonCookie = findAnonymousCookie(bootstrap.headers["set-cookie"]);

    const firstMessage = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .send({ message: "What is the answer?", stream: false });

    expect(bootstrap.status).toBe(200);
    expect(firstMessage.status).toBe(429);
    expect(firstMessage.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: {
        retryAfterSeconds: expect.any(Number),
      },
    });
  });
});
