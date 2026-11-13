import request from "supertest";
import { describe, expect, it } from "vitest";

import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

// A routine step that shows a tool step's results as cards and fills an item slot with the pick
// (#1763, US7): the authoring API keeps the binding and the slot type, and validation reports a
// binding that cannot work by code and location.

type Draft = RoutineDefinitionDraftInput;

const edge = (fromStep: string, toRef: string, ordinal: number): Draft["transitions"][number] =>
  ({ fromStep, toRef, guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal });

// A binding as a client might send it, including one the schema refuses.
const homes = (present: Record<string, unknown>): Draft => ({
  name: "find-a-home",
  enabled: true,
  activation: { triggerDescription: "The visitor looks for a home.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_area", key: "area", type: "text", required: true, description: "Where they want to live", ordinal: 0 },
    { stableSlotId: "slot_home", key: "chosen_home", type: "item", required: true, description: "The home they picked", ordinal: 1 },
  ],
  steps: [
    { stableStepId: "brief", kind: "chat", instruction: "Ask where they want to live. {{slot.area}}", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search the homes.", toolRef: "search_homes", ordinal: 1, metadata: {} },
    { stableStepId: "choose", kind: "chat", instruction: "Show the matches and ask which one they like.", toolRef: null, ordinal: 2, metadata: { present: present as NonNullable<Draft["steps"][number]["metadata"]["present"]> } },
  ],
  transitions: [edge("brief", "search", 0), edge("search", "choose", 1), edge("choose", "handoff", 2)],
  terminals: [{ stableStepId: "handoff", kind: "handoff", instruction: "An agent calls about {{slot.chosen_home}}.", ordinal: 0 }],
});

const authoring = async (email: string) => {
  const { app } = createTestApp();
  const { token } = await issueTestToken(app, email);
  const authorization = `Bearer ${token}`;
  const agent = await request(app).post("/api/v1/agents").set("Authorization", authorization).send({ name: "Homes" }).expect(201);
  return { app, authorization, agentId: String(agent.body.id) };
};

const presentCodes = (diagnostics: Array<{ code: string; location: string }>) =>
  diagnostics.filter((diagnostic) => diagnostic.code.startsWith("present_") || diagnostic.code.startsWith("item_slot_"));

describe("routine present binding contract", () => {
  it("keeps a presenting step's binding and its item slot through create and read", async () => {
    const { app, authorization, agentId } = await authoring("routine-present-binding@example.com");

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/routines`)
      .set("Authorization", authorization)
      .send(homes({ from: "search", selection: "single", slot: "chosen_home" }))
      .expect(201);
    expect(presentCodes(created.body.validation.diagnostics)).toEqual([]);

    const read = await request(app)
      .get(`/api/v1/agents/${agentId}/routines/${String(created.body.routine.id)}`)
      .set("Authorization", authorization)
      .expect(200);
    const routine = read.body.routine as Draft;
    expect(routine.slots.find((slot) => slot.key === "chosen_home")?.type).toBe("item");
    expect(routine.steps.find((step) => step.stableStepId === "choose")?.metadata).toEqual({
      present: { from: "search", selection: "single", slot: "chosen_home" },
    });
  });

  it("reports a binding to a step that is not an earlier tool step, and a pick with no slot", async () => {
    const { app, authorization, agentId } = await authoring("routine-present-binding-invalid@example.com");

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/routines`)
      .set("Authorization", authorization)
      .send(homes({ from: "brief", selection: "single" }))
      .expect(201);

    const validated = await request(app)
      .post(`/api/v1/agents/${agentId}/routines/${String(created.body.routine.id)}/validate`)
      .set("Authorization", authorization)
      .expect(200);
    expect(presentCodes(validated.body.validation.diagnostics)).toEqual([
      expect.objectContaining({ code: "present_source_not_earlier_tool", location: "step:choose.present.from" }),
      expect.objectContaining({ code: "present_selection_mismatch", location: "step:choose.present.selection" }),
      expect.objectContaining({ code: "item_slot_without_presenting_step", location: "slot:chosen_home" }),
    ]);
  });

  it("refuses a binding with a selection the schema does not know", async () => {
    const { app, authorization, agentId } = await authoring("routine-present-binding-schema@example.com");

    await request(app)
      .post(`/api/v1/agents/${agentId}/routines`)
      .set("Authorization", authorization)
      .send(homes({ from: "search", selection: "many", slot: "chosen_home" }))
      .expect(400);
  });
});
