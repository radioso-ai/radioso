import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { forbidden } from "../../src/shared/domain/errors.js";
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

  it("reports no agent attribution when the search runs on workspace defaults", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search-unscoped@example.com");

    const response = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(session))
      .send({ query: "advanced workshop" });

    expect(response.status).toBe(200);
    expect(response.body.agentScope).toBeNull();
  });

  it("attributes an agent-scoped search to the agent it measured", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search-scoped@example.com");
    const headers = adminSessionHeaders(session);

    const agent = await request(app)
      .post("/api/v1/agents")
      .set(headers)
      .send({ name: "Support" })
      .expect(201);

    const response = await request(app)
      .post("/api/v1/retrieval/search")
      .set(headers)
      .send({ query: "advanced workshop", agentId: agent.body.id });

    expect(response.status).toBe(200);
    expect(response.body.agentScope).toEqual({ agentId: agent.body.id, retrievalEnabled: true });
  });

  it("fails an agent-scoped search for an unknown agent instead of measuring workspace defaults", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search-missing-agent@example.com");

    const response = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(session))
      .send({ query: "advanced workshop", agentId: "0f7f3d2e-0a0e-4a3f-9d9a-6c2b8f5d1c33" });

    expect(response.status).toBe(404);
  });

  it("requires agent read permission only when an agent is named", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "retrieval-search-agent-permission@example.com");
    const headers = adminSessionHeaders(session);

    const agent = await request(app)
      .post("/api/v1/agents")
      .set(headers)
      .send({ name: "Support" })
      .expect(201);

    const requirePermission = vi.spyOn(dependencies.accountAccessService, "requirePermission")
      .mockImplementation(async ({ permission }) => {
        if (permission === "workspace.agents.read") {
          throw forbidden("You do not have permission to perform this action");
        }
      });

    await request(app)
      .post("/api/v1/retrieval/search")
      .set(headers)
      .send({ query: "advanced workshop" })
      .expect(200);
    await request(app)
      .post("/api/v1/retrieval/search")
      .set(headers)
      .send({ query: "advanced workshop", agentId: agent.body.id })
      .expect(403);

    expect(requirePermission).toHaveBeenCalledWith(expect.objectContaining({ permission: "workspace.agents.read" }));
    requirePermission.mockRestore();
  });

  it("documents retrieval search in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/retrieval/search:");
    expect(spec).toContain("RetrievalSearchRequest:");
    expect(spec).toContain("RetrievalSearchResponse:");
  });

  it("documents the statuses an agent-scoped call can return", () => {
    // The SDK and MCP type snapshots are generated from this spec, so an
    // undocumented status is a status their callers cannot see coming.
    const spec = JSON.parse(
      readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };

    for (const path of ["/api/v1/retrieval/search", "/api/v1/retrieval/answer"]) {
      expect(Object.keys(spec.paths[path].post.responses).sort())
        .toEqual(["200", "400", "401", "403", "404", "429"]);
    }
  });
});
