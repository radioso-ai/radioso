import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import type { ConversationRoutineStepRenderer, TurnContext } from "@radioso/conversation-contract";
import { describe, expect, it, vi } from "vitest";

import { compileRoutineDefinition } from "../../../src/modules/routines/compiler.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import { validateRoutineDefinition } from "../../../src/modules/routines/validator.js";
import type { SkillAuthoringDescriptor } from "../../../src/modules/skills/public.js";

/**
 * A variable a skill step's Sets assign is declared by the assignment alone, never as a field the
 * routine collects. A later step that writes it into its text reads the value: the reference is
 * declared, the step does not ask the visitor for it, and the reply carries what the skill returned.
 */

type Step = RoutineDefinition["steps"][number];

const askNumber: Step = {
  stableStepId: "ask_number",
  kind: "chat",
  instruction: "Ask for their customer number {{slot.customer_id}}.",
  toolRef: null,
  actionType: null,
  ordinal: 0,
  metadata: {},
};

const lookup: Step = {
  stableStepId: "lookup",
  kind: "tool",
  instruction: "Look up the customer.",
  toolRef: "lookup_customer",
  actionType: null,
  ordinal: 1,
  metadata: { outputAssignments: { first_name: "first_name", city: "city" } },
};

const confirm: Step = {
  stableStepId: "confirm",
  kind: "chat",
  instruction: "Ask whether {{slot.first_name}} is the customer they mean.",
  toolRef: null,
  actionType: null,
  ordinal: 2,
  metadata: {},
};

const FINISH = "Tell them {{slot.first_name}} lives in {{slot.city}}.";

const routineWith = (steps: Step[], finish = FINISH): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "customer_lookup",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "Look up a customer.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "slot_customer_id", key: "customer_id", type: "number", required: true, description: null, ordinal: 0 }],
  steps,
  transitions: steps.map((step, index) => ({
    fromStep: step.stableStepId,
    toRef: steps[index + 1]?.stableStepId ?? "done",
    guardKind: "default" as const,
    guardText: null,
    ordinal: index,
  })),
  terminals: [{ stableStepId: "done", kind: "complete", instruction: finish, ordinal: 0 }],
  createdAt: new Date("2026-11-21T00:00:00.000Z"),
  updatedAt: new Date("2026-11-21T00:00:00.000Z"),
});

const codes = (definition: RoutineDefinition): string[] =>
  validateRoutineDefinition(definition).diagnostics.map((diagnostic) => diagnostic.code);

describe("a reference to a variable a skill step's outputs set", () => {
  it("counts as declared in a later chat step and in an ending", () => {
    expect(codes(routineWith([askNumber, lookup, confirm]))).toEqual([]);
  });

  it("still reports a reference nothing declares or assigns", () => {
    const result = validateRoutineDefinition(routineWith([askNumber, lookup], "Tell them {{slot.surname}} is on file."));

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "referenced_undeclared_slot", location: "slot:surname" }));
  });

  it("is never collected: a chat step that names it only reads it", () => {
    const compiled = compileRoutineDefinition(routineWith([askNumber, lookup, confirm]));

    expect(compiled.slots?.map((slot) => slot.key)).toEqual(["customer_id"]);
    expect(compiled.steps.find((step) => step.id === "ask_number")?.metadata?.collectsSlots).toEqual(["customer_id"]);
    expect(compiled.steps.find((step) => step.id === "confirm")?.metadata?.collectsSlots).toBeUndefined();
  });

  it("validates, compiles without new slots, and renders the values the skill returned", async () => {
    const definition = routineWith([askNumber, lookup]);
    expect(validateRoutineDefinition(definition).ok).toBe(true);
    const routine = compileRoutineDefinition(definition);
    expect(routine.slots?.map((slot) => slot.key)).toEqual(["customer_id"]);

    const renderer: ConversationRoutineStepRenderer = { render: vi.fn(async () => ({ answer: "ok" })) };
    const runner = new DefaultRoutineRunner(
      [routine],
      {
        select: vi.fn(async ({ currentStep }) =>
          currentStep.id === "ask_number" ? { nextStepId: "lookup", variables: { customer_id: 5 } } : { nextStepId: "done" }),
      },
      renderer,
      {
        dispatch: vi.fn(async () => ({
          status: "completed",
          outputs: { first_name: "Emily", city: "Phoenix" },
          outputContract: { first_name: { type: "text" as const }, city: { type: "text" as const } },
          actsOutsideConversation: false,
        })),
      },
    );
    const turn: TurnContext = {
      agent: { id: "agent_1", name: "Shop Desk" },
      sessionId: "session_1",
      inputEvent: { id: "in_1", kind: "message", content: "It's 5." },
      history: [],
      stagedContext: [],
      steering: [],
    };

    await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: routine.id, path: ["ask_number"], variables: {}, status: "active" },
    });

    const reply = vi.mocked(renderer.render).mock.calls[0][0];
    expect(reply.step.id).toBe("done");
    expect(reply.step.action).toBe("Tell them Emily lives in Phoenix.");
  });
});

