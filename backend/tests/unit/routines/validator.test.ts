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
    reentryMode: "once_per_conversation",
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
  category: "external_mcp",
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

  it("lists available step ids when a transition targets an unknown node", () => {
    const result = validateRoutineDefinition(definitionWithSteps([
      { stableStepId: "check_eligibility", kind: "chat", instruction: "Check.", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      { stableStepId: "lookup", kind: "chat", instruction: "Lookup.", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
    ], [
      { fromStep: "check_eligibility", toRef: "lookup", guardKind: "default", guardText: null, ordinal: 0 },
      { fromStep: "lookup", toRef: "check_elig", guardKind: "llm", guardText: "Needs another check.", ordinal: 1 },
    ]));

    expect(result.diagnostics).toContainEqual({
      code: "dangling_step_reference",
      location: "transition:lookup->check_elig",
      message: 'dangling step reference: transition points to unknown step or terminal "check_elig" - steps in this routine: check_eligibility, lookup.',
    });
  });

  it("caps available step ids in dangling transition diagnostics", () => {
    const steps = Array.from({ length: 12 }, (_, index) => ({
      stableStepId: `step_${index + 1}`,
      kind: "chat" as const,
      instruction: `Step ${index + 1}.`,
      toolRef: null,
      actionType: null,
      ordinal: index,
      metadata: {},
    }));
    const transitions = steps.slice(0, -1).map((step, index) => ({
      fromStep: step.stableStepId,
      toRef: steps[index + 1].stableStepId,
      guardKind: "default" as const,
      guardText: null,
      ordinal: index,
    }));

    const result = validateRoutineDefinition(definitionWithSteps(steps, [
      ...transitions,
      { fromStep: "missing_start", toRef: "done", guardKind: "default", guardText: null, ordinal: transitions.length },
    ]));

    expect(result.diagnostics).toContainEqual({
      code: "dangling_step_reference",
      location: "transition:missing_start->done",
      message: 'dangling step reference: transition starts at unknown step "missing_start" - steps in this routine: step_1, step_2, step_3, step_4, step_5, step_6, step_7, step_8, step_9, step_10.',
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
        ...definitionWithTool("order.lookup").steps[0],
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
        ...definitionWithTool("order.lookup").steps[0],
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

  it("flags an optional input bound to a variable that no slot or output assignment declares", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0],
        metadata: {
          inputBindings: {
            orderId: { kind: "variableRef", ref: "typoVariable" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "orderId", type: "text", required: false },
      ])),
    });

    // An optional binding to a non-existent variable would otherwise be silently dropped
    // at dispatch; the unknown reference must be flagged at validate time.
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unknown_variable_ref",
      location: "step:lookup.inputBindings.orderId",
    }));
  });

  it("reports a required input bound to an unknown variable only as an unknown reference, not also as unsatisfiable", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0],
        metadata: {
          inputBindings: {
            orderId: { kind: "variableRef", ref: "typoVariable" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "orderId", type: "text", required: true },
      ])),
    });

    const orderIdDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.location === "step:lookup.inputBindings.orderId",
    );
    expect(orderIdDiagnostics).toEqual([
      expect.objectContaining({ code: "unknown_variable_ref" }),
    ]);
  });

  it("flags an unknown context variable when the optional context catalog is supplied", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0],
        metadata: {
          inputBindings: {
            cart: { kind: "contextVariableRef", contextVariable: "missing_cart" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "cart", type: "text", required: false },
      ])),
      availableContextVariables: new Map([["cart", { valueType: "json" }]]),
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unknown_context_variable",
      location: "step:lookup.inputBindings.cart",
    }));
  });

  it("skips context-variable existence validation when no context catalog is supplied", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0],
        metadata: {
          inputBindings: {
            cart: { kind: "contextVariableRef", contextVariable: "cart" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "cart", type: "text", required: false },
      ])),
    });

    expect(result.diagnostics.find((diagnostic) => diagnostic.code === "unknown_context_variable")).toBeUndefined();
  });

  it("validates context-variable type compatibility", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0],
        metadata: {
          inputBindings: {
            jsonToString: { kind: "contextVariableRef", contextVariable: "cart" },
            stringToEnum: { kind: "contextVariableRef", contextVariable: "customer_note" },
            stringToNumber: { kind: "contextVariableRef", contextVariable: "customer_note" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "jsonToString", type: "text", required: false },
        { key: "stringToEnum", type: "enum", required: false, enumValues: ["vip", "standard"] },
        { key: "stringToNumber", type: "number", required: false },
      ])),
      availableContextVariables: new Map([
        ["cart", { valueType: "json" }],
        ["customer_note", { valueType: "string" }],
      ]),
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "input_type_mismatch",
        location: "step:lookup.inputBindings.stringToNumber",
      }),
    ]);
  });

  it("does not treat a required contextVariableRef as guaranteed on entry", () => {
    const result = validateRoutineDefinition({
      ...definitionWithTool("order.lookup"),
      steps: [{
        ...definitionWithTool("order.lookup").steps[0],
        metadata: {
          inputBindings: {
            cart: { kind: "contextVariableRef", contextVariable: "cart" },
          },
        },
      }],
    }, {
      skillDescriptors: descriptors(descriptor("order.lookup", [
        { key: "cart", type: "text", required: true },
      ])),
      availableContextVariables: new Map([["cart", { valueType: "json" }]]),
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unsatisfiable_required_input",
      location: "step:lookup.inputBindings.cart",
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

describe("validateRoutineDefinition node id uniqueness", () => {
  it("flags an id shared by a step and a terminal", () => {
    const definition: RoutineDefinition = {
      ...definitionWithTool("crm_lookup"),
      steps: [
        { stableStepId: "resolve", kind: "chat", instruction: "Resolve it.", toolRef: null, ordinal: 0, metadata: {} },
      ],
      transitions: [
        { fromStep: "resolve", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 },
        { stableStepId: "resolve", kind: "complete", instruction: "Also done.", ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition, { availableSkillNames: new Set(["crm_lookup"]) });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "node_id_collision", location: "node:resolve" }),
    ]));
  });

  it("flags a named completion whose id collides with the handoff terminal", () => {
    const definition: RoutineDefinition = {
      ...definitionWithTool("crm_lookup"),
      steps: [
        { stableStepId: "check", kind: "chat", instruction: "Check it.", toolRef: null, ordinal: 0, metadata: {} },
      ],
      transitions: [
        { fromStep: "check", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 },
        { fromStep: "check", toRef: "handoff", guardKind: "llm", guardText: "if stuck", ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 },
        { stableStepId: "handoff", kind: "handoff", instruction: "Escalating.", ordinal: 1 },
        { stableStepId: "handoff", kind: "complete", instruction: "Named ending that collides.", ordinal: 2 },
      ],
    };

    const result = validateRoutineDefinition(definition, { availableSkillNames: new Set(["crm_lookup"]) });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "node_id_collision", location: "node:handoff" }),
    ]));
  });
});
