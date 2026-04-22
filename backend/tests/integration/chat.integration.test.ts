import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type { RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";
import { retrievalFixtureDocuments } from "../support/retrievalFixtures.js";

describe("chat integration", () => {
  it("adds bounded grounded continuations for guided and exploratory modes", async () => {
    const deterministicGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          if (prompt.includes("Conversation mode:\nguided")) {
            return JSON.stringify({
              suggestions: [
                { text: "What parser rules do the docs cover?", contextIndex: 1 },
                { text: "Which onboarding questions are answered?", contextIndex: 2 },
              ],
            });
          }

          return JSON.stringify({
            suggestions: [
              { text: "What parser rules do the docs cover?", contextIndex: 1 },
              { text: "Which onboarding questions are answered?", contextIndex: 2 },
            ],
          });
        }
        return "The testing guide explains testing and parsing content for users[[1]].";
      },
      async *streamAnswer() {
        yield "The testing guide explains testing and parsing content for users[[1]].";
      },
    };
    const { app } = createTestApp({ chatGateway: deterministicGateway });

    const { token } = await issueTestToken(app, "conversation-modes@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      { title: "Testing Guide", content: "The testing docs cover testing and parsing content for users." },
      { title: "Parser Notes", content: "The testing docs cover parser validation rules and supported input formats." },
      { title: "User FAQ", content: "The testing docs cover common user questions and onboarding tips." },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    const ask = async (conversationMode: "factual" | "guided" | "exploratory") => {
      await request(app)
        .put("/api/v1/settings/retrieval")
        .set("Authorization", authorization)
        .send({
          queryRewriteEnabled: false,
          suggestedQuestionsEnabled: true,
          suggestedQuestionsCount: 4,
          rerankEnabled: false,
          vectorTopK: 20,
          similarityThreshold: 0.1,
          rerankTopK: 5,
          citationDisplayEnabled: true,
          conversationMode,
        });

      return request(app)
        .post("/api/v1/chat/")
        .set("Authorization", authorization)
        .send({ query: "What do the testing docs cover?", stream: false });
    };

    const factual = await ask("factual");
    const guided = await ask("guided");
    const exploratory = await ask("exploratory");

    expect(factual.status).toBe(200);
    expect(guided.status).toBe(200);
    expect(exploratory.status).toBe(200);

    expect(factual.body.answer).toBe("The testing guide explains testing and parsing content for users.");
    expect(guided.body.answer).toContain("The testing guide explains testing and parsing content for users.");
    expect(exploratory.body.answer).toContain("The testing guide explains testing and parsing content for users.");
    expect(factual.body.answer).not.toContain("\n- ");
    expect(guided.body.answer).not.toContain("\n- ");
    expect(guided.body.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Which onboarding questions are answered?" }),
      ]),
    );
    expect(guided.body.suggestions.length).toBeGreaterThan(0);
    expect(guided.body.conversationModeMetadata).toMatchObject({
      conversationMode: "guided",
      expansionApplied: true,
      expansionKind: "focused",
      suggestionCount: guided.body.suggestions.length,
    });
    expect(exploratory.body.answer).not.toContain("\n- ");
    expect(exploratory.body.suggestions.length).toBeGreaterThan(0);
    expect(exploratory.body.conversationModeMetadata).toMatchObject({
      conversationMode: "exploratory",
      expansionApplied: true,
      expansionKind: "expansive",
      suggestionCount: exploratory.body.suggestions.length,
    });
  });

  it("suppresses suggested questions when the setting is disabled", async () => {
    const deterministicGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [{ text: "What parser rules apply?", contextIndex: 1 }],
          });
        }
        return "The testing guide explains testing and parsing content for users[[1]].";
      },
      async *streamAnswer() {
        yield "The testing guide explains testing and parsing content for users[[1]].";
      },
    };
    const { app } = createTestApp({ chatGateway: deterministicGateway });

    const { token } = await issueTestToken(app, "conversation-modes-disabled@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Testing Guide",
        content: "The testing docs cover testing and parsing content for users.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        conversationMode: "exploratory",
        suggestedQuestionsEnabled: false,
        suggestedQuestionsCount: 4,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        citationDisplayEnabled: true,
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What do the testing docs cover?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.suggestions).toBeUndefined();
    expect(response.body.conversationModeMetadata).toMatchObject({
      conversationMode: "exploratory",
      expansionApplied: false,
      suggestionCount: 0,
    });
  });

  it("creates a new conversation and reuses it on follow-up questions", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "followup@example.com");
    const authorization = `Bearer ${token}`;

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
    expect(second.body.answer).toContain("The page explains testing and parsing content for users");
  });

  it("returns a safe answer when no relevant chunks are found", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "empty@example.com");

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "What is the capital of France?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe(
      "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    );
  });

  it("returns an actionable provider setup error when the model provider rejects credentials", async () => {
    const failingGateway: ChatGateway = {
      async answer() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
      async *streamAnswer() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
    };
    const { app } = createTestApp({ chatGateway: failingGateway });

    const { token } = await issueTestToken(app, "provider-error@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "service_unavailable",
        message: "The configured AI provider rejected the credentials. Update backend/.env and restart Radioso.",
      },
    });
  });

  it("returns a normal JSON 500 when streaming fails before the first SSE event", async () => {
    const { app, dependencies } = createTestApp();

    dependencies.chatService.streamAnswer = async function* () {
      throw new Error("stream setup failed");
    };

    const { token } = await issueTestToken(app, "stream-route-error@example.com");

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "What does the page explain?", stream: true });

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    });
  });

  it("omits unsupported substantive content from mixed-support answers before delivery", async () => {
    const mixedGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. ";
        yield "It also offers 24/7 phone support.";
      },
    };
    const { app } = createTestApp({ chatGateway: mixedGateway });

    const { token } = await issueTestToken(app, "mixed-support@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("The page explains testing and parsing content for users.");
    expect(response.body.answer).not.toContain("24/7 phone support");
    expect(response.body.answerSegments).toEqual([
      { text: "The page explains testing and parsing content for users", citationIndices: [0] },
      { text: "." },
    ]);
  });

  it("turns fully unsupported grounded drafts into a conversational grounded miss", async () => {
    const unsupportedGateway: ChatGateway = {
      async answer() {
        return "It also offers 24/7 phone support and a discount code.";
      },
      async *streamAnswer() {
        yield "It also offers 24/7 phone support and a discount code.";
      },
    };
    const { app } = createTestApp({ chatGateway: unsupportedGateway });

    const { token } = await issueTestToken(app, "fully-unsupported@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe(
      `I couldn't verify that from your workspace documents, but I did find related material in "Guide" if you'd like to explore that instead.`,
    );
    expect(response.body.answer).not.toContain("discount code");
  });

  it("uses exploratory recovery without leaking unsupported claims", async () => {
    const unsupportedGateway: ChatGateway = {
      async answer() {
        return "It also offers 24/7 phone support and a discount code.";
      },
      async *streamAnswer() {
        yield "It also offers 24/7 phone support and a discount code.";
      },
    };
    const { app } = createTestApp({ chatGateway: unsupportedGateway });

    const { token } = await issueTestToken(app, "unsupported-exploratory@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      { title: "Guide", content: "The testing docs cover testing and parsing content for users." },
      { title: "Parser Notes", content: "The testing docs cover parser validation rules and supported input formats." },
      { title: "User FAQ", content: "The testing docs cover common user questions and onboarding tips." },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        conversationMode: "exploratory",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What do the testing docs cover?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain(`I couldn't verify that from your workspace documents`);
    expect(response.body.answer).not.toContain("\n- ");
    expect(response.body.answer).not.toContain("discount code");
    expect(response.body.answer).not.toContain("24/7 phone support");
  });

  it("keeps conversations account scoped", async () => {
    const { app } = createTestApp();

    const { token: firstToken } = await issueTestToken(app, "scope-a@example.com");
    const { token: secondToken } = await issueTestToken(app, "scope-b@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ title: "A", content: "Account A data only." });

    const firstChat = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ query: "What data is here?", stream: false });
    const secondChat = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", `Bearer ${secondToken}`)
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

    const { token } = await issueTestToken(app, "profiles@example.com");
    const authorization = `Bearer ${token}`;

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

    const { token } = await issueTestToken(app, "diagnostics@example.com");
    const authorization = `Bearer ${token}`;

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
      rewrite: {
        status: expect.any(String),
        eligible: expect.any(Boolean),
        ran: expect.any(Boolean),
        materialDisagreement: expect.any(Boolean),
      },
    });
    expect(response.body.retrievalTrace).toMatchObject({
      stages: expect.any(Array),
    });
    expect(chatAudit?.metadata?.retrieval).toMatchObject({
      rewriteStatus: expect.any(String),
      rerankStatus: expect.any(String),
      originalCandidateCount: expect.any(Number),
      normalizedCandidateCount: expect.any(Number),
      finalContextCount: expect.any(Number),
      queryEmbeddingDurationMs: expect.any(Number),
      rewriteEligible: expect.any(Boolean),
      rewriteRan: expect.any(Boolean),
    });
    expect(chatAudit?.metadata).toMatchObject({
      assistantMessageId: expect.any(String),
      conversationId: response.body.conversationId,
      stream: false,
    });
  });

  it("records validator-triggered degradation in assistant-turn audit metadata", async () => {
    const mixedGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. ";
        yield "It also offers 24/7 phone support.";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: mixedGateway });

    const { token } = await issueTestToken(app, "degraded-outcome@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    const chatAudit = [...auditEvents].reverse().find((event) => event.eventType === "chat.answer");

    expect(response.status).toBe(200);
    expect(chatAudit?.metadata).toMatchObject({
      answerOutcome: "grounded_degraded_unsupported_segments",
      validation: {
        ran: true,
        answerModified: true,
        unsupportedSegmentCount: 1,
        substantiveUnsupportedSegmentCount: 1,
        supportedSegmentCount: 1,
        nonSubstantiveSegmentCount: expect.any(Number),
      },
    });
    const validation = chatAudit?.metadata?.validation as
      | { segmentResults?: Array<Record<string, unknown>> }
      | undefined;
    expect(validation?.segmentResults?.every((segment) => !("content" in segment))).toBe(true);
    expect(validation?.segmentResults?.every((segment) => "originalText" in segment)).toBe(true);
  });

  it("keeps no-context refusals distinct from validator-triggered degradation in audit metadata", async () => {
    const { app, dependencies } = createTestApp();

    const { token } = await issueTestToken(app, "no-context-outcome@example.com");
    const authorization = `Bearer ${token}`;

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What is the capital of France?", stream: false });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    const chatAudit = [...auditEvents].reverse().find((event) => event.eventType === "chat.answer");

    expect(response.status).toBe(200);
    expect(chatAudit?.metadata).toMatchObject({
      answerOutcome: "no_context_refusal",
      validation: {
        ran: false,
        answerModified: false,
        unsupportedSegmentCount: 0,
        substantiveUnsupportedSegmentCount: 0,
        supportedSegmentCount: 0,
        nonSubstantiveSegmentCount: 0,
      },
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

    const { token } = await issueTestToken(app, "history-failure@example.com");
    const authorization = `Bearer ${token}`;

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
    expect(detail.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "What does the page explain?" }),
      ]),
    );
    expect(detail.body.messages.some((message: { role: string }) => message.role === "assistant")).toBe(false);
  });

  it("preserves ambiguity for unresolved relation follow-ups", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite() {
          return {
            rewrittenQuery: "Does Narayani work with Arudra?",
            turnKind: "referential_relation",
            proposedActiveSubject: "Narayani",
            relatedEntities: ["Arudra"],
            unresolved: true,
            confidence: 0.62,
          };
        },
      },
    });

    const { token } = await issueTestToken(app, "ambiguity@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Narayani", content: "Narayani is a teacher and speaker." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const first = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Tell me about Narayani", stream: false });
    const second = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        query: "Does she work with Arudra?",
        stream: false,
      });

    expect(second.status).toBe(200);
    expect(second.body.retrievalInfo.rewrite).toMatchObject({
      status: "applied",
      eligible: true,
      ran: true,
      materialDisagreement: false,
      continuityDecision: "unresolved",
    });
  });

  it("uses rewritten retrieval for unresolved single-subject followups", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite() {
          return {
            rewrittenQuery: "Can I buy Narayani's book La mia anima ricorda Swami Kriyananda?",
            turnKind: "referential_followup",
            proposedActiveSubject: "Narayani",
            relatedEntities: [],
            unresolved: true,
            confidence: 0.62,
          };
        },
      },
    });

    const { token } = await issueTestToken(app, "book-followup@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Narayani Anaya Archivi - Ananda Edizioni",
        content:
          "Narayani Anaya. La mia anima ricorda Swami Kriyananda. Aggiungi al carrello. Prezzo 18,00 euro.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Narayani Profile",
        content: "Narayani is the author of La mia anima ricorda Swami Kriyananda.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const first = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "Who is Narayani?", stream: false });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        query: "Can I buy her book?",
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.retrievalInfo.rewrite).toMatchObject({
      status: "applied",
      eligible: true,
      ran: true,
    });
  });

  it("returns the exact-match source for identifier-style queries", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "identifiers@example.com");
    const authorization = `Bearer ${token}`;

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

  it("applies persisted retrieval settings without adding tone markers to answers", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "answer-settings@example.com");
    const authorization = `Bearer ${token}`;

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
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({ query: "What does the page explain?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("The page explains testing and parsing content for users");
  });

  it("omits citation metadata when citation display is disabled", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "no-citations@example.com");
    const authorization = `Bearer ${token}`;

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

    const { token } = await issueTestToken(app, "rerank-failure@example.com");
    const authorization = `Bearer ${token}`;

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

    const { token } = await issueTestToken(app, "lexical-off@example.com");
    const authorization = `Bearer ${token}`;

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

  it("accepts metadataFilter in the request body and returns a successful response", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "metadata-filter@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "English Guide",
        content: "This guide covers the English API documentation for external users.",
        metadata: { language: "en" },
      });

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Spanish Guide",
        content: "Esta guía cubre la documentación de la API en español para usuarios externos.",
        metadata: { language: "es" },
      });

    // The in-memory fake does not apply @> JSON containment filtering on chunk metadata,
    // so we cannot assert that only English chunks are returned here. The test verifies
    // that metadataFilter is a valid request field that is accepted without errors and
    // that the pipeline runs to completion.
    const response = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "What does the guide cover?",
        stream: false,
        metadataFilter: { language: "en" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("answer");
    expect(response.body).toHaveProperty("conversationId");
    expect(response.body).toHaveProperty("retrievalInfo");
    expect(response.body).toHaveProperty("retrievalTrace");
  });

  it("handles legacy chunks without search text or structured attributes", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "legacy-chunks@example.com");
    const authorization = `Bearer ${token}`;

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

});
