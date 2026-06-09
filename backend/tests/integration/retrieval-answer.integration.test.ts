import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("retrieval answer integration", () => {
  it("answers from retrieval without creating assistant conversation history", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-integration@example.com");
    const { workspaceId } = session;
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
        includeDebug: true,
      })
      .expect(200);

    expect(response.body).toMatchObject({
      outcome: "answer",
      answer: expect.any(String),
      debug: {
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
      },
    });
    expect(response.body).not.toHaveProperty("conversationId");

    const history = await request(app)
      .get("/api/v1/history/chat")
      .set(headers)
      .expect(200);
    expect(history.body.conversations).toEqual([]);
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
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-mcp-integration@example.com");
    const { workspaceId } = session;
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
        includeDebug: true,
      })
      .expect(200);

    expect(response.body.debug.activitySummary.execution).toMatchObject({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
    expect(response.body.debug.activityTrace.summary.execution).toMatchObject({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
  });
});
