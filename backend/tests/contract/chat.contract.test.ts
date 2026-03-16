import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
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
  it("lists chat history summaries for the active account", async () => {
    const { app } = createTestApp();
    const token = await getBearerToken(app);
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chat = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does this page do?", stream: false });

    const response = await request(app)
      .get("/api/v1/chat/history")
      .set("Authorization", authorization);

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
  });

  it("returns a conversation history detail with debug metadata", async () => {
    const { app } = createTestApp();
    const token = await getBearerToken(app);
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Intro", content: "This page parses content and answers questions." });

    const chat = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does this page do?", stream: false });

    const response = await request(app)
      .get(`/api/v1/chat/history/${chat.body.conversationId}`)
      .set("Authorization", authorization);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId: chat.body.conversationId,
      accountId: expect.any(String),
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: [
        expect.objectContaining({
          role: "user",
          content: "What does this page do?",
        }),
        expect.objectContaining({
          role: "assistant",
          debug: expect.objectContaining({
            eventStatus: "success",
            stream: false,
            citationCount: expect.any(Number),
            retrievalInfo: expect.objectContaining({
              candidateCounts: expect.any(Object),
            }),
          }),
        }),
      ],
    });
  });

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
    expect(Object.keys(response.body).sort()).toEqual(["answer", "answerSegments", "citations", "conversationId", "retrievalInfo"]);
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
    expect(response.body).toContain("event: chunk");
    expect(response.body).toContain("event: done");
    expect(response.body).toContain("\"answer\":");
    expect(response.body).toContain("\"retrievalInfo\":");
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
    const token = await getBearerToken(app);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
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
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
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
      expect(result.doneMs).toBeGreaterThan(result.firstChunkMs);
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
    expect(Object.keys(second.body).sort()).toEqual(["answer", "answerSegments", "citations", "conversationId", "retrievalInfo"]);
    expect(second.body.conversationId).toBe(first.body.conversationId);
  });

  it("refuses out-of-corpus questions when only low-similarity partial matches exist", async () => {
    const { app } = createTestApp();
    const token = await getBearerToken(app);
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Cooking Pasta", content: "This guide explains how to cook pasta successfully." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 80,
        similarityThreshold: 0.8,
        rerankTopK: 15,
        warmthLevel: 5,
        citationDisplayEnabled: false,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Can you cook Flan?", stream: false });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["answer", "conversationId", "retrievalInfo"]);
    expect(response.body.answer).toContain("could not find relevant information");
    expect(response.body).not.toHaveProperty("citations");
    expect(response.body).not.toHaveProperty("answerSegments");
    expect(response.body.retrievalInfo).toMatchObject({
      candidateCounts: expect.any(Object),
      fallbackApplied: expect.any(Boolean),
      rerankStatus: expect.any(String),
    });
  });
});