describe("a reference to a variable a skill step's outputs set, before the value can be set", () => {
  const notGuaranteed = (definition: RoutineDefinition) =>
    validateRoutineDefinition(definition).diagnostics.filter((diagnostic) => diagnostic.code === "referenced_variable_not_guaranteed");

  it("is reported on a step that runs before the tool step", () => {
    const early: Step = { ...askNumber, instruction: "Greet {{slot.first_name}} and ask for their customer number {{slot.customer_id}}." };

    expect(notGuaranteed(routineWith([early, lookup]))).toEqual([
      expect.objectContaining({ location: "step:ask_number.instruction" }),
    ]);
  });

  it("is reported on an ending a branch reaches without running the tool step", () => {
    const base = routineWith([askNumber, lookup]);
    const definition: RoutineDefinition = {
      ...base,
      transitions: [
        { fromStep: "ask_number", toRef: "unknown", guardKind: "field", guardText: null, fieldRef: "customer_id", fieldOp: "is_absent", ordinal: 0 },
        ...base.transitions.map((transition) => ({ ...transition, ordinal: transition.ordinal + 1 })),
      ],
      terminals: [...base.terminals, { stableStepId: "unknown", kind: "complete", instruction: "Tell {{slot.first_name}} we could not find them.", ordinal: 1 }],
    };

    expect(notGuaranteed(definition)).toEqual([expect.objectContaining({ location: "step:unknown.instruction" })]);
  });

  it("is not reported when every way to the step runs the tool step first", () => {
    expect(notGuaranteed(routineWith([askNumber, lookup, confirm]))).toEqual([]);
  });
});

describe("a reference in step text to a variable a skill step sets from a list", () => {
  const listLookup: Step = {
    ...lookup,
    toolRef: "find_orders",
    metadata: { outputAssignments: { orders: "found_orders", status: "order_status" } },
  };
  const descriptor: SkillAuthoringDescriptor = {
    skillName: "find_orders",
    displayName: "Find orders",
    category: "api_request",
    inputs: [],
    outcomes: [{ name: "completed", displayName: "completed", status: "completed" }],
    hasDataOutputs: true,
    outputs: [
      { name: "orders", type: "list", required: false, fields: [{ name: "title", type: "text", role: "title" }] },
      { name: "status", type: "text", required: false },
    ],
  };
  const listed = (finish: string, withCatalog = true) =>
    validateRoutineDefinition(routineWith([askNumber, listLookup], finish), withCatalog ? { skillDescriptors: new Map([["find_orders", descriptor]]) } : {})
      .diagnostics.filter((diagnostic) => diagnostic.code === "referenced_list_variable");

  it("is reported, since a list renders as nothing a visitor can read", () => {
    expect(listed("Tell them {{slot.found_orders}}.")).toEqual([expect.objectContaining({ location: "step:done.instruction" })]);
  });

  it("is not reported for a scalar output the same step sets", () => {
    expect(listed("Tell them the status is {{slot.order_status}}.")).toEqual([]);
  });

  it("is checked only where the skill catalog is known", () => {
    expect(listed("Tell them {{slot.found_orders}}.", false)).toEqual([]);
  });
});
