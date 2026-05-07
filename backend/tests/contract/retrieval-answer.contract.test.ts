import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("retrieval answer contract", () => {
  it("returns a grounded answer without assistant conversation ownership", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      });

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(adminSessionHeaders(session))
      .send({
        query: "When does the advanced workshop run?",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "answer",
      answer: expect.any(String),
      citations: [
        expect.objectContaining({
          documentId: expect.any(String),
          chunkId: expect.any(String),
          title: "Course Calendar",
        }),
      ],
      evidence: [
        expect.objectContaining({
          documentId: expect.any(String),
          chunkId: expect.any(String),
          content: expect.stringContaining("advanced workshop"),
        }),
      ],
      validation: expect.objectContaining({
        status: expect.any(String),
      }),
      retrievalInfo: expect.objectContaining({
        candidateCounts: expect.any(Object),
        execution: {
          surface: "retrieval",
          path: "retrieval_answer",
          retrievalInvoked: true,
        },
      }),
      retrievalTrace: expect.objectContaining({
        traceId: expect.any(String),
        summary: expect.objectContaining({
          execution: {
            surface: "retrieval",
            path: "retrieval_answer",
            retrievalInvoked: true,
          },
          shapeName: expect.any(String),
          queryShape: expect.any(String),
          resolvedSteps: expect.any(Array),
          skillDiagnostic: expect.objectContaining({
            skillName: "retrieval.answer",
            shapeName: expect.any(String),
            selectionMode: expect.any(String),
            callerSurface: "retrieval_api",
            evidence: expect.objectContaining({
              supportStatus: "supported",
            }),
          }),
        }),
      }),
    });
    expect(response.body.retrievalTrace.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "shape_selection",
          kind: "shape_selection",
          status: "applied",
          outputs: expect.objectContaining({
            shapeName: expect.any(String),
            queryShape: expect.any(String),
            resolvedSteps: expect.any(Array),
          }),
        }),
      ]),
    );
    expect(response.body).not.toHaveProperty("conversationId");
  });

  it("marks MCP capability-originated grounded answers separately from direct retrieval clients", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-mcp@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      });

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(adminSessionHeaders(session))
      .set("x-radioso-capability-client", "mcp")
      .send({
        query: "When does the advanced workshop run?",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "answer",
      retrievalInfo: {
        execution: {
          surface: "mcp_capability",
          path: "mcp_grounded_answer",
          retrievalInvoked: true,
        },
      },
      retrievalTrace: {
        summary: {
          execution: {
            surface: "mcp_capability",
            path: "mcp_grounded_answer",
            retrievalInvoked: true,
          },
        },
      },
    });
  });

  it("returns a typed unsupported result for non-retrieval requests", async () => {
    const { app, dependencies } = createTestApp({
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
            confidence: 0.95,
          };
        },
      },
    });
    const session = await issueTestSession(app, "retrieval-unsupported@example.com");
    const existing = await dependencies.retrievalSettingsService.getForWorkspace(session.workspaceId);
    await dependencies.retrievalSettingsService.updateForWorkspace(session.workspaceId, {
      ...existing,
      queryRewriteEnabled: true,
    });

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(adminSessionHeaders(session))
      .send({
        query: "thanks!",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      outcome: "unsupported",
      code: "unsupported_query_type",
      reason: "social_only",
      message: "This request is outside retrieval scope.",
    });
  });

  it("documents retrieval answer in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/retrieval/answer:");
    expect(spec).toContain("RetrievalAnswerRequest:");
    expect(spec).toContain("RetrievalAnswerResponse:");
    expect(spec).toContain("unsupported_query_type");
  });
});
