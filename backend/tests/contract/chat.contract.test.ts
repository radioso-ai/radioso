import { createHmac } from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("chat contract", () => {
  it("lists chat history summaries for the active account", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chat = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ query: "What does this page do?", stream: false });

    const response = await request(app)
      .get("/api/v1/chat/history")
      .set(adminSessionHeaders(session));

    expect(chat.status).toBe(200);
    expect(response.status).toBe(200);
    expect(response.body.conversations).toEqual([
      expect.objectContaining({
        id: chat.body.conversationId,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        preview: expect.any(String),
      }),
    ]);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.hasMore).toBe(false);
  });

  it("returns a conversation history detail with debug metadata", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chat = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ query: "What does this page do?", stream: false });

    const response = await request(app)
      .get(`/api/v1/chat/history/${chat.body.conversationId}`)
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId: chat.body.conversationId,
      workspaceId: expect.any(String),
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "What does this page do?",
        }),
        expect.objectContaining({
          role: "assistant",
          citations: expect.any(Array),
          answerSegments: expect.any(Array),
          debug: expect.objectContaining({
            eventStatus: "success",
            stream: false,
            citationCount: expect.any(Number),
            answerOutcome: expect.any(String),
            validation: expect.objectContaining({
              ran: expect.any(Boolean),
              answerModified: expect.any(Boolean),
              unsupportedSegmentCount: expect.any(Number),
              supportedSegmentCount: expect.any(Number),
              nonSubstantiveSegmentCount: expect.any(Number),
              segmentResults: expect.any(Array),
            }),
            retrievalInfo: expect.objectContaining({
              candidateCounts: expect.any(Object),
            }),
            retrievalTrace: expect.objectContaining({
              stages: expect.any(Array),
            }),
          }),
        }),
      ]),
    });
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.hasOlderMessages).toBe(false);
  });

  it("supports cursor pagination for chat history lists", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat-history-cursor@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    for (const query of ["first", "second", "third"]) {
      await request(app)
        .post("/api/v1/chat/")
        .set(adminSessionHeaders(session))
        .send({ query, stream: false });
    }

    const firstPage = await request(app)
      .get("/api/v1/chat/history?limit=2")
      .set(adminSessionHeaders(session));

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.conversations).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(`/api/v1/chat/history?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set(adminSessionHeaders(session));

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.conversations).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("rejects an invalid history conversation id with a client error", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    const response = await request(app)
      .get("/api/v1/chat/history/not-a-uuid")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
    });
  });

  it("rejects malformed chat history cursors with a client error", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat-bad-cursor@example.com");

    const response = await request(app)
      .get("/api/v1/chat/history?cursor=not-a-cursor")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid cursor",
    });
  });

  it("returns a non-streaming chat response with a conversation id", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ query: "What does this page do?", stream: false });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["answer", "answerSegments", "citations", "conversationId", "retrievalInfo", "retrievalTrace"]);
    expect(response.body.conversationId).toBeDefined();
    expect(response.body.answer).toContain("This page parses content");
    expect(Array.isArray(response.body.citations)).toBe(true);
    expect(Array.isArray(response.body.answerSegments)).toBe(true);
    expect(response.body.answer).not.toContain("[[");
    expect(response.body.answerSegments).toEqual([{ text: expect.any(String), citationIndices: [0] }]);
    expect(response.body.retrievalInfo).toMatchObject({
      candidateCounts: expect.objectContaining({
        semantic: expect.any(Number),
        lexical: expect.any(Number),
        merged: expect.any(Number),
        final: expect.any(Number),
      }),
      rerankStatus: expect.any(String),
      fallbackApplied: expect.any(Boolean),
    });
    expect(response.body.retrievalTrace).toMatchObject({
      stages: expect.any(Array),
    });
  });

  it("creates an assistant-first bootstrap greeting for a new conversation", async () => {
    const bootstrapGateway: ChatGateway = {
      async answer() {
        return "Ciao! Sono Marta e posso aiutarti con i tuoi documenti.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({ chatGateway: bootstrapGateway });
    const session = await issueTestSession(app, "chat-bootstrap@example.com");

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "Marta",
        assistantRole: "Document assistant",
        greetingInstruction: "Warm and concise",
        proactiveGreetingEnabled: true,
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ bootstrapGreeting: true, stream: false, userExpectedLocale: "it-IT" });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("Ciao!");

    const history = await request(app)
      .get(`/api/v1/chat/history/${response.body.conversationId}`)
      .set(adminSessionHeaders(session));

    expect(history.status).toBe(200);
    expect(history.body.messageCount).toBe(1);
    expect(history.body.userMessageCount).toBe(0);
    expect(history.body.assistantMessageCount).toBe(1);
    expect(history.body.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Ciao! Sono Marta e posso aiutarti con i tuoi documenti.",
      }),
    ]);
  }, 10000);

  it("returns 204 for bootstrap startup when assistant bootstrap is inactive", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat-bootstrap-inactive@example.com");

    const response = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ bootstrapGreeting: true, stream: false, userExpectedLocale: "it-IT" });

    expect(response.status).toBe(204);
  });

  it("ignores malformed bootstrap locale hints and falls back safely", async () => {
    const { app } = createTestApp({
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
    const session = await issueTestSession(app, "chat-bootstrap-invalid-locale@example.com");

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "Marta",
        assistantRole: "Document assistant",
        greetingInstruction: "Warm and concise",
        assistantDefaultLocale: "en",
        proactiveGreetingEnabled: true,
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ bootstrapGreeting: true, stream: false, userExpectedLocale: "bad_locale_value" });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("Hello!");
    expect(response.body.conversationId).toEqual(expect.any(String));
  });
  it("returns an SSE response when streaming is requested", async () => {
    const delayedGateway: ChatGateway = {
      async answer(input) {
        return `history:${input.history.length} ${input.prompt}`;
      },
      async *streamAnswer(input) {
        yield "history:0 ";
        await delay(30);
        yield input.prompt;
      },
    };
    const { app } = createTestApp({ chatGateway: delayedGateway });
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
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
    expect(response.body).toContain("event: chunk");
    expect(response.body).toContain("event: done");
    expect(response.body).toContain("\"answer\":");
    expect(response.body).toContain("\"retrievalInfo\":");
    expect(response.body).toContain("\"retrievalTrace\":");
  });

  it("emits chunk data before the stream finishes", async () => {
    const delayedGateway: ChatGateway = {
      async answer() {
        return "streamed answer";
      },
      async *streamAnswer() {
        yield "streamed ";
        await delay(80);
        yield "answer";
      },
    };
    const { app } = createTestApp({ chatGateway: delayedGateway });
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const server = app.listen();

    try {
      const result = await new Promise<{ firstChunkMs: number; doneMs: number; body: string }>((resolve, reject) => {
        const startedAt = Date.now();
        const chunks: string[] = [];
        let firstChunkMs = -1;
        let doneMs = -1;
        const address = server.address();

        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine test server address"));
          return;
        }

        const req = http.request({
          method: "POST",
          host: "127.0.0.1",
          port: address.port,
          path: "/api/v1/chat/",
          headers: {
            Cookie: session.cookie,
            "Content-Type": "application/json",
            "X-Workspace-Id": session.workspaceId,
          },
        }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            chunks.push(chunk);
            if (firstChunkMs === -1 && chunk.includes("event: chunk")) {
              firstChunkMs = Date.now() - startedAt;
            }
            if (chunk.includes("event: done")) {
              doneMs = Date.now() - startedAt;
            }
          });
          res.on("end", () => {
            resolve({
              firstChunkMs,
              doneMs,
              body: chunks.join(""),
            });
          });
          res.on("error", reject);
        });
        req.write(JSON.stringify({ query: "What does this page do?", stream: true }));
        req.end();
        req.on("error", reject);
      });

      expect(result.body).toContain("event: chunk");
      expect(result.body).toContain("event: done");
      expect(result.firstChunkMs).toBeGreaterThanOrEqual(0);
      expect(result.doneMs).toBeGreaterThanOrEqual(result.firstChunkMs);
      expect(result.body.indexOf("event: chunk")).toBeLessThan(result.body.indexOf("event: done"));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("accepts an existing conversation id without changing the request shape", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const first = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ query: "What does this page do?", stream: false });

    const second = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({
        conversationId: first.body.conversationId,
        query: "And what does it answer?",
        stream: false,
      });

    expect(second.status).toBe(200);
    expect(Object.keys(second.body).sort()).toEqual(["answer", "answerSegments", "citations", "conversationId", "retrievalInfo", "retrievalTrace"]);
    expect(second.body.conversationId).toBe(first.body.conversationId);
  });

  it("refuses out-of-corpus questions when only low-similarity partial matches exist", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Cooking Pasta", content: "This guide explains how to cook pasta successfully." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 80,
        similarityThreshold: 0.8,
        rerankTopK: 15,
        citationDisplayEnabled: false,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set(adminSessionHeaders(session))
      .send({ query: "Can you cook Flan?", stream: false });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["answer", "conversationId", "retrievalInfo", "retrievalTrace"]);
    expect(response.body.answer).toContain("couldn't find supporting material");
    expect(response.body).not.toHaveProperty("citations");
    expect(response.body).not.toHaveProperty("answerSegments");
    expect(response.body.retrievalInfo).toMatchObject({
      candidateCounts: expect.any(Object),
      fallbackApplied: expect.any(Boolean),
      rerankStatus: expect.any(String),
    });
    expect(response.body.retrievalTrace).toMatchObject({
      stages: expect.any(Array),
    });
  });

  it("includes sourceChannel in history summaries so admins can identify anonymous conversations", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "chat@example.com");

    // Enable anonymous chat
    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true, anonymousRateLimit: 10 });

    const settings = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));
    const publicUrl = settings.body.anonymousChatUrl as string;
    const publicToken = publicUrl.split("/").pop()!;

    // Ingest a document so chat can answer
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    // Send an anonymous chat message
    const anonChat = await request(app)
      .post(`/api/v1/public/chat/${publicToken}`)
      .send({ query: "What does this page do?", stream: false });
    expect(anonChat.status).toBe(200);

    // Admin lists chat history — should include anonymous conversation with sourceChannel
    const history = await request(app)
      .get("/api/v1/chat/history")
      .set(adminSessionHeaders(session));

    expect(history.status).toBe(200);
    expect(history.body.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: anonChat.body.conversationId,
          sourceChannel: "anonymous",
          messageCount: 2,
        }),
      ]),
    );
  });

  it("includes embedded source website in history summaries for embedded chats", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "embed-history@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });

    const embedToken = settings.body.websiteEmbedToken as string;
    const launchOrigin = "https://example.com";
    const launchSignature = createHmac("sha256", "00112233445566778899aabbccddeeff")
      .update(`${embedToken}:${launchOrigin}`)
      .digest("hex");

    const embedSession = await request(app)
      .post(`/api/v1/public/embed/${embedToken}/session`)
      .set("x-radioso-embed-origin", launchOrigin)
      .set("x-radioso-embed-signature", launchSignature);

    const embeddedChat = await request(app)
      .post(`/api/v1/public/chat/${embedSession.body.publicChatToken}`)
      .set("x-radioso-embed-session", embedSession.body.embedSessionToken)
      .send({ query: "What does this page do?", stream: false });

    expect(embeddedChat.status).toBe(200);

    const history = await request(app)
      .get("/api/v1/chat/history")
      .set(adminSessionHeaders(session));

    expect(history.status).toBe(200);
    expect(history.body.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: embeddedChat.body.conversationId,
          sourceChannel: "website_embed",
          sourceOrigin: "https://example.com",
        }),
      ]),
    );
  });

  it("documents the chat history endpoints in the shared OpenAPI contract", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/chat/history:");
    expect(spec).toContain("/api/v1/chat/history/{conversationId}:");
    expect(spec).toContain("ChatHistoryListResponse:");
    expect(spec).toContain("ChatConversationDetail:");
    expect(spec).toContain("ChatConversationMessageDebug:");
    expect(spec).toContain("answerOutcome:");
    expect(spec).toContain("segmentResults:");
    expect(spec).toContain("RetrievalTrace:");
  });
});
