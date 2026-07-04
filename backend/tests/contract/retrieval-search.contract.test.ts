import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("retrieval search contract", () => {
  it("returns evidence-oriented results without assistant chat fields", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
        metadata: { department: "training" },
      });

    const response = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(session))
      .send({
        query: "advanced workshop next month",
        metadataFilter: { department: "training" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "results",
      rewrittenQuery: {
        semantic: expect.any(String),
        lexical: expect.any(String),
      },
      results: [
        expect.objectContaining({
          documentId: expect.any(String),
          chunkId: expect.any(String),
          title: "Course Calendar",
          content: expect.stringContaining("advanced workshop"),
        }),
      ],
    });
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body).not.toHaveProperty("debug");
    expect(response.body).not.toHaveProperty("conversationId");
    expect(response.body).not.toHaveProperty("route");
  });

  it("returns retrieval search diagnostics only when requested", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search-debug@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
        metadata: { department: "training" },
      });

    const response = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(session))
      .send({
        query: "advanced workshop next month",
        metadataFilter: { department: "training" },
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.debug).toMatchObject({
      activitySummary: expect.objectContaining({
        candidateCounts: expect.any(Object),
        execution: {
          surface: "retrieval",
          path: "retrieval_search",
          retrievalInvoked: true,
        },
      }),
      activityTrace: expect.objectContaining({
        traceId: expect.any(String),
        summary: expect.objectContaining({
          execution: {
            surface: "retrieval",
            path: "retrieval_search",
            retrievalInvoked: true,
          },
        }),
      }),
    });
    expect(response.body.debug.activityTrace.summary).not.toHaveProperty("skillDiagnostic");
    expect(response.body.debug.activityTrace.stages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "shape_selection",
        }),
      ]),
    );
    expect(response.body).not.toHaveProperty("conversationId");
    expect(response.body).not.toHaveProperty("route");
  });

  it("rejects unsupported metadata filter values as a bad request", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search-invalid-filter@example.com");

    const response = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(session))
      .set("content-type", "application/json")
      .send('{"query":"advanced workshop","metadataFilter":{"rank":1e999}}');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "bad_request",
        message: "Invalid request body",
        details: {
          fieldErrors: {
            metadataFilter: ["Metadata filter contains unsupported values"],
          },
        },
      },
    });
  });

  it("documents retrieval search in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/retrieval/search:");
    expect(spec).toContain("RetrievalSearchRequest:");
    expect(spec).toContain("RetrievalSearchResponse:");
  });
});
