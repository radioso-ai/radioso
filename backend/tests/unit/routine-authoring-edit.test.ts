import { describe, expect, it } from "vitest";

import {
  applyRoutineFieldPatch,
  describeRoutineFieldPatch,
  draftInputFromRoutine,
  projectRoutineForReview,
  routineFieldPatchSchema,
  RoutineFieldPatchError,
} from "../../src/modules/routines/authoringEdit.js";
import { routineDefinitionDraftInputSchema, type RoutineDefinition } from "../../src/modules/routines/public.js";

const routine = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  lineageId: "33333333-3333-4333-8333-333333333333",
  version: 2,
  status: "published",
  name: "support-intake",
  activation: { triggerDescription: "When the user needs support", gateRef: null, priority: 7, reentryMode: "always" },
  slots: [
    { stableSlotId: "slot_order", key: "order_number", type: "text", required: true, description: "The order it concerns", ordinal: 0 },
  ],
  steps: [
    { stableStepId: "collect_topic", kind: "chat", instruction: "Ask how we can help.", toolRef: null, actionType: null, ordinal: 0, metadata: { outlineLabel: "collect_topic" } },
    { stableStepId: "confirm", kind: "chat", instruction: "Confirm {{slot.order_number}}.", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "collect_topic", toRef: "confirm", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 },
    { fromStep: "confirm", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thank them.", ordinal: 0 }],
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-02T10:00:00.000Z"),
  ...overrides,
});

