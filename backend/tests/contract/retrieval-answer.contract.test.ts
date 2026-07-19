import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";

describe("retrieval answer contract", () => {
  it("does not infer REST citations for an anchor-free answer", async () => {
    const gateway: ChatGateway = {
      async answer() {
        return "The advanced workshop runs in June.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({ chatGateway: gateway });
    const session = await issueTestSession(app, "retrieval-explicit-citations@example.com");
    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Course Calendar", content: "The advanced workshop runs in June." });

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(adminSessionHeaders(session))
      .send({ query: "When does the advanced workshop run?" });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("The advanced workshop runs in June.");
    expect(response.body).not.toHaveProperty("citations");
    expect(response.body).not.toHaveProperty("groundingVerdict");
    expect(response.body).not.toHaveProperty("groundingDiagnostics");
  });

  it("returns a grounded answer without assistant conversation ownership", async () => {
    const { app, repositories } = createTestApp();
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
    });
    expect(response.body).not.toHaveProperty("evidence");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body).not.toHaveProperty("debug");
    expect(response.body).not.toHaveProperty("conversationId");

    const debugResponse = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(adminSessionHeaders(session))
      .send({
        query: "When does the advanced workshop run?",
        includeDebug: true,
      });

    expect(debugResponse.status).toBe(200);
    expect(debugResponse.body.debug).toMatchObject({
      evidence: [
        expect.objectContaining({
          documentId: expect.any(String),
          chunkId: expect.any(String),
          content: expect.stringContaining("advanced workshop"),
        }),
      ],
      activitySummary: expect.objectContaining({
        candidateCounts: expect.any(Object),
        execution: {
          surface: "retrieval",
          path: "retrieval_answer",
          retrievalInvoked: true,
        },
      }),
      activityTrace: expect.objectContaining({
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
            supportStatus: expect.any(String),
          }),
        }),
      }),
      }),
    });
    expect(debugResponse.body.debug.activityTrace.stages).toEqual(
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
    expect(debugResponse.body).not.toHaveProperty("conversationId");

    const auditEvents = repositories.auditEventRepository.items.filter(
      (event) => event.eventType === "retrieval.answer",
    );
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        eventStatus: "success",
        workspaceId: session.workspaceId,
        metadata: expect.objectContaining({
          outcome: "answer",
          execution: expect.objectContaining({ surface: "retrieval", path: "retrieval_answer" }),
          query: "When does the advanced workshop run?",
        }),
      }),
      expect.objectContaining({
        eventStatus: "success",
        workspaceId: session.workspaceId,
        metadata: expect.objectContaining({
          outcome: "answer",
          execution: expect.objectContaining({ surface: "retrieval", path: "retrieval_answer" }),
          query: "When does the advanced workshop run?",
        }),
      }),
    ]);
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
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "answer",
      debug: {
        activitySummary: {
          execution: {
            surface: "mcp_capability",
            path: "mcp_grounded_answer",
            retrievalInvoked: true,
          },
        },
        activityTrace: {
          summary: {
            execution: {
              surface: "mcp_capability",
              path: "mcp_grounded_answer",
              retrievalInvoked: true,
            },
          },
        },
      },
    });
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
  });

  it("omits MCP diagnostics from REST responses unless requested", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-mcp-default@example.com");

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
    });
    expect(response.body).not.toHaveProperty("debug");
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
  });

  it("returns MCP capability diagnostics when requested", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-mcp-debug@example.com");

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
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "answer",
      debug: {
        activitySummary: {
          execution: {
            surface: "mcp_capability",
            path: "mcp_grounded_answer",
            retrievalInvoked: true,
          },
        },
        activityTrace: {
          summary: {
            execution: {
              surface: "mcp_capability",
              path: "mcp_grounded_answer",
              retrievalInvoked: true,
            },
          },
        },
      },
    });

    const auditEvents = repositories.auditEventRepository.items.filter(
      (event) => event.eventType === "retrieval.answer",
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.metadata).toMatchObject({
      outcome: "answer",
      execution: expect.objectContaining({ surface: "mcp_capability", path: "mcp_grounded_answer" }),
    });
  });

  it("attempts retrieval for conversational requests instead of rejecting them", async () => {
    const { app, dependencies } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            turnKind: "fresh_subject",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.95,
          };
        },
      },
    });
    const session = await issueTestSession(app, "retrieval-unsupported@example.com");
    const agent = await dependencies.agentService.resolve(session.workspaceId);
    await dependencies.agentService.update(session.workspaceId, agent.id, {
      skillSettings: {
        "retrieval.answer": {
          queryRewriteEnabled: true,
        },
      },
    });

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(adminSessionHeaders(session))
      .send({
        query: "thanks!",
      });

    expect(response.status).toBe(200);
    // Retrieval no longer classifies turn intent; a conversational query is
    // attempted as a retrieval query rather than returned as "unsupported".
    expect(response.body.outcome).toBe("answer");
    expect(response.body).not.toHaveProperty("code");
  });

  it("documents retrieval answer in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/retrieval/answer:");
    expect(spec).toContain("RetrievalAnswerRequest:");
    expect(spec).toContain("RetrievalAnswerResponse:");
  });
});
