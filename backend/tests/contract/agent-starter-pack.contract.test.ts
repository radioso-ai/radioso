import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import type { ModelInferenceRequest } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";
import { textResult } from "../support/llmStubs.js";

const routineDraft: RoutineDefinitionDraftInput = {
  enabled: true,
  name: "assist-chosen-name",
  activation: {
    triggerDescription: "Der Besucher möchte einen Termin buchen.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [{
    stableSlotId: "slot_date",
    key: "date",
    type: "text",
    required: true,
    description: "Wunschtermin",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "step_collect_date",
    kind: "chat",
    instruction: "Frage nach dem Wunschtermin {{slot.date}}.",
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_collect_date",
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
    instruction: "Bestätige den Termin am {{slot.date}}.",
    ordinal: 1,
  }],
};

const germanPack = {
  directives: [
    {
      name: "termindetails-bestaetigen",
      condition: { kind: "always" },
      action: "Wiederhole Datum und Uhrzeit und bitte um Bestätigung.",
    },
    {
      name: "keine-diagnosen",
      condition: { kind: "always" },
      action: "Stelle keine Diagnosen, sondern biete einen Termin an.",
    },
  ],
  routine: {
    name: "termin-buchen",
    procedure: "Frage nach dem Wunschtermin und bestätige ihn.",
  },
};

/** Answers each model call by what it is for, the way the real providers would be called. */
const fakeModel = vi.fn(async (input: ModelInferenceRequest) => {
  switch (input.operation.operation) {
    case "response_language_detection":
      return textResult('{"responseLanguage":"German"}');
    case "draft_starter_pack":
      return textResult(JSON.stringify(germanPack));
    default:
      return textResult(JSON.stringify({ draft: routineDraft }));
  }
});