describe("routine authoring edits", () => {
  it("drops persistence identity so a stored routine re-enters the authoring schema unchanged", () => {
    const draft = draftInputFromRoutine(routine());

    expect(Object.keys(draft)).not.toContain("id");
    expect(Object.keys(draft)).not.toContain("status");
    expect(Object.keys(draft)).not.toContain("version");
    expect(routineDefinitionDraftInputSchema.parse(draft)).toMatchObject({ name: "support-intake" });
  });

  it("edits one step's instruction and leaves every other authored value, including stable ids, alone", () => {
    const source = routine();

    const patched = applyRoutineFieldPatch(source, routineFieldPatchSchema.parse({
      steps: [{ stableStepId: "confirm", instruction: "Read back {{slot.order_number}} and ask them to confirm it." }],
    }));

    expect(patched.steps).toEqual([
      source.steps[0],
      { ...source.steps[1], instruction: "Read back {{slot.order_number}} and ask them to confirm it." },
    ]);
    expect(patched.transitions).toEqual(source.transitions);
    expect(patched.terminals).toEqual(source.terminals);
    expect(patched.slots).toEqual(source.slots);
  });

  it("renames the routine and retunes activation without touching the graph", () => {
    const source = routine();

    const patched = applyRoutineFieldPatch(source, routineFieldPatchSchema.parse({
      name: "support-intake-v2",
      activation: { triggerDescription: "When the user reports a problem with an order", priority: 20 },
    }));

    expect(patched.name).toBe("support-intake-v2");
    expect(patched.activation).toEqual({
      triggerDescription: "When the user reports a problem with an order",
      gateRef: null,
      priority: 20,
      reentryMode: "always",
    });
    expect(patched.steps).toEqual(source.steps);
  });

  it("edits slots by key and terminals by stable id, including clearing a terminal instruction", () => {
    const patched = applyRoutineFieldPatch(routine(), routineFieldPatchSchema.parse({
      slots: [{ key: "order_number", description: "The order number the customer is asking about", required: false }],
      terminals: [{ stableStepId: "done", instruction: null }],
    }));

    expect(patched.slots).toEqual([{
      stableSlotId: "slot_order",
      key: "order_number",
      type: "text",
      required: false,
      description: "The order number the customer is asking about",
      ordinal: 0,
    }]);
    expect(patched.terminals).toEqual([{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }]);
  });

  it("refuses an edit that names something the routine does not have, and says what it does have", () => {
    const patch = routineFieldPatchSchema.parse({ steps: [{ stableStepId: "step_7", instruction: "Apologize." }] });

    expect(() => applyRoutineFieldPatch(routine(), patch)).toThrow(RoutineFieldPatchError);
    try {
      applyRoutineFieldPatch(routine(), patch);
    } catch (error) {
      expect((error as RoutineFieldPatchError).message).toContain("step_7");
      expect((error as RoutineFieldPatchError).message).toContain("collect_topic");
      expect((error as RoutineFieldPatchError).message).toContain("confirm");
    }
    expect(() => applyRoutineFieldPatch(routine(), routineFieldPatchSchema.parse({ slots: [{ key: "missing", required: true }] })))
      .toThrow(/missing/);
    expect(() => applyRoutineFieldPatch(routine(), routineFieldPatchSchema.parse({ terminals: [{ stableStepId: "nowhere", instruction: "x" }] })))
      .toThrow(/nowhere/);
  });

  it("refuses to apply one addressed edit to duplicate stable ids or keys in an invalid draft", () => {
    const duplicated = routine({
      steps: [routine().steps[0]!, { ...routine().steps[0]!, instruction: "A second instruction.", ordinal: 1 }],
      terminals: [routine().terminals[0]!, { ...routine().terminals[0]!, instruction: "A second ending.", ordinal: 1 }],
      slots: [routine().slots[0]!, { ...routine().slots[0]!, stableSlotId: "slot_order_copy", ordinal: 1 }],
    });

    expect(() => applyRoutineFieldPatch(duplicated, routineFieldPatchSchema.parse({
      steps: [{ stableStepId: "collect_topic", instruction: "Changed once." }],
    }))).toThrow(/more than one step/i);
    expect(() => applyRoutineFieldPatch(duplicated, routineFieldPatchSchema.parse({
      terminals: [{ stableStepId: "done", instruction: "Changed once." }],
    }))).toThrow(/more than one ending/i);
    expect(() => applyRoutineFieldPatch(duplicated, routineFieldPatchSchema.parse({
      slots: [{ key: "order_number", required: false }],
    }))).toThrow(/more than one information field/i);
  });

  it("rejects an empty patch rather than proposing a change that changes nothing", () => {
    expect(routineFieldPatchSchema.safeParse({}).success).toBe(false);
    // Naming an information field without saying what about it changes still produces a card to
    // apply and a write that only moves the routine's version.
    expect(routineFieldPatchSchema.safeParse({ slots: [{ key: "order_number" }] }).success).toBe(false);
  });

  it("rejects two edits to the same element instead of applying only the last one", () => {
    // Both entries pass on their own and a Map keeps the last, so the first change disappears
    // between what the operator was shown and what was written.
    expect(routineFieldPatchSchema.safeParse({
      slots: [{ key: "order_number", description: "The order" }, { key: "order_number", required: false }],
    }).success).toBe(false);
    expect(routineFieldPatchSchema.safeParse({
      steps: [{ stableStepId: "confirm", instruction: "One." }, { stableStepId: "confirm", instruction: "Two." }],
    }).success).toBe(false);
    expect(routineFieldPatchSchema.safeParse({
      terminals: [{ stableStepId: "done", instruction: "One." }, { stableStepId: "done", instruction: null }],
    }).success).toBe(false);
  });

  it("projects a routine into per-element records so a reviewer sees the changed element, not the whole graph", () => {
    const projected = projectRoutineForReview(routine());

    expect(projected).toEqual({
      name: "support-intake",
      activation: { triggerDescription: "When the user needs support", gateRef: null, priority: 7, reentryMode: "always" },
      slots: {
        order_number: { type: "text", required: true, description: "The order it concerns", mutable: null, ordinal: 0 },
      },
      steps: {
        collect_topic: { kind: "chat", instruction: "Ask how we can help.", toolRef: null, actionType: null, captureKey: null, options: null, ordinal: 0, metadata: { outlineLabel: "collect_topic" } },
        confirm: { kind: "chat", instruction: "Confirm {{slot.order_number}}.", toolRef: null, actionType: null, captureKey: null, options: null, ordinal: 1, metadata: {} },
      },
      transitions: {
        "collect_topic → confirm": { guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
        "confirm → done": { guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
      },
      terminals: { done: { kind: "complete", instruction: "Thank them.", ordinal: 0 } },
      completionExport: null,
    });
  });

  it("projects a stored routine and its authoring draft identically, so an untouched field never reads as changed", () => {
    const source = routine();

    expect(projectRoutineForReview(draftInputFromRoutine(source))).toEqual(projectRoutineForReview(source));
  });

  it("keeps two transitions between the same pair distinguishable", () => {
    const projected = projectRoutineForReview(routine({
      transitions: [
        { fromStep: "collect_topic", toRef: "confirm", guardKind: "llm", guardText: "They gave an order number", outcomeStatus: null, counterLimit: null, ordinal: 0 },
        { fromStep: "collect_topic", toRef: "confirm", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 1 },
      ],
    })) as { transitions: Record<string, unknown> };

    expect(Object.keys(projected.transitions)).toEqual(["collect_topic → confirm", "collect_topic → confirm #1"]);
  });

  it("keeps every transition in the projection even when their ordinals collide", () => {
    // A dropped key is a changed transition that never reaches the reviewer, so a second collision
    // keeps counting rather than reusing the key.
    const projected = projectRoutineForReview(routine({
      transitions: [
        { fromStep: "collect_topic", toRef: "confirm", guardKind: "llm", guardText: "A", outcomeStatus: null, counterLimit: null, ordinal: 1 },
        { fromStep: "collect_topic", toRef: "confirm", guardKind: "llm", guardText: "B", outcomeStatus: null, counterLimit: null, ordinal: 1 },
        { fromStep: "collect_topic", toRef: "confirm", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 1 },
      ],
    })) as { transitions: Record<string, unknown> };

    expect(Object.keys(projected.transitions)).toHaveLength(3);
  });

  it("keeps duplicate step, ending, and information-field identities visible in review projections", () => {
    const source = routine({
      steps: [routine().steps[0]!, { ...routine().steps[0]!, instruction: "A second instruction.", ordinal: 1 }],
      terminals: [routine().terminals[0]!, { ...routine().terminals[0]!, instruction: "A second ending.", ordinal: 1 }],
      slots: [routine().slots[0]!, { ...routine().slots[0]!, stableSlotId: "slot_order_copy", ordinal: 1 }],
    });

    const projected = projectRoutineForReview(draftInputFromRoutine(source)) as {
      slots: Record<string, unknown>;
      steps: Record<string, unknown>;
      terminals: Record<string, unknown>;
    };

    expect(Object.keys(projected.slots)).toEqual(["order_number", "order_number #1"]);
    expect(Object.keys(projected.steps)).toEqual(["collect_topic", "collect_topic #1"]);
    expect(Object.keys(projected.terminals)).toEqual(["done", "done #1"]);
  });
});

describe("routine edit descriptions", () => {
  it("names what an edit touches in routine vocabulary, not field paths", () => {
    expect(describeRoutineFieldPatch(routineFieldPatchSchema.parse({
      name: "support-intake-v2",
      activation: { triggerDescription: "When an order is late", priority: 3 },
      steps: [{ stableStepId: "confirm", instruction: "Read it back." }],
      slots: [{ key: "order_number", required: false }],
    }))).toBe("name, trigger, priority, step confirm, field order_number");
  });
});
