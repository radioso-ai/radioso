import { describe, expect, it } from "vitest";

import { compileRoutineDefinition } from "../../../src/modules/routines/compiler.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import { buildAgentToolDescriptor } from "../../../src/modules/routines/exposure/agentToolDescriptor.js";
import { toSafeRoutineValidationDiagnostic, validateRoutineDefinition } from "../../../src/modules/routines/validator.js";

type Step = RoutineDefinition["steps"][number];
type Slot = RoutineDefinition["slots"][number];

const edge = (fromStep: string, toRef: string, ordinal: number): RoutineDefinition["transitions"][number] =>
  ({ fromStep, toRef, guardKind: "default", guardText: null, ordinal });

const slot = (key: string, type: Slot["type"], ordinal: number): Slot =>
  ({ stableSlotId: key, key, type, required: true, description: null, ordinal });

// The property flow (#1763): a brief, a search, a step that shows the results and binds the pick,
// and a hand-off that names it.
const homes = (overrides: { choose?: Partial<Step>; slots?: Slot[]; steps?: Step[] } = {}): RoutineDefinition => ({
  id: "def_homes",
  agentId: "agent_1",
  lineageId: "lineage_homes",
  name: "homes",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "Find a home.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: overrides.slots ?? [slot("area", "text", 0), slot("chosen_home", "item", 1)],
  steps: overrides.steps ?? [
    { stableStepId: "brief", kind: "chat", instruction: "Where? {{slot.area}}", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search homes.", toolRef: "search_homes", ordinal: 1, metadata: {} },
    {
      stableStepId: "choose",
      kind: "chat",
      instruction: "Show the matches and ask which one they like.",
      toolRef: null,
      ordinal: 2,
      metadata: { present: { from: "search", selection: "single", slot: "chosen_home" } },
      ...overrides.choose,
    },
  ],
  transitions: [edge("brief", "search", 0), edge("search", "choose", 1), edge("choose", "handoff", 2)],
  terminals: [{ stableStepId: "handoff", kind: "handoff", instruction: "An agent will call about {{slot.chosen_home}}.", ordinal: 0 }],
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
  updatedAt: new Date("2026-11-13T00:00:00.000Z"),
});

const codes = (definition: RoutineDefinition) => validateRoutineDefinition(definition).diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.location]);

