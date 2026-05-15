import request from "supertest";
import { describe, expect, it } from "vitest";

import type { QueryRewriteGateway } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("retrieval answer integration", () => {
  it("answers from retrieval without creating assistant conversation history", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      })
      .expect(202);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .send({
        query: "When does the advanced workshop run?",
      })
      .expect(200);

    expect(response.body).toMatchObject({
      outcome: "answer",
      answer: expect.any(String),
      activitySummary: {
        execution: {
          surface: "retrieval",
          path: "retrieval_answer",
          retrievalInvoked: true,
        },
      },
      activityTrace: {
        summary: {
          execution: {
            surface: "retrieval",
            path: "retrieval_answer",
            retrievalInvoked: true,
          },
        },
      },
    });
    expect(response.body).not.toHaveProperty("conversationId");

    const history = await request(app)
      .get("/api/v1/history/chat")
      .set(headers)
      .expect(200);
    expect(history.body.conversations).toEqual([]);
  });

  it("uses caller-supplied conversation context for retrieval-only rewrite continuity", async () => {
    let observedContextMessages: string[] = [];
    const queryRewriteGateway: QueryRewriteGateway = {
      async rewrite(input) {
        observedContextMessages = input.contextMessages.map((message) => `${message.role}:${message.content}`);
        return {
          rewrittenQuery: "advanced workshop next month returning students",
          semanticQuery: "advanced workshop next month returning students",
          lexicalQuery: "advanced workshop next month",
          turnKind: "referential_followup",
          proposedActiveSubject: "advanced workshop",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.94,
        };
      },
    };
    const { app } = createTestApp({ queryRewriteGateway });
    const session = await issueTestSession(app, "retrieval-answer-context@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      })
      .expect(202);
    await request(app)
      .put("/api/v1/settings/retrieval")
      .set(headers)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        citationDisplayEnabled: true,
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .send({
        query: "What about that one?",
        conversationContext: {
          previousUserMessages: ["Do you have an advanced workshop?"],
          previousAssistantMessages: ["The advanced workshop is available for returning students."],
        },
      })
      .expect(200);

    expect(observedContextMessages).toEqual([
      "user:Do you have an advanced workshop?",
      "assistant:The advanced workshop is available for returning students.",
    ]);
    expect(response.body).toMatchObject({
      outcome: "answer",
      activitySummary: {
        parsedQuery: {
          originalQuery: "What about that one?",
          semanticQuery: "advanced workshop next month returning students",
          lexicalQuery: "advanced workshop next month",
        },
        rewrite: {
          status: "applied",
          eligible: true,
          ran: true,
          continuityDecision: "updated",
        },
        execution: {
          surface: "retrieval",
          path: "retrieval_answer",
          retrievalInvoked: true,
        },
      },
    });
  });

  it("returns typed unsupported outcomes for non-retrieval requests", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            responseIntent: "social_only",
            turnKind: "fresh_subject",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.96,
          };
        },
      },
    });
    const session = await issueTestSession(app, "retrieval-answer-unsupported-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set(headers)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        citationDisplayEnabled: true,
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .send({ query: "thanks for the help" })
      .expect(200);

    expect(response.body).toEqual({
      outcome: "unsupported",
      code: "unsupported_query_type",
      reason: "social_only",
      message: "This request is outside retrieval scope.",
    });
  });

  it("marks MCP capability diagnostics separately from direct retrieval answer clients", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-mcp-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      })
      .expect(202);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .set("x-radioso-capability-client", "mcp")
      .send({
        query: "When does the advanced workshop run?",
      })
      .expect(200);

    expect(response.body.activitySummary.execution).toMatchObject({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
    expect(response.body.activityTrace.summary.execution).toMatchObject({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
  });
});