describe("starter pack draft contract", () => {
  it("drafts German directives and exactly one routine without saving anything", async () => {
    const { app } = createTestApp({ chatInferencePipelineComplete: fakeModel });
    const { token } = await issueTestToken(app, "starter-pack-draft@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Zahnarztpraxis" })
      .expect(201);
    const agentPath = `/api/v1/agents/${agent.body.id}`;
    const before = {
      agent: (await request(app).get(agentPath).set("Authorization", authorization).expect(200)).body,
      directives: (await request(app).get(`${agentPath}/directives`).set("Authorization", authorization).expect(200)).body,
      routines: (await request(app).get(`${agentPath}/routines`).set("Authorization", authorization).expect(200)).body,
    };

    const draft = await request(app)
      .post(`${agentPath}/starter-pack/draft`)
      .set("Authorization", authorization)
      .send({ purpose: "Hilf Besuchern unserer Zahnarztpraxis, Termine zu buchen." })
      .expect(200);

    expect(draft.body.outputLanguage).toBe("German");
    const routines = draft.body.items.filter((item: { kind: string }) => item.kind === "routine");
    expect(routines).toHaveLength(1);
    // The routine definition is drafted in its own model call; it gets the same detected language.
    const routineDraftCalls = fakeModel.mock.calls
      .map(([call]) => call)
      .filter((call) => call.operation.operation !== "response_language_detection" && call.operation.operation !== "draft_starter_pack");
    expect(routineDraftCalls.length).toBeGreaterThan(0);
    for (const call of routineDraftCalls) {
      expect(call.prompt).toContain("Write every user-facing field in German.");
    }
    expect(routines[0]).toMatchObject({
      itemKey: "routine-1",
      routine: { name: "termin-buchen", steps: [expect.objectContaining({ stableStepId: "step_collect_date" })] },
      procedure: germanPack.routine.procedure,
      validation: { ok: true, diagnostics: [] },
      conflict: null,
    });
    expect(draft.body.items.filter((item: { kind: string }) => item.kind === "directive")).toEqual([
      expect.objectContaining({ itemKey: "directive-1", directive: expect.objectContaining({ name: "termindetails-bestaetigen" }) }),
      expect.objectContaining({ itemKey: "directive-2", directive: expect.objectContaining({ name: "keine-diagnosen" }) }),
    ]);

    const after = {
      agent: (await request(app).get(agentPath).set("Authorization", authorization).expect(200)).body,
      directives: (await request(app).get(`${agentPath}/directives`).set("Authorization", authorization).expect(200)).body,
      routines: (await request(app).get(`${agentPath}/routines`).set("Authorization", authorization).expect(200)).body,
    };
    expect(after).toEqual(before);
    expect(after.routines.routines).toEqual([]);
  });

  it("applies only the selected suggestions, replays a retry, and refuses a second apply of the same names", async () => {
    const { app } = createTestApp({ chatInferencePipelineComplete: fakeModel });
    const { token } = await issueTestToken(app, "starter-pack-apply@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await request(app).post("/api/v1/agents").set("Authorization", authorization).send({ name: "Praxis" }).expect(201);
    const agentPath = `/api/v1/agents/${agent.body.id}`;
    const draft = await request(app)
      .post(`${agentPath}/starter-pack/draft`)
      .set("Authorization", authorization)
      .send({ purpose: "Hilf Besuchern, Termine zu buchen." })
      .expect(200);
    type DraftItem = { itemKey: string; kind: string; directive?: unknown; routine?: unknown };
    const draftItems = draft.body.items as DraftItem[];
    // The user keeps the second directive and the routine, and drops the first directive.
    const selected = draftItems
      .filter((item) => item.itemKey !== "directive-1")
      .map((item) => item.kind === "directive"
        ? { itemKey: item.itemKey, kind: "directive", directive: item.directive }
        : { itemKey: item.itemKey, kind: "routine", routine: item.routine });
    const body = { idempotencyKey: "contract-apply-0001", items: selected };

    const applied = await request(app).post(`${agentPath}/starter-pack/apply`).set("Authorization", authorization).send(body).expect(201);

    expect(applied.body).toMatchObject({
      replayed: false,
      items: [
        {
          itemKey: "directive-2",
          kind: "directive",
          name: "keine-diagnosen",
          id: expect.any(String),
          coherence: { coherent: expect.any(Boolean), conflicts: expect.any(Array), rationale: expect.any(String) },
        },
        { itemKey: "routine-1", kind: "routine", name: "termin-buchen", id: expect.any(String) },
      ],
    });
    expect(applied.body.items[1]).not.toHaveProperty("coherence");
    const directives = await request(app).get(`${agentPath}/directives`).set("Authorization", authorization).expect(200);
    expect(directives.body.directives.map((item: { name: string }) => item.name)).toEqual(["keine-diagnosen"]);
    const routines = await request(app).get(`${agentPath}/routines`).set("Authorization", authorization).expect(200);
    expect(routines.body.routines.map((item: { name: string }) => item.name)).toEqual(["termin-buchen"]);

    const replay = await request(app).post(`${agentPath}/starter-pack/apply`).set("Authorization", authorization).send(body).expect(200);
    expect(replay.body).toEqual({ ...applied.body, replayed: true });

    const again = await request(app)
      .post(`${agentPath}/starter-pack/apply`)
      .set("Authorization", authorization)
      .send({ ...body, idempotencyKey: "contract-apply-0002" })
      .expect(409);
    expect(again.body.error.code).toBe("starter_pack_name_conflict");
    const directivesAfter = await request(app).get(`${agentPath}/directives`).set("Authorization", authorization).expect(200);
    expect(directivesAfter.body.directives).toHaveLength(1);
  });

  it("returns 404 for an agent outside the caller's workspace", async () => {
    const { app } = createTestApp({ chatInferencePipelineComplete: fakeModel });
    const { token } = await issueTestToken(app, "starter-pack-missing@example.com");

    const response = await request(app)
      .post("/api/v1/agents/11111111-1111-4111-8111-111111111111/starter-pack/draft")
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "Help visitors book appointments." })
      .expect(404);

    expect(response.body.error.code).toBe("not_found");
  });
});