describe("present binding validation (#1763)", () => {
  it("accepts a step that shows an earlier tool step's results and fills an item slot", () => {
    expect(validateRoutineDefinition(homes())).toEqual({ ok: true, diagnostics: [] });
  });

  it("reports a source that is not a tool step, or not one before the step", () => {
    expect(codes(homes({ choose: { metadata: { present: { from: "brief", selection: "single", slot: "chosen_home" } } } })))
      .toEqual([["present_source_not_earlier_tool", "step:choose.present.from"]]);
    expect(codes(homes({ choose: { metadata: { present: { from: "missing", selection: "single", slot: "chosen_home" } } } })))
      .toEqual([["present_source_not_earlier_tool", "step:choose.present.from"]]);
    const later = homes();
    later.steps.push({ stableStepId: "lookup", kind: "tool", instruction: "Look it up.", toolRef: "lookup", ordinal: 3, metadata: {} });
    later.steps[2] = { ...later.steps[2], metadata: { present: { from: "lookup", selection: "single", slot: "chosen_home" } } };
    later.transitions = [edge("brief", "search", 0), edge("search", "choose", 1), edge("choose", "lookup", 2), edge("lookup", "handoff", 3)];
    expect(codes(later)).toEqual([["present_source_not_earlier_tool", "step:choose.present.from"]]);
  });

  it("reports a source a waiting step separates from the step, since its result is gone by then", () => {
    const definition = homes();
    definition.steps[2] = { ...definition.steps[2], ordinal: 3 };
    definition.steps.push({ stableStepId: "confirm", kind: "chat", instruction: "Confirm the area {{slot.area}}.", toolRef: null, ordinal: 2, metadata: {} });
    definition.transitions = [edge("brief", "search", 0), edge("search", "confirm", 1), edge("confirm", "choose", 2), edge("choose", "handoff", 3)];
    expect(codes(definition)).toEqual([["present_source_unreachable", "step:choose.present.from"]]);
    expect(toSafeRoutineValidationDiagnostic({ code: "present_source_unreachable", location: "step:choose.present.from" }).message)
      .toBe("A step that shows results as cards must follow its tool step with no message or approval step in between.");
  });

  it("reports a slot that is not a declared item slot", () => {
    expect(codes(homes({ choose: { metadata: { present: { from: "search", selection: "single", slot: "area" } } } })))
      .toEqual([
        ["present_slot_not_item", "step:choose.present.slot"],
        ["item_slot_without_presenting_step", "slot:chosen_home"],
      ]);
  });

  it("reports a pick without a slot, and a slot without a pick", () => {
    expect(codes(homes({ choose: { metadata: { present: { from: "search", selection: "none", slot: "chosen_home" } } } })))
      .toEqual([["present_selection_mismatch", "step:choose.present.selection"]]);
    const showOnly = homes({
      slots: [slot("area", "text", 0)],
      choose: { metadata: { present: { from: "search", selection: "single" } } },
    });
    showOnly.terminals[0] = { ...showOnly.terminals[0], instruction: "An agent will call." };
    expect(codes(showOnly)).toEqual([["present_selection_mismatch", "step:choose.present.selection"]]);
  });

  it("reports a binding on a step that is not a message step", () => {
    const definition = homes();
    definition.steps[1] = { ...definition.steps[1], metadata: { present: { from: "search", selection: "none" } } };
    expect(codes(definition)).toContainEqual(["present_step_not_chat", "step:search.present"]);
  });

  it("reports an item slot no presenting step fills", () => {
    expect(codes(homes({ choose: { metadata: {} } }))).toEqual([["item_slot_without_presenting_step", "slot:chosen_home"]]);
  });

  it("keeps a branch on an item slot to present or absent", () => {
    const definition = homes();
    definition.transitions[2] = { ...edge("choose", "handoff", 2), guardKind: "field", fieldRef: "chosen_home", fieldOp: "equals", fieldValue: "x" };
    expect(codes(definition)).toContainEqual(["field_guard_incompatible_type", expect.stringContaining("choose")]);
    definition.transitions[2] = { ...edge("choose", "handoff", 2), guardKind: "field", fieldRef: "chosen_home", fieldOp: "is_present" };
    expect(validateRoutineDefinition(definition).ok).toBe(true);
  });

  it("gives every code an operator-facing message", () => {
    for (const code of ["present_step_not_chat", "present_source_not_earlier_tool", "present_source_unreachable", "present_slot_not_item", "present_selection_mismatch", "item_slot_without_presenting_step"]) {
      expect(toSafeRoutineValidationDiagnostic({ code, location: "step:x" }).message).not.toBe("The routine structure is not valid for serving.");
    }
  });
});

describe("compiling a presenting step", () => {
  it("carries the binding onto the engine step, which collects the item slot and waits for it", () => {
    const routine = compileRoutineDefinition(homes());
    const choose = routine.steps.find((step) => step.id === "choose");
    expect(choose?.present).toEqual({ from: "search", selection: "single", slot: "chosen_home" });
    expect(choose?.metadata).toEqual({ authoredKind: "chat", collectsSlots: ["chosen_home"] });
    expect(routine.slots?.find((candidate) => candidate.key === "chosen_home")?.type).toBe("item");
    expect(routine.transitions.find((transition) => transition.from === "choose")?.origin).toBe("compiler_slot_gate");
  });

  it("never offers an item slot to a calling agent", () => {
    const descriptor = buildAgentToolDescriptor({ ...homes(), exposure: { enabled: true, toolName: "find_home", description: "Find a home." } });
    expect(Object.keys(descriptor.inputSchema.properties)).toEqual(["area"]);
    expect(descriptor.inputSchema.required).toEqual(["area"]);
  });
});
