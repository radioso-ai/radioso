import { describe, expect, it } from "vitest";

import {
  applyOperatorMcpRoutineTransform,
  RoutineTransformError,
} from "../../../src/modules/routines/operatorMcpRoutineTransform.js";
import { validateRoutineDefinition } from "../../../src/modules/routines/validator.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";

const routine = (): RoutineDefinition => ({
  id: "routine_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  version: 1,
  name: "Eligibility",
  enabled: true,
  activation: { triggerDescription: "Check eligibility.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 }],
  steps: [
    { stableStepId: "start", kind: "chat", instruction: "Start with {{slot.email}}.", ordinal: 0, metadata: {} },
    { stableStepId: "check", kind: "chat", instruction: "Check.", ordinal: 1, metadata: {} },
    { stableStepId: "follow_up", kind: "chat", instruction: "Follow up.", ordinal: 2, metadata: {} },
  ],
  transitions: [
    { fromStep: "start", toRef: "check", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "check", toRef: "follow_up", guardKind: "llm", guardText: "Need more.", ordinal: 1 },
    { fromStep: "follow_up", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
  createdAt: new Date("2026-09-13T00:00:00.000Z"),
  updatedAt: new Date("2026-09-13T00:00:00.000Z"),
});

describe("applyOperatorMcpRoutineTransform", () => {
  it("uses a complete reorder list to change only step ordinals", () => {
    const transformed = applyOperatorMcpRoutineTransform(routine(), {
      operations: [{ kind: "reorder_steps", stableStepIds: ["follow_up", "start", "check"] }],
    });

    expect(transformed.steps.map(({ stableStepId, ordinal }) => ({ stableStepId, ordinal }))).toEqual([
      { stableStepId: "start", ordinal: 1 },
      { stableStepId: "check", ordinal: 2 },
      { stableStepId: "follow_up", ordinal: 0 },
    ]);
    expect(transformed.transitions).toEqual(routine().transitions);
  });

  it("inserts an exact edge without inferring adjacent connections", () => {
    const transformed = applyOperatorMcpRoutineTransform(routine(), {
      operations: [{
        kind: "insert_transition",
        transition: { fromStep: "start", toRef: "follow_up", guardKind: "field", guardText: null, fieldRef: "slot.email", fieldOp: "is_present", ordinal: 3 },
      }],
    });

    expect(transformed.transitions).toContainEqual(expect.objectContaining({ fromStep: "start", toRef: "follow_up", ordinal: 3 }));
    expect(transformed.transitions).toContainEqual(expect.objectContaining({ fromStep: "start", toRef: "check", ordinal: 0 }));
  });

  it("retargets only the exact supplied edge and preserves other incoming edges", () => {
    const source = routine();
    source.transitions.push({ fromStep: "start", toRef: "check", guardKind: "llm", guardText: "Escalate.", ordinal: 3 });
    const target = source.transitions[0];
    const transformed = applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "replace_transition", previous: target, next: { ...target, toRef: "done" } }],
    });

    expect(transformed.transitions).toContainEqual({ ...target, toRef: "done" });
    expect(transformed.transitions).toContainEqual(source.transitions[3]);
    expect(transformed.transitions).not.toContainEqual(target);
  });

  it("allows a removal when the same transform retargets every reference", () => {
    const source = routine();
    const target = source.transitions[1];
    const transformed = applyOperatorMcpRoutineTransform(source, {
      operations: [
        { kind: "remove_step", stableStepId: "check" },
        { kind: "replace_transition", previous: source.transitions[0], next: { ...source.transitions[0], toRef: "follow_up" } },
        { kind: "remove_transition", transition: target },
      ],
    });

    expect(transformed.steps.map((step) => step.stableStepId)).not.toContain("check");
    expect(transformed.transitions).not.toContainEqual(expect.objectContaining({ fromStep: "check" }));
    expect(transformed.transitions).not.toContainEqual(expect.objectContaining({ toRef: "check" }));
  });

  it("rejects a removed step or ending that remains referenced", () => {
    expect(() => applyOperatorMcpRoutineTransform(routine(), {
      operations: [{ kind: "remove_step", stableStepId: "check" }],
    })).toThrow(/check.*referenced/u);
    expect(() => applyOperatorMcpRoutineTransform(routine(), {
      operations: [{ kind: "remove_terminal", stableStepId: "done" }],
    })).toThrow(RoutineTransformError);
  });

  it("supports explicit node, field, and slot changes while leaving validation canonical", () => {
    const transformed = applyOperatorMcpRoutineTransform(routine(), {
      operations: [
        { kind: "set_enabled", enabled: false },
        { kind: "replace_slot", previous: routine().slots[0], next: { ...routine().slots[0], required: false } },
        { kind: "insert_terminal", terminal: { stableStepId: "handoff", kind: "handoff", instruction: "Hand off.", ordinal: 1 } },
        { kind: "replace_step", previous: routine().steps[0], next: { ...routine().steps[0], instruction: "Welcome {{slot.email}}." } },
      ],
    });

    expect(transformed.enabled).toBe(false);
    expect(transformed.slots[0]).toEqual(expect.objectContaining({ required: false }));
    expect(transformed.terminals).toContainEqual(expect.objectContaining({ stableStepId: "handoff" }));
    expect(transformed.steps[0]).toEqual(expect.objectContaining({ instruction: "Welcome {{slot.email}}." }));
    expect(validateRoutineDefinition({ ...routine(), ...transformed }).ok).toBe(true);
  });

  it("rejects stale exact references and incomplete reorder lists", () => {
    expect(() => applyOperatorMcpRoutineTransform(routine(), {
      operations: [{ kind: "remove_transition", transition: { ...routine().transitions[0], ordinal: 99 } }],
    })).toThrow(/no longer exists/u);
    expect(() => applyOperatorMcpRoutineTransform(routine(), {
      operations: [{ kind: "reorder_steps", stableStepIds: ["start", "check"] }],
    })).toThrow(/complete/u);
  });

  it("matches transitions structurally, independent of field order, and rejects an ambiguous edge", () => {
    const source = routine();
    const target = { guardText: null, ordinal: 0, toRef: "check", guardKind: "default", fromStep: "start" };
    const transformed = applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "replace_transition", previous: target, next: { ...target, toRef: "done" } }],
    });
    expect(transformed.transitions).toContainEqual(expect.objectContaining({ fromStep: "start", toRef: "done" }));
    source.transitions.push({ ...source.transitions[0] });
    expect(() => applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "remove_transition", transition: source.transitions[0] }],
    })).toThrow(/ambiguous/u);
  });

  it("protects every stable node and slot identity from duplicate inserts or replacement renames", () => {
    const source = routine();
    for (const operation of [
      { kind: "insert_step" as const, step: { ...source.steps[0] } },
      { kind: "insert_terminal" as const, terminal: { ...source.terminals[0] } },
      { kind: "insert_terminal" as const, terminal: { ...source.terminals[0], stableStepId: source.steps[0].stableStepId } },
      { kind: "insert_slot" as const, slot: { ...source.slots[0] } },
      { kind: "insert_slot" as const, slot: { ...source.slots[0], stableSlotId: "other", key: source.slots[0].key } },
    ]) {
      expect(() => applyOperatorMcpRoutineTransform(source, { operations: [operation] })).toThrow(RoutineTransformError);
    }
    expect(() => applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "replace_step", previous: source.steps[0], next: { ...source.steps[0], stableStepId: "renamed" } }],
    })).toThrow(/stable id/u);
    expect(() => applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "replace_terminal", previous: source.terminals[0], next: { ...source.terminals[0], stableStepId: "renamed" } }],
    })).toThrow(/stable id/u);
    expect(() => applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "replace_slot", previous: source.slots[0], next: { ...source.slots[0], stableSlotId: "renamed" } }],
    })).toThrow(/stable id/u);
  });

  it("rejects removing a slot while a local template or transition still references it", () => {
    const source = routine();
    expect(() => applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "remove_slot", stableSlotId: "slot_email" }],
    })).toThrow(/slot_email.*referenced/u);
    const transitionOnly = routine();
    transitionOnly.steps[0] = { ...transitionOnly.steps[0], instruction: "Start." };
    transitionOnly.transitions[0] = { ...transitionOnly.transitions[0], guardKind: "field", fieldRef: "slot.email", fieldOp: "is_present" };
    expect(() => applyOperatorMcpRoutineTransform(transitionOnly, {
      operations: [{ kind: "remove_slot", stableSlotId: "slot_email" }],
    })).toThrow(/slot_email.*referenced/u);
  });

  it("detects structured variable bindings without mistaking ordinary prose for a slot reference", () => {
    const bound = routine();
    bound.steps[0] = { ...bound.steps[0], instruction: "Send an email.", metadata: { inputBindings: { email: { kind: "variableRef", ref: "email" } } } };
    expect(() => applyOperatorMcpRoutineTransform(bound, {
      operations: [{ kind: "remove_slot", stableSlotId: "slot_email" }],
    })).toThrow(/slot_email.*referenced/u);
    const prose = routine();
    prose.steps[0] = { ...prose.steps[0], instruction: "Send an email." };
    expect(applyOperatorMcpRoutineTransform(prose, {
      operations: [{ kind: "remove_slot", stableSlotId: "slot_email" }],
    }).slots).toEqual([]);
  });

  it("asks the owning application boundary to reject scoped references before returning a removal draft", () => {
    const source = routine();
    source.steps[0] = { ...source.steps[0], instruction: "Start." };
    expect(() => applyOperatorMcpRoutineTransform(source, {
      operations: [{ kind: "remove_slot", stableSlotId: "slot_email" }],
    }, {
      assertNoScopedReferences: ({ removedSlotIds }) => {
        if (removedSlotIds.includes("slot_email")) throw new RoutineTransformError("Scoped directive still references slot_email.");
      },
    })).toThrow(/Scoped directive/u);
  });
});
