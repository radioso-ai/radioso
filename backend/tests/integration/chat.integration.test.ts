import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type { RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { createTestApp } from "../support/testApp.js";
import { retrievalFixtureDocuments } from "../support/retrievalFixtures.js";

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

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

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
    expect(second.body.answer).toContain("Warmth:5");
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

  it("returns grounded answers for strict and broad retrieval profiles", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "profiles@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    for (const document of Object.values(retrievalFixtureDocuments)) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    const strictSettings = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 100,
        similarityThreshold: 0.8,
        rerankTopK: 20,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const strictResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "What is the API rate limit and how long should a client wait before retrying?",
        stream: false,
      });

    const broadSettings = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 100,
        similarityThreshold: 0.2,
        rerankTopK: 20,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const firstFollowUp = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "Tell me about the session cookie",
        stream: false,
      });
    const broadResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        conversationId: firstFollowUp.body.conversationId,
        query: "What is it used for?",
        stream: false,
      });

    expect(strictSettings.status).toBe(200);
    expect(strictResponse.status).toBe(200);
    expect(strictResponse.body.answer).not.toContain("could not find relevant information");
    expect(strictResponse.body.citations[0]?.title).toBe("Rate Limits");

    expect(broadSettings.status).toBe(200);
    expect(broadResponse.status).toBe(200);
    expect(broadResponse.body.answer).not.toContain("could not find relevant information");
    expect(broadResponse.body.citations.some((citation: { title: string }) => citation.title === "Session Cookie")).toBe(
      true,
    );
  });

  it("records retrieval diagnostics for successful chats", async () => {
    const { app, dependencies } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "diagnostics@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.sessionCookie);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 50,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "Tell me about the session cookie",
        stream: false,
      });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    const chatAudit = [...auditEvents].reverse().find((event) => event.eventType === "chat.answer");

    expect(response.status).toBe(200);
    expect(response.body.retrievalInfo).toMatchObject({
      candidateCounts: {
        semantic: expect.any(Number),
        lexical: expect.any(Number),
        merged: expect.any(Number),
        final: expect.any(Number),
      },
      rerankStatus: expect.any(String),
      fallbackApplied: expect.any(Boolean),
    });
    expect(chatAudit?.metadata?.retrieval).toMatchObject({
      rewriteStatus: expect.any(String),
      rerankStatus: expect.any(String),
      originalCandidateCount: expect.any(Number),
      normalizedCandidateCount: expect.any(Number),
      finalContextCount: expect.any(Number),
    });
    expect(chatAudit?.metadata).toMatchObject({
      assistantMessageId: expect.any(String),
      conversationId: response.body.conversationId,
      stream: false,
    });
  });

  it("records a failure turn that can be inspected through history", async () => {
    const failingGateway: ChatGateway = {
      async answer() {
        throw new Error("upstream unavailable");
      },
      async *streamAnswer() {
        throw new Error("upstream unavailable");
      },
    };
    const { app } = createTestApp({ chatGateway: failingGateway });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "history-failure@example.com",
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

    const failure = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(failure.status).toBe(500);

    const history = await request(app)
      .get("/api/v1/chat/history")
      .set("Authorization", authorization);

    expect(history.status).toBe(200);
    expect(history.body.conversations).toHaveLength(1);

    const detail = await request(app)
      .get(`/api/v1/chat/history/${history.body.conversations[0].id}`)
      .set("Authorization", authorization);

    expect(detail.status).toBe(200);
    expect(detail.body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "What does the page explain?" }),
      expect.objectContaining({
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
        debug: expect.objectContaining({
          eventStatus: "failure",
          errorMessage: "upstream unavailable",
        }),
      }),
    ]);
  });

  it("returns the exact-match source for identifier-style queries", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "identifiers@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Feature Flags",
        content: "Flag HVC-42-ALPHA enables the hybrid retrieval rollout path for internal testing environments.",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "What does flag HVC-42-ALPHA enable?",
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).not.toContain("could not find relevant information");
    expect(response.body.citations[0]?.title).toBe("Feature Flags");
  });

  it("applies persisted warmth settings to generated answers", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "warmth@example.com",
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

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 9,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("Warmth:9");
  });

  it("omits citation metadata when citation display is disabled", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "no-citations@example.com",
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

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: false,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("The page explains testing");
    expect(response.body).not.toHaveProperty("citations");
    expect(response.body).not.toHaveProperty("answerSegments");
  });

  it("falls back safely when rerank fails", async () => {
    const failingRerankGateway: RerankGateway = {
      async rerank() {
        throw new Error("rerank failed");
      },
    };
    const { app } = createTestApp({ rerankGateway: failingRerankGateway });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "rerank-failure@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.rateLimits);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 50,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "What is the API rate limit and how long should a client wait before retrying?",
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.citations[0]?.title).toBe("Rate Limits");
    expect(response.body.retrievalInfo.rerankStatus).toBe("fallback");
  });

  it("still answers grounded questions when lexical search is disabled", async () => {
    const { app } = createTestApp({
      lexicalSearch: {
        async search() {
          return [];
        },
      },
    });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "lexical-off@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.rateLimits);

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "What is the API rate limit and how long should a client wait before retrying?",
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.citations[0]?.title).toBe("Rate Limits");
    expect(response.body.retrievalInfo.candidateCounts.lexical).toBe(0);
  });

  it("handles legacy chunks without search text or structured attributes", async () => {
    const { app, repositories } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "legacy-chunks@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    const documentResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.sessionCookie);

    const storedChunks = repositories.chunkRepository.items.get(documentResponse.body.documentId);
    if (storedChunks) {
      repositories.chunkRepository.items.set(
        documentResponse.body.documentId,
        storedChunks.map((chunk) => ({
          ...chunk,
          searchText: null,
          structuredAttributes: null,
        })),
      );
    }

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "Which cookie name is used for browser sessions?",
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).not.toContain("could not find relevant information");
    expect(response.body.citations[0]?.title).toBe("Session Cookie");
  });

  it("keeps single-entity answers anchored to one subject across overlapping chunks", async () => {
    const chatGateway: ChatGateway = {
      async answer(input) {
        return extractRetrievedContext(input.prompt);
      },
      async *streamAnswer(input) {
        yield await this.answer(input);
      },
    };
    const { app } = createTestApp({ chatGateway });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "entity-anchor@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Narayani\nNarayani Anaya wrote My Soul Remembers Swami Kriyananda.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Premi\nIn September 2015 she took the vows as Nayaswami.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Who is Narayani?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("Subject: Narayani");
    expect(response.body.answer).not.toContain("Subject: Premi");
  });

  it("keeps multiple explicitly named subjects available in comparison prompts", async () => {
    const chatGateway: ChatGateway = {
      async answer(input) {
        return extractRetrievedContext(input.prompt);
      },
      async *streamAnswer(input) {
        yield await this.answer(input);
      },
    };
    const { app } = createTestApp({ chatGateway });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "entity-comparison@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Narayani\nNarayani Anaya wrote My Soul Remembers Swami Kriyananda.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Premi\nIn September 2015 she took the vows as Nayaswami.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    const comparisonResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Compare Narayani and Premi", stream: false });

    expect(comparisonResponse.status).toBe(200);
    expect(comparisonResponse.body.answer).toContain("Subject: Narayani");
    expect(comparisonResponse.body.answer).toContain("Subject: Premi");
  });

  it("reuses the grounded subject on a later context-dependent follow-up", async () => {
    const chatGateway: ChatGateway = {
      async answer(input) {
        return extractRetrievedContext(input.prompt);
      },
      async *streamAnswer(input) {
        yield await this.answer(input);
      },
    };
    const { app } = createTestApp({ chatGateway });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "subject-reuse@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Narayani\nNarayani wrote the book My Soul Remembers Swami Kriyananda.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Premi\nPremi teaches chanting and devotion.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    const firstResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Who is Narayani?", stream: false });

    const secondResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        conversationId: firstResponse.body.conversationId,
        query: "Can I buy her book?",
        stream: false,
      });

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body.answer).toContain("Subject: Narayani");
    expect(secondResponse.body.answer).not.toContain("Subject: Premi");
    expect(secondResponse.body.retrievalInfo.continuity).toMatchObject({
      outcome: "reused",
      subject: "Narayani",
    });
  });

  it("replaces the carried subject when the current turn explicitly names a new subject", async () => {
    const chatGateway: ChatGateway = {
      async answer(input) {
        return extractRetrievedContext(input.prompt);
      },
      async *streamAnswer(input) {
        yield await this.answer(input);
      },
    };
    const { app } = createTestApp({ chatGateway });

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "subject-replace@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Narayani\nNarayani wrote the book My Soul Remembers Swami Kriyananda.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Premi\nPremi teaches chanting and devotion.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    const firstResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Who is Narayani?", stream: false });

    const secondResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        conversationId: firstResponse.body.conversationId,
        query: "Who is Premi?",
        stream: false,
      });

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body.answer).toContain("Subject: Premi");
    expect(secondResponse.body.answer).not.toContain("Subject: Narayani");
    expect(secondResponse.body.retrievalInfo.continuity).toMatchObject({
      outcome: "replaced",
      subject: "Premi",
    });
  });

  it("does not hard-stop when retrieval stays split across competing subjects", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "entity-ambiguity@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Premi\nPremi is a Nayaswami teacher who leads devotion and chanting.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "| Generic Catalog |",
        content: "## Clarita\nClarita is a Nayaswami teacher of meditation and healing.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Who is the Nayaswami?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).not.toContain("Please clarify which one you mean");
    expect(response.body.answer).not.toContain("could not find relevant information");
    expect(response.body.citations.length).toBeGreaterThan(0);
  });
});

const extractRetrievedContext = (prompt: string): string => {
  const match = prompt.match(/Retrieved Context:\n([\s\S]*?)\n\nUser Question:/);
  return match?.[1] ?? prompt;
};
