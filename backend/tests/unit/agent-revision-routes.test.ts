import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createAgentRevisionRoutes,
} from "../../src/app/http/routes/agentRevisionRoutes.js";
import { presentRevisionDetail } from "../../src/app/http/routes/agentRevisionPresenters.js";
import {
  parseAgentRevisionSnapshot,
  type AgentRevision,
  type AgentRevisionSnapshot,
} from "../../src/modules/agents/agentRevision.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const otherAgentId = "33333333-3333-4333-8333-333333333333";
const baselineId = "44444444-4444-4444-8444-444444444444";
const candidateId = "55555555-5555-4555-8555-555555555555";
const directiveId = "66666666-6666-4666-8666-666666666666";
const removedDirectiveId = "77777777-7777-4777-8777-777777777777";
const routineLineageId = "88888888-8888-4888-8888-888888888888";
const oldRoutineId = "99999999-9999-4999-8999-999999999999";
const newRoutineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const variableId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const removedVariableId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const directive = (id: string, action: string): AgentRevisionSnapshot["directives"][number] => ({
  id, agentId, name: `directive-${id.slice(0, 4)}`, condition: { kind: "always" }, action,
  priority: null, requiredCapabilities: [], dependsOn: [], excludes: [], routes: [], surfaces: [], tags: [],
  description: null, binding: null, lifecycle: null, enabled: true, metadata: {},
  createdAt: new Date("2026-09-01T00:00:00.000Z"), updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

const routine = (id: string, version: number): AgentRevisionSnapshot["routines"][number] => ({
  id, agentId, lineageId: routineLineageId, version, status: "published", name: "Returns",
  activation: { triggerDescription: "When a customer asks to return an order.", gateRef: null, priority: 1, reentryMode: "always" },
  slots: [], steps: [{ stableStepId: "ask", kind: "chat", instruction: `Ask version ${version}.`, toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
  completionExport: { enabled: false, triggerKinds: [], destinationRef: "" },
  createdAt: new Date("2026-09-01T00:00:00.000Z"), updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

const enablement = (id: string, enabled: boolean): AgentRevisionSnapshot["contextVariableEnablements"][number] => ({
  id: `dddddddd-dddd-4ddd-8ddd-${id.slice(24)}`, agentId, variableId: id, source: "pushed",
  resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "always", enabled,
  createdAt: new Date("2026-09-01T00:00:00.000Z"), updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

const snapshot = (overrides: Partial<AgentRevisionSnapshot> = {}): AgentRevisionSnapshot => parseAgentRevisionSnapshot({
  customInstruction: "baseline instruction",
  directives: [directive(directiveId, "baseline action"), directive(removedDirectiveId, "remove me")],
  routines: [routine(oldRoutineId, 1)],
  contextVariableEnablements: [enablement(variableId, true), enablement(removedVariableId, true)],
  ...overrides,
});

const revision = (input: Partial<AgentRevision> = {}): AgentRevision => ({
  id: candidateId, snapshot: snapshot(), sourceDraftGeneration: 7, sourceBasePublishedRevisionId: baselineId,
  createdAt: new Date("2026-09-08T10:00:00.000Z"), publishedAt: null, publishedVersion: null, ...input,
});

describe("agent revision presenters", () => {
  it("diffs an immutable revision against its own saved base with stable labels", () => {
    const base = revision({ id: baselineId, sourceDraftGeneration: 6, sourceBasePublishedRevisionId: null, publishedAt: new Date("2026-09-07T10:00:00.000Z"), publishedVersion: 2 });
    const candidate = revision({
      snapshot: snapshot({
        customInstruction: "candidate instruction",
        directives: [directive(directiveId, "candidate action")],
        routines: [routine(newRoutineId, 2)],
        contextVariableEnablements: [enablement(variableId, true), enablement(removedVariableId, false)],
      }),
    });

    expect(presentRevisionDetail(candidate, base)).toMatchObject({
      label: "Draft · 2026-09-08T10:00:00.000Z",
      enabledContextVariableIds: [variableId],
      scopedChanges: {
        customInstruction: { before: "baseline instruction", after: "candidate instruction", changed: true },
        directives: [
          { id: directiveId, change: "changed", before: expect.objectContaining({ action: "baseline action" }), after: expect.objectContaining({ action: "candidate action" }) },
          { id: removedDirectiveId, change: "removed", before: expect.objectContaining({ action: "remove me" }) },
        ],
        routines: [{ definitionId: newRoutineId, change: "changed", before: expect.objectContaining({ id: oldRoutineId, version: 1 }), after: expect.objectContaining({ id: newRoutineId, version: 2 }) }],
        contextVariableEnablements: [{ contextVariableId: removedVariableId, change: "removed" }],
      },
    });
  });

  it("reports configuration changes for context variables that remain enabled", () => {
    const base = revision({ id: baselineId, sourceDraftGeneration: 6, sourceBasePublishedRevisionId: null });
    const candidate = revision({
      snapshot: snapshot({
        contextVariableEnablements: [
          { ...enablement(variableId, true), source: "resolver", surfacing: "operator_only" },
          enablement(removedVariableId, true),
        ],
      }),
    });

    expect(presentRevisionDetail(candidate, base).scopedChanges.contextVariableEnablements).toContainEqual({
      contextVariableId: variableId,
      change: "changed",
      before: expect.objectContaining({ source: "pushed", surfacing: "always", enabled: true }),
      after: expect.objectContaining({ source: "resolver", surfacing: "operator_only", enabled: true }),
    });
  });

  it("uses only an allocated published version in human-facing release labels", () => {
    expect(presentRevisionDetail(revision({ publishedAt: new Date("2026-09-08T11:00:00.000Z"), publishedVersion: 3 }), null))
      .toMatchObject({ label: "v3", versionNumber: 3 });
    expect(presentRevisionDetail(revision(), null)).toMatchObject({ label: "Draft · 2026-09-08T10:00:00.000Z", versionNumber: null });
  });
});

const createDependencies = (overrides: Record<string, unknown> = {}) => {
  const service = {
    state: vi.fn(async () => ({ agentId, status: "draft_dirty" as const, draft: { generation: 7, basePublishedRevisionId: baselineId, updatedAt: new Date("2026-09-08T10:00:00.000Z") }, publishedRevision: null, canPublish: true })),
    createCandidate: vi.fn(),
    list: vi.fn(async () => [revision(), revision({ id: baselineId, publishedAt: new Date("2026-09-07T10:00:00.000Z") })]),
    detail: vi.fn(async (_workspaceId: string, requestedAgentId: string, revisionId: string) => {
      if (requestedAgentId !== agentId || revisionId === otherAgentId) {
        const error = new Error("Agent revision not found") as Error & { statusCode: number; code: string };
        error.statusCode = 404; error.code = "not_found";
        throw error;
      }
      return revisionId === baselineId ? revision({ id: baselineId, publishedAt: new Date("2026-09-07T10:00:00.000Z") }) : revision();
    }),
    publish: vi.fn(async () => {
      const error = new Error("stale") as Error & { statusCode: number; code: string };
      error.statusCode = 409; error.code = "revision_conflict";
      throw error;
    }),
  };
  return {
    env: { SESSION_COOKIE_NAME: "radioso_session" },
    authService: { authenticateApiToken: vi.fn(async () => ({ accountId: "account-1", workspaceId, principal: { type: "workspace_api_token", role: "admin", tokenId: "token-1", workspaceId } })) },
    workspaceSessionService: {},
    accountAccessService: { requirePermission: vi.fn(async () => undefined), hasPermission: vi.fn(async () => true) },
    agentRepository: { findByIdAndWorkspaceId: vi.fn(async () => ({ proactiveGreetingEnabled: false })) },
    agentRevisionService: service,
    ...overrides,
  };
};

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRevisionRoutes(dependencies as never));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const known = error as { statusCode?: number; code?: string };
    res.status(known.statusCode ?? 500).json({
      error: { code: known.code ?? "internal_error", message: error instanceof Error ? error.message : "Internal server error" },
    });
  });
  return app;
};

describe("agent revision HTTP routes", () => {
  it("does not return candidate records when published history is requested", async () => {
    const dependencies = createDependencies();
    const response = await request(createApp(dependencies))
      .get(`/api/v1/agents/${agentId}/revisions?include=published`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(response.body.revisions).toEqual([expect.objectContaining({ id: baselineId, kind: "published" })]);
  });

  it("keeps release routes behind existing permissions and workspace-agent ownership", async () => {
    const forbidden = createDependencies({ accountAccessService: { requirePermission: vi.fn(async () => { const error = new Error("forbidden") as Error & { statusCode: number; code: string }; error.statusCode = 403; error.code = "forbidden"; throw error; }), hasPermission: vi.fn() } });
    await request(createApp(forbidden)).get(`/api/v1/agents/${agentId}/revisions`).set("Authorization", "Bearer token").expect(403);

    await request(createApp()).get(`/api/v1/agents/${otherAgentId}/revisions/${otherAgentId}`).set("Authorization", "Bearer token").expect(404);
  });

  it("returns the existing stale publication conflict without moving publication behavior into the route", async () => {
    await request(createApp())
      .post(`/api/v1/agents/${agentId}/revisions/${candidateId}/publish`)
      .set("Authorization", "Bearer token")
      .send({ expectedDraftGeneration: 7, expectedPublishedRevisionId: baselineId, idempotencyKey: "release-1" })
      .expect(409, { error: { code: "revision_conflict", message: "stale" } });
  });

  it("returns the original version for an idempotent retry after a later version is current", async () => {
    const v1 = revision({ id: baselineId, publishedAt: new Date("2026-09-07T10:00:00.000Z"), publishedVersion: 1 });
    const v2 = revision({ id: candidateId, publishedAt: new Date("2026-09-08T10:00:00.000Z"), publishedVersion: 2 });
    const dependencies = createDependencies({
      agentRevisionService: {
        publish: vi.fn(async () => ({ publicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", publishedAt: v1.publishedAt!, revisionId: v1.id, idempotentReplay: true })),
        state: vi.fn(async () => ({ agentId, status: "draft_clean", draft: { generation: 8, basePublishedRevisionId: v2.id, updatedAt: new Date() }, publishedRevision: v2, canPublish: true })),
        detail: vi.fn(async () => v1),
      },
      agentRepository: { findByIdAndWorkspaceId: vi.fn(async () => ({ proactiveGreetingEnabled: true })) },
    });
    const response = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/revisions/${baselineId}/publish`)
      .set("Authorization", "Bearer token")
      .send({ expectedDraftGeneration: 7, expectedPublishedRevisionId: null, idempotencyKey: "retry-v1" })
      .expect(200);

    expect(response.body.publication).toMatchObject({ revisionId: baselineId, idempotentReplay: true, revision: { versionNumber: 1, label: "v1" } });
    expect(response.body.state.publishedRevision).toMatchObject({ id: candidateId, versionNumber: 2 });
    expect(response.body.state.proactiveGreetingEnabled).toBe(true);
  });
});
