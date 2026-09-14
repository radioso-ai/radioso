import request from "supertest";
import { describe, expect, it } from "vitest";

import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

/**
 * Exercises the servability release gate (`AgentRevisionService` wired with a real
 * `RoutineDefinitionService.validateForServing`) over real HTTP against `testApp.ts`'s app,
 * not by calling `AgentRevisionService` directly. `testApp.ts` used to wire `AgentRevisionService`
 * with a fully inert repository stub (`createCandidate`/`publish` always returned "conflict",
 * every read returned null), so this exact wiring regression class — a candidate route that
 * silently never checks servability — was unreachable from any HTTP-level test.
 */
const routineDraftWithBadWebhookRef = (overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
  enabled: true,
  name: "notify-on-complete",
  activation: {
    triggerDescription: "When the user asks to be notified",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [],
  steps: [{
    stableStepId: "step_ask",
    kind: "chat",
    instruction: "Ask what to notify about.",
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_ask",
    toRef: "terminal_complete",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: "Done.",
    ordinal: 1,
  }],
  completionExport: {
    enabled: true,
    triggerKinds: ["complete"],
    // A syntactically valid UUID that was never created as a webhook destination in this
    // workspace: passes draft-write-time structural validation (which only checks format), and
    // is only caught by the servability gate that runs at candidate-creation time.
    destinationRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  ...overrides,
});

type TestApp = ReturnType<typeof createTestApp>["app"];

const createAgentAndRoutine = async (
  app: TestApp,
  headers: Record<string, string>,
  routineOverrides: Partial<RoutineDefinitionDraftInput> = {},
): Promise<{ agentId: string; routineId: string }> => {
  const agent = await request(app).post("/api/v1/agents").set(headers).send({ name: "Notify agent" }).expect(201);
  const routine = await request(app)
    .post(`/api/v1/agents/${agent.body.id}/routines`)
    .set(headers)
    .send(routineDraftWithBadWebhookRef(routineOverrides))
    .expect(201);
  return { agentId: agent.body.id, routineId: routine.body.routine.id };
};

const draftGeneration = async (app: TestApp, headers: Record<string, string>, agentId: string): Promise<number> => {
  const state = await request(app).get(`/api/v1/agents/${agentId}/revision-state`).set(headers).expect(200);
  return state.body.draft.generation;
};

describe("agent revision release gate (HTTP)", () => {
  it("rejects a candidate whose enabled routine references a webhook destination the workspace does not have", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "revision-gate-blocked@example.com");
    const headers = { Authorization: `Bearer ${token}` };

    const { agentId, routineId } = await createAgentAndRoutine(app, headers);
    const expectedDraftGeneration = await draftGeneration(app, headers, agentId);

    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/revisions/candidates`)
      .set(headers)
      .send({ expectedDraftGeneration })
      .expect(422);

    expect(response.body.error.code).toBe("revision_invalid");
    expect(response.body.error.details.diagnostics).toContainEqual(
      expect.objectContaining({
        routineId,
        code: "unknown_webhook_destination",
        location: "completionExport.destinationRef",
      }),
    );
  });

  it("does not block a candidate on a disabled routine's dangling webhook reference", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "revision-gate-disabled-ok@example.com");
    const headers = { Authorization: `Bearer ${token}` };

    const { agentId } = await createAgentAndRoutine(app, headers, { enabled: false });
    const expectedDraftGeneration = await draftGeneration(app, headers, agentId);

    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/revisions/candidates`)
      .set(headers)
      .send({ expectedDraftGeneration })
      .expect(201);

    expect(response.body.candidate.id).toEqual(expect.any(String));
  });
});
