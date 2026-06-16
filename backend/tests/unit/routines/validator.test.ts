import { describe, expect, it } from "vitest";

import { validateRoutineDefinition } from "../../../src/modules/routines/validator.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import type { SkillAuthoringDescriptor } from "../../../src/modules/skills/public.js";

const definitionWithTool = (toolRef: string | null): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "lookup",
  version: 1,
  status: "published",
  activation: {
    triggerDescription: "Look up an account.",
    gateRef: null,
    priority: 10,
  },
  slots: [],
  steps: [
    { stableStepId: "lookup", kind: "tool", instruction: "Look up the account.", toolRef, ordinal: 0, metadata: {} },
  ],
  transitions: [
    { fromStep: "lookup", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 },
  ],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
});

const descriptor = (
  skillName: string,
  inputs: SkillAuthoringDescriptor["inputs"],
): SkillAuthoringDescriptor => ({
  skillName,
  displayName: skillName,
  inputs,
  outcomes: [{
    name: "completed",
    displayName: "Completed",
    status: "completed",
  }],
  hasDataOutputs: false,
});

const descriptors = (...items: SkillAuthoringDescriptor[]): ReadonlyMap<string, SkillAuthoringDescriptor> =>
  new Map(items.map((item) => [item.skillName, item]));

const definitionWithSteps = (
  steps: RoutineDefinition["steps"],
  transitions: RoutineDefinition["transitions"],
  slots: RoutineDefinition["slots"] = [],
): RoutineDefinition => ({
  ...definitionWithTool("placeholder"),
  slots,
  steps,
  transitions,
});

