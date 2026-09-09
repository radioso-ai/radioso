import request from "supertest";
import { describe, expect, it } from "vitest";

import { conflict, notFound } from "../../src/shared/domain/errors.js";
import type { TestExecutionService } from "../../src/modules/test-execution/testExecution.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const agentId = "10000000-0000-4000-8000-000000000001";
const executionId = "20000000-0000-4000-8000-000000000001";
const turnId = "30000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";

describe("test execution HTTP streaming", () => {
  it("reads private test history through the existing operator permission boundary", async () => {
    const revision = { id: "50000000-0000-4000-8000-000000000001", label: "v2", versionNumber: 2, kind: "published" as const, createdAt: "2026-09-08T10:00:00.000Z", publishedAt: "2026-09-08T10:00:00.000Z" };
    const execution = { id: executionId, generation: 1, mode: "single" as const, state: "partial" as const, createdAt: new Date("2026-09-08T10:01:00.000Z"), testValues: [{ name: "tier", value: "gold" }], sides: [{ id: "50000000-0000-4000-8000-000000000002", revision: { id: revision.id, publishedVersion: 2, publishedAt: new Date(revision.publishedAt), createdAt: new Date(revision.createdAt), snapshot: { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] }, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null }, conversationId: "50000000-0000-4000-8000-000000000003", state: "ready" as const, retryable: false, history: [{ turnId, attemptId, role: "user" as const, content: "hello", createdAt: new Date("2026-09-08T10:01:01.000Z") }], continuation: null }] };
    const testExecutionService = { list: async () => ({ executions: [execution], nextCursor: null, hasMore: false }), detail: async () => ({ execution, attempts: [{ executionId, sideId: execution.sides[0].id, turnId, attemptId, fence: 1, state: "failed" as const, failureCode: "provider_timeout", leaseExpiresAt: new Date("2026-09-08T10:02:00.000Z"), createdAt: new Date("2026-09-08T10:01:01.000Z"), updatedAt: new Date("2026-09-08T10:01:02.000Z") }] }), retainSide: async () => execution } as unknown as TestExecutionService;
    const { app } = createTestApp({ testExecutionService });
    const session = await issueTestSession(app);

    await request(app).get(`/api/v1/agents/${agentId}/test-executions`).expect(401);
    const list = await request(app).get(`/api/v1/agents/${agentId}/test-executions`).set(adminSessionHeaders(session)).expect(200);
    expect(list.body).toMatchObject({ executions: [expect.objectContaining({ id: executionId, sides: [expect.objectContaining({ revision, state: "ready" })] })] });
    const detail = await request(app).get(`/api/v1/agents/${agentId}/test-executions/${executionId}`).set(adminSessionHeaders(session)).expect(200);
    expect(detail.body).toMatchObject({ execution: expect.objectContaining({ testValues: [{ name: "tier", value: "gold" }], sides: [expect.objectContaining({ state: "ready" })], attempts: [expect.objectContaining({ attemptId, failureCode: "provider_timeout" })] }) });
    const retained = await request(app).post(`/api/v1/agents/${agentId}/test-executions/${executionId}/sides/${execution.sides[0].id}/retain`).set(adminSessionHeaders(session)).expect(201);
    expect(retained.body).toMatchObject({ id: executionId, sides: [expect.objectContaining({ conversationId: execution.sides[0].conversationId })] });
  });

  it("sends the SSE and reverse-proxy buffering headers after its pre-header check", async () => {
    const testExecutionService = {
      async *streamMessage() {
        yield { type: "side_started", executionId, generation: 1, turnId, attemptId, sideId: "50000000-0000-4000-8000-000000000001" };
      },
    } as unknown as TestExecutionService;
    const { app } = createTestApp({ testExecutionService });
    const session = await issueTestSession(app);

    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/test-executions/${executionId}/messages`)
      .set(adminSessionHeaders(session))
      .send({ message: "hello", executionGeneration: 1, turnId, attemptId });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["x-accel-buffering"]).toBe("no");
  });

  it.each([
    ["missing execution", notFound("Test execution is unavailable."), 404, "not_found"],
    ["stale generation", conflict("Test execution generation is stale."), 409, "conflict"],
  ])("returns %s as JSON before committing SSE headers", async (_name, error, status, code) => {
    const testExecutionService = {
      async *streamMessage() { throw error; },
    } as unknown as TestExecutionService;
    const { app } = createTestApp({ testExecutionService });
    const session = await issueTestSession(app);

    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/test-executions/${executionId}/messages`)
      .set(adminSessionHeaders(session))
      .send({ message: "hello", executionGeneration: 1, turnId, attemptId });

    expect(response.status).toBe(status);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.headers["x-accel-buffering"]).toBeUndefined();
    expect(response.body).toMatchObject({ error: { code } });
  });
});