describe("validateRoutineDefinition authoring catalog context", () => {
  it("flags a tool step whose toolRef is absent from the optional authoring catalog skill set", () => {
    const result = validateRoutineDefinition(definitionWithTool("crm_lookup"), {
      availableSkillNames: new Set(["retrieval.answer"]),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual({
      code: "unknown_skill",
      location: "step:lookup",
      message: 'unknown skill: tool step "lookup" references "crm_lookup", but that skill is not available to this agent.',
    });
  });

  it("derives unknown-skill validation from descriptor map keys when only descriptors are supplied", () => {
    const result = validateRoutineDefinition(definitionWithTool("crm_lookup"), {
      skillDescriptors: descriptors(descriptor("retrieval.answer", [])),
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unknown_skill",
      location: "step:lookup",
    }));
  });

  it("keeps legacy validator callers catalog-agnostic when no skill set is supplied", () => {
    expect(validateRoutineDefinition(definitionWithTool("crm_lookup"))).toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  it("flags a required variable binding that is not guaranteed across all branches", () => {
    const result = validateRoutineDefinition(definitionWithSteps([
      { stableStepId: "start", kind: "chat", instruction: "Start.", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      {
        stableStepId: "collect_email",
        kind: "chat",
        instruction: "Ask for {{slot.email}}.",
        toolRef: null,
        actionType: null,
        ordinal: 1,
        metadata: {},
      },
      { stableStepId: "skip_email", kind: "chat", instruction: "Skip.", toolRef: null, actionType: null, ordinal: 2, metadata: {} },
      {
        stableStepId: "send",
        kind: "tool",
        instruction: "Send.",
        toolRef: "mailer.send",
        actionType: null,
        ordinal: 3,
        metadata: {
          inputBindings: {
            email: { kind: "variableRef", ref: "email" },
          },
        },
      },
    ], [
      { fromStep: "start", toRef: "collect_email", guardKind: "default", guardText: null, ordinal: 0 },
      { fromStep: "start", toRef: "skip_email", guardKind: "default", guardText: null, ordinal: 1 },
      { fromStep: "collect_email", toRef: "send", guardKind: "default", guardText: null, ordinal: 2 },
      { fromStep: "skip_email", toRef: "send", guardKind: "default", guardText: null, ordinal: 3 },
      { fromStep: "send", toRef: "done", guardKind: "default", guardText: null, ordinal: 4 },
    ], [
      { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
    ]), {
      skillDescriptors: descriptors(descriptor("mailer.send", [{ key: "email", type: "email", required: true }])),
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unsatisfiable_required_input",
      location: "step:send.inputBindings.email",
    }));
  });

  it("accepts a required variable binding when the variable is guaranteed before the fork", () => {
    const result = validateRoutineDefinition(definitionWithSteps([
      {
        stableStepId: "collect_email",
        kind: "chat",
        instruction: "Ask for {{slot.email}}.",
        toolRef: null,
        actionType: null,
        ordinal: 0,
        metadata: {},
      },
      { stableStepId: "left", kind: "chat", instruction: "Left.", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
      { stableStepId: "right", kind: "chat", instruction: "Right.", toolRef: null, actionType: null, ordinal: 2, metadata: {} },
      {
        stableStepId: "send",
        kind: "tool",
        instruction: "Send.",
        toolRef: "mailer.send",
        actionType: null,
        ordinal: 3,
        metadata: {
          inputBindings: {
            email: { kind: "variableRef", ref: "email" },
          },
        },
      },
    ], [
      { fromStep: "collect_email", toRef: "left", guardKind: "default", guardText: null, ordinal: 0 },
      { fromStep: "collect_email", toRef: "right", guardKind: "default", guardText: null, ordinal: 1 },
      { fromStep: "left", toRef: "send", guardKind: "default", guardText: null, ordinal: 2 },
      { fromStep: "right", toRef: "send", guardKind: "default", guardText: null, ordinal: 3 },
      { fromStep: "send", toRef: "done", guardKind: "default", guardText: null, ordinal: 4 },
    ], [
      { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
    ]), {
      skillDescriptors: descriptors(descriptor("mailer.send", [{ key: "email", type: "email", required: true }])),
    });

    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it("flags literal type mismatches and enum values outside the descriptor allow-list", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0]!,
        metadata: {
          inputBindings: {
            retryCount: { kind: "literal", value: "three" },
            status: { kind: "literal", value: "archived" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "retryCount", type: "number", required: false },
        { key: "status", type: "enum", required: false, enumValues: ["open", "closed"] },
      ])),
    });

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "input_type_mismatch", location: "step:lookup.inputBindings.retryCount" }),
      expect.objectContaining({ code: "input_type_mismatch", location: "step:lookup.inputBindings.status" }),
    ]));
  });

  it("flags input binding keys that are not declared by the skill descriptor", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0]!,
        metadata: {
          inputBindings: {
            extra: { kind: "literal", value: "unused" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "orderId", type: "text", required: false },
      ])),
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unknown_input_binding",
      location: "step:lookup.inputBindings.extra",
    }));
  });

  it("flags output-assignment target names that collide with slot keys or other output targets", () => {
    const result = validateRoutineDefinition(definitionWithSteps([
      {
        stableStepId: "first",
        kind: "tool",
        instruction: "First.",
        toolRef: "first.skill",
        actionType: null,
        ordinal: 0,
        metadata: { outputAssignments: { id: "email", status: "shared_status" } },
      },
      {
        stableStepId: "second",
        kind: "tool",
        instruction: "Second.",
        toolRef: "second.skill",
        actionType: null,
        ordinal: 1,
        metadata: { outputAssignments: { status: "shared_status" } },
      },
    ], [
      { fromStep: "first", toRef: "second", guardKind: "default", guardText: null, ordinal: 0 },
      { fromStep: "second", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
    ], [
      { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
    ]));

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "variable_name_collision", location: "step:first.outputAssignments.id" }),
      expect.objectContaining({ code: "variable_name_collision", location: "step:first.outputAssignments.status" }),
      expect.objectContaining({ code: "variable_name_collision", location: "step:second.outputAssignments.status" }),
    ]));
  });
});
