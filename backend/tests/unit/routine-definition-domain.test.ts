import { describe, expect, it } from "vitest";

import { createConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import { RoutineRegistry } from "@radioso/conversation-defaults";
import type {
  ConversationEvent,
  ConversationRoutineNextStepSelector,
  ConversationRoutineStepRenderer,
  ConversationRoutineStore,
  ProcessTurnInput,
  RoutineState,
} from "@radioso/conversation-contract";

import {
  compileRoutineDefinition,
  routineDefinitionDraftInputSchema,
  routineStepSchema,
  routineGuardProvenance,
  validateRoutineDefinition,
  type RoutineDefinition,
  type RoutineGuardKind,
} from "../../src/modules/routines/public.js";

const baseDefinition = (): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "handoff",
  version: 1,
  status: "published",
  activation: {
    triggerDescription: "The user asks to send a handoff request.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "Visitor name.", ordinal: 0 },
    { stableSlotId: "slot_topic", key: "topic", type: "text", required: true, description: "Conversation topic.", ordinal: 1 },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_topic", kind: "chat", instruction: "Ask for {{slot.topic}}.", toolRef: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
    { fromStep: "ask_topic", toRef: "done", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 1 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 },
  ],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
});

describe("routine reentry mode (issue #746)", () => {
  const draftActivation = {
    triggerDescription: "The user asks to send a handoff request.",
    priority: 10,
  };
  const draftBody = {
    name: "handoff",
    steps: [
      { stableStepId: "ask_name", kind: "chat" as const, instruction: "Ask for the name.", ordinal: 0 },
    ],
    terminals: [
      { stableStepId: "done", kind: "complete" as const, instruction: "Confirm completion.", ordinal: 0 },
    ],
  };

  it("defaults reentryMode to once_per_conversation when omitted", () => {
    const parsed = routineDefinitionDraftInputSchema.parse({
      ...draftBody,
      activation: { ...draftActivation },
    });
    expect(parsed.activation.reentryMode).toBe("once_per_conversation");
  });

  it("accepts the always and semantic reentry modes", () => {
    for (const mode of ["always", "semantic", "once_per_conversation"] as const) {
      const parsed = routineDefinitionDraftInputSchema.parse({
        ...draftBody,
        activation: { ...draftActivation, reentryMode: mode },
      });
      expect(parsed.activation.reentryMode).toBe(mode);
    }
  });

  it("rejects an unknown reentry mode", () => {
    expect(() => routineDefinitionDraftInputSchema.parse({
      ...draftBody,
      activation: { ...draftActivation, reentryMode: "whenever" },
    })).toThrow();
  });

  it("compiles reentryMode onto the routine's typed activation", () => {
    const definition = baseDefinition();
    definition.activation.reentryMode = "always";
    const routine = compileRoutineDefinition(definition);
    expect(routine.activation?.reentryMode).toBe("always");
  });

  it("defaults compiled reentryMode to once_per_conversation for legacy definitions", () => {
    // A definition parsed before the field existed has no reentryMode; the compiler
    // must still emit a safe default so existing routines keep suppressing on completion.
    const definition = baseDefinition();
    delete (definition.activation as { reentryMode?: unknown }).reentryMode;
    const routine = compileRoutineDefinition(definition);
    expect(routine.activation?.reentryMode).toBe("once_per_conversation");
  });
});

describe("routine mutable slots (issue #746)", () => {
  it("parses an authored mutable slot and leaves legacy slots immutable", () => {
    const parsed = routineDefinitionDraftInputSchema.parse({
      name: "intake",
      activation: { triggerDescription: "Capture contact details.", priority: 0 },
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, ordinal: 0, mutable: true },
        { stableSlotId: "slot_name", key: "name", type: "text", required: true, ordinal: 1 },
      ],
      steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask for {{slot.email}}.", ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
    });
    expect(parsed.slots[0]?.mutable).toBe(true);
    expect(parsed.slots[1]?.mutable).toBeUndefined();
  });

  it("compiles the mutable flag onto the routine slot schema only when set", () => {
    const definition = baseDefinition();
    definition.slots = [
      { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0, mutable: true },
      { stableSlotId: "slot_topic", key: "topic", type: "text", required: true, description: null, ordinal: 1 },
    ];
    const routine = compileRoutineDefinition(definition);
    expect(routine.slots).toEqual([
      { id: "slot_name", key: "name", type: "text", required: true, mutable: true },
      { id: "slot_topic", key: "topic", type: "text", required: true },
    ]);
  });
});

describe("routine definition compiler and validator", () => {
  it("parses typed skill-step bindings in metadata and preserves author metadata", () => {
    const parsed = routineStepSchema.parse({
      stableStepId: "lookup",
      kind: "tool",
      instruction: "Look up the order.",
      toolRef: "order_lookup",
      actionType: null,
      ordinal: 0,
      metadata: {
        authorNote: "shown in authoring",
        inputBindings: {
          email: { kind: "variableRef", ref: "email" },
          cart: { kind: "contextVariableRef", contextVariable: "cart" },
          includeHistory: { kind: "literal", value: true },
          retryCount: { kind: "literal", value: 2 },
          locale: { kind: "literal", value: "en-US" },
        },
        outputAssignments: {
          status: "order_status",
          total: "order_total",
        },
        mode: "typed",
      },
    });

    expect(parsed.metadata).toEqual({
      authorNote: "shown in authoring",
      inputBindings: {
        email: { kind: "variableRef", ref: "email" },
        cart: { kind: "contextVariableRef", contextVariable: "cart" },
        includeHistory: { kind: "literal", value: true },
        retryCount: { kind: "literal", value: 2 },
        locale: { kind: "literal", value: "en-US" },
      },
      outputAssignments: {
        status: "order_status",
        total: "order_total",
      },
      mode: "typed",
    });
  });

  it("rejects an unknown typed skill-step binding kind", () => {
    expect(() => routineStepSchema.parse({
      stableStepId: "lookup",
      kind: "tool",
      instruction: "Look up the order.",
      toolRef: "order_lookup",
      actionType: null,
      ordinal: 0,
      metadata: {
        inputBindings: {
          email: { kind: "slot", ref: "email" },
        },
      },
    })).toThrow();
  });

  it("compiles an authored definition to the current 069 Routine graph", () => {
    const routine = compileRoutineDefinition(baseDefinition());

    expect(routine).toMatchObject({
      // Compiled id = definition id (directive scope-tag identity).
      id: "def_1",
      rootStepId: "ask_name",
      steps: [
        { id: "ask_name", kind: "chat", action: "Ask for {{slot.name}}.", metadata: { collectsSlots: ["name"] } },
        { id: "ask_topic", kind: "chat", action: "Ask for {{slot.topic}}.", metadata: { collectsSlots: ["topic"] } },
        { id: "done", kind: "terminal", action: "Confirm completion." },
      ],
      transitions: [
        { from: "ask_name", to: "ask_topic", condition: "The user provided {{slot.name}}." },
        { from: "ask_topic", to: "done", condition: "The user provided {{slot.topic}}." },
      ],
    });
    expect(routine.metadata?.slotSchema).toEqual([
      { id: "slot_name", key: "name", type: "text", required: true, description: "Visitor name." },
      { id: "slot_topic", key: "topic", type: "text", required: true, description: "Conversation topic." },
    ]);
    expect(routine.slots).toEqual([
      { id: "slot_name", key: "name", type: "text", required: true, description: "Visitor name." },
      { id: "slot_topic", key: "topic", type: "text", required: true, description: "Conversation topic." },
    ]);
    expect(validateRoutineDefinition(baseDefinition())).toEqual({ ok: true, diagnostics: [] });
  });

  it("compiles publishable structured transition guards additively", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
      ],
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "done", guardKind: "slot_filled", guardText: "{{slot.email}}", ordinal: 0 },
        { fromStep: "ask_email", toRef: "handoff", guardKind: "counter", guardText: "2", ordinal: 1 },
        { fromStep: "ask_email", toRef: "handoff", guardKind: "default", guardText: null, ordinal: 2 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 },
        { stableStepId: "handoff", kind: "handoff", instruction: "Route to a human.", ordinal: 1 },
      ],
    };

    const routine = compileRoutineDefinition(definition);

    expect(routine.transitions).toEqual([
      { from: "ask_email", to: "done", condition: "slot_filled", guard: { kind: "slot_filled", slots: ["email"] } },
      { from: "ask_email", to: "handoff", condition: "counter", guard: { kind: "counter", limit: 2 } },
      { from: "ask_email", to: "handoff", condition: "default", guard: { kind: "default" } },
    ]);
  });

  it("auto-gates a slot-collection step whose only exit is a default edge so the selector runs", () => {
    // Authoring tools wire a plain numbered step list with bare `default` edges. The
    // runner advances those unconditionally and WITHOUT the selector, so the asked-for
    // slot is never captured. The compiler promotes such an edge to an llm (selector-
    // running) transition that both extracts the slot and waits for the user's answer.
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
        { stableStepId: "wrap", kind: "chat", instruction: "Thank the user.", toolRef: null, ordinal: 1, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "wrap", guardKind: "default", guardText: null, ordinal: 0 },
        { fromStep: "wrap", toRef: "done", guardKind: "llm", guardText: "The user acknowledged.", ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 },
      ],
    };

    const routine = compileRoutineDefinition(definition);
    const collectEdge = routine.transitions.find((transition) => transition.from === "ask_email");

    // Promoted to a selector-running transition: no structured guard, slot-aware condition.
    expect(collectEdge?.guard).toBeUndefined();
    expect(collectEdge?.condition).toContain("{{slot.email}}");
    // A non-collecting step keeps whatever it was authored with.
    expect(routine.transitions.find((transition) => transition.from === "wrap")).toMatchObject({
      condition: "The user acknowledged.",
    });
  });

  it("treats only the first step that references a slot as collecting it (later refs are uses)", () => {
    // A later step that merely interpolates an already-collected slot (e.g. "mention
    // their {{slot.name}}") must NOT be marked as a collection step — otherwise the
    // runner fast-forwards (skips) it once the slot is filled and silently drops its
    // message. Only the first step to reference a slot collects it.
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      slots: [
        { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0 },
      ],
      steps: [
        { stableStepId: "ask_name", kind: "chat", instruction: "Ask for their name; record as {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
        { stableStepId: "redirect", kind: "chat", instruction: "Redirect to the main purpose; mention their {{slot.name}}.", toolRef: null, ordinal: 1, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_name", toRef: "redirect", guardKind: "default", guardText: null, ordinal: 0 },
        { fromStep: "redirect", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "All set.", ordinal: 0 },
      ],
    };

    const routine = compileRoutineDefinition(definition);

    // The first referencer collects the slot and is auto-gated.
    const askName = routine.steps.find((step) => step.id === "ask_name");
    expect(askName?.metadata?.collectsSlots).toEqual(["name"]);
    expect(routine.transitions.find((transition) => transition.from === "ask_name")?.guard).toBeUndefined();

    // The later step only *uses* the slot: not a collection step, default edge intact,
    // so the runner renders it rather than skipping it.
    const redirect = routine.steps.find((step) => step.id === "redirect");
    expect(redirect?.metadata?.collectsSlots).toBeUndefined();
    expect(routine.transitions.find((transition) => transition.from === "redirect")).toMatchObject({
      condition: "default",
      guard: { kind: "default" },
    });
  });

  it("does not let a lower-ordinal tool step steal slot ownership from the chat step that asks it", () => {
    // Only a chat step asks the user for a slot. A tool/action step that interpolates
    // {{slot.x}} at a lower ordinal must NOT be treated as the collector — otherwise the
    // chat asker loses its collectsSlots and is no longer auto-gated, so the slot is
    // never captured.
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      slots: [
        { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0 },
      ],
      steps: [
        { stableStepId: "prep", kind: "tool", instruction: "Look up records for {{slot.name}}.", toolRef: "crm_lookup", ordinal: 0, metadata: {} },
        { stableStepId: "ask_name", kind: "chat", instruction: "Ask for their name; record as {{slot.name}}.", toolRef: null, ordinal: 1, metadata: {} },
      ],
      transitions: [
        { fromStep: "prep", toRef: "ask_name", guardKind: "default", guardText: null, ordinal: 0 },
        { fromStep: "ask_name", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 },
      ],
    };

    const routine = compileRoutineDefinition(definition);

    // The chat asker owns the slot and is auto-gated, even though the tool step
    // references it at a lower ordinal.
    const askName = routine.steps.find((step) => step.id === "ask_name");
    expect(askName?.metadata?.collectsSlots).toEqual(["name"]);
    expect(routine.transitions.find((transition) => transition.from === "ask_name")?.guard).toBeUndefined();
    // The tool step does not own the slot.
    const prep = routine.steps.find((step) => step.id === "prep");
    expect(prep?.metadata?.collectsSlots).toBeUndefined();
  });

  it("leaves a default edge intact when the collection step also has a structured or llm exit", () => {
    // The additive-guards fixture (ask_email with slot_filled + counter + default) is a
    // deliberately structured step — its `default` fallback must survive compilation.
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "done", guardKind: "slot_filled", guardText: "{{slot.email}}", ordinal: 0 },
        { fromStep: "ask_email", toRef: "handoff", guardKind: "default", guardText: null, ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 },
        { stableStepId: "handoff", kind: "handoff", instruction: "Route to a human.", ordinal: 1 },
      ],
    };

    const routine = compileRoutineDefinition(definition);
    expect(routine.transitions.find((transition) => transition.to === "handoff")).toEqual({
      from: "ask_email",
      to: "handoff",
      condition: "default",
      guard: { kind: "default" },
    });
  });

  it("compiles completion export into the routine contract", () => {
    const routine = compileRoutineDefinition({
      ...baseDefinition(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: "33333333-3333-4333-8333-333333333333",
      },
    });

    expect(routine.completionExport).toEqual({
      enabled: true,
      triggerKinds: ["complete"],
      destinationRef: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("is deterministic for the same authored document", () => {
    expect(compileRoutineDefinition(baseDefinition())).toEqual(compileRoutineDefinition(baseDefinition()));
  });

  it.each([
    ["unreachable step", (def: RoutineDefinition) => ({ ...def, steps: [...def.steps, { stableStepId: "orphan", kind: "chat" as const, instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 2, metadata: {} }] })],
    ["missing terminal", (def: RoutineDefinition) => ({ ...def, terminals: [] })],
    ["dangling action reference", (def: RoutineDefinition) => ({
      ...def,
      steps: [
        ...def.steps,
        { stableStepId: "send", kind: "action" as const, instruction: "Emit side effect.", toolRef: null, actionType: null, ordinal: 2, metadata: {} },
      ],
      transitions: [
        ...def.transitions,
        { fromStep: "ask_topic", toRef: "send", guardKind: "default" as const, guardText: null, ordinal: 1 },
        { fromStep: "send", toRef: "done", guardKind: "default" as const, guardText: null, ordinal: 2 },
      ],
    })],
    ["missing action follow-up", (def: RoutineDefinition) => ({
      ...def,
      steps: [
        ...def.steps,
        { stableStepId: "send", kind: "action" as const, instruction: "Emit side effect.", toolRef: null, actionType: "contact.send", ordinal: 2, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm" as const, guardText: "The user provided {{slot.name}}.", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "send", guardKind: "llm" as const, guardText: "The user provided {{slot.topic}}.", ordinal: 1 },
      ],
    })],
    ["declared-but-unused slot", (def: RoutineDefinition) => ({ ...def, slots: [...def.slots, { stableSlotId: "slot_unused", key: "unused", type: "text" as const, required: false, description: null, ordinal: 2 }] })],
    ["referenced-but-undeclared slot", (def: RoutineDefinition) => ({ ...def, steps: [{ ...def.steps[0], instruction: "Ask for {{slot.missing}}." }, def.steps[1]] })],
    ["attempt-limit-without-fallback", (def: RoutineDefinition) => ({ ...def, steps: [{ ...def.steps[0], metadata: { attemptLimit: 2 } }, def.steps[1]] })],
  ])("reports %s in author terms", (label, mutate) => {
    const result = validateRoutineDefinition(mutate(baseDefinition()));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(label);
    expect(result.diagnostics[0]?.location).toBeTruthy();
    expect(() => compileRoutineDefinition(mutate(baseDefinition()))).toThrow("routine_definition_invalid");
  });

  it("reports counter guards without a fallback terminal path in author terms", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "counter", guardText: "2", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "done", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "attempt_limit_without_fallback",
      location: "transition:ask_name->ask_topic",
    }));
  });

  it("accepts a counter-guarded back-edge with a fallback terminal path", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "ask_name", guardKind: "counter", guardText: null, counterLimit: 2, ordinal: 1 },
        { fromStep: "ask_topic", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
      ],
    };

    expect(validateRoutineDefinition(definition)).toEqual({ ok: true, diagnostics: [] });
  });

  it.each([
    ["llm", { guardText: "The visitor wants to restart." }],
    ["default", { guardText: null }],
    ["field", { guardText: null, fieldRef: "topic", fieldOp: "is_present" }],
  ] as const)("rejects an unbounded %s-guarded back-edge", (guardKind, guardFields) => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "ask_name", guardKind, ...guardFields, ordinal: 1 },
        { fromStep: "ask_topic", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unbounded_back_edge",
      location: "transition:ask_topic->ask_name",
      message: expect.stringContaining("must use a counter guard"),
    }));
  });

  it("rejects an unbounded same-step transition as a back-edge", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "ask_topic", guardKind: "llm", guardText: "The visitor needs to answer again.", ordinal: 1 },
        { fromStep: "ask_topic", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
      ],
    };

    expect(validateRoutineDefinition(definition).diagnostics).toContainEqual(expect.objectContaining({
      code: "unbounded_back_edge",
      location: "transition:ask_topic->ask_topic",
    }));
  });

  it.each([
    ["llm", { guardText: "The visitor is ready for the summary." }],
    ["default", { guardText: null }],
    ["field", { guardText: null, fieldRef: "name", fieldOp: "is_present" }],
    ["counter", { guardText: null, counterLimit: 2 }],
  ] as const)("allows a forward %s-guarded step jump", (guardKind, guardFields) => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        ...baseDefinition().steps,
        { stableStepId: "summarize", kind: "chat", instruction: "Summarize {{slot.name}} and {{slot.topic}}.", toolRef: null, ordinal: 2, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "default", guardText: null, ordinal: 0 },
        { fromStep: "ask_name", toRef: "summarize", guardKind, ...guardFields, ordinal: 1 },
        { fromStep: "ask_name", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
        { fromStep: "ask_topic", toRef: "done", guardKind: "default", guardText: null, ordinal: 3 },
        { fromStep: "summarize", toRef: "done", guardKind: "default", guardText: null, ordinal: 4 },
      ],
    };

    expect(validateRoutineDefinition(definition)).toEqual({ ok: true, diagnostics: [] });
  });

  it("keeps unknown step targets as dangling step references", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "missing_step", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "dangling_step_reference",
      location: "transition:ask_topic->missing_step",
    }));
  });

  it("reports outcome guards leaving non-tool steps in author terms", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "outcome", guardText: "completed", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "done", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "outcome_guard_on_non_tool_step",
      location: "transition:ask_name->ask_topic",
    }));
  });

  it("compiles a tool step to a skill step dispatched through the skill port", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
        { stableStepId: "lookup", kind: "tool", instruction: "Look up order.", toolRef: "order_lookup", ordinal: 1, metadata: {} },
      ],
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "lookup", guardKind: "slot_filled", guardText: "{{slot.email}}", ordinal: 0 },
        { fromStep: "lookup", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };

    // Routine tool dispatch now exists (RoutineSkillExecutorDispatcher), so a
    // tool step is publishable; it compiles to a skill step the runner dispatches
    // through the shared skill-executor port, naming the authored skill.
    expect(validateRoutineDefinition(definition)).toEqual({ ok: true, diagnostics: [] });
    expect(compileRoutineDefinition(definition).steps).toContainEqual(
      expect.objectContaining({ id: "lookup", kind: "skill", skillName: "order_lookup" }),
    );
  });

  it("compiles typed skill-step bindings onto the routine step contract", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
        {
          stableStepId: "lookup",
          kind: "tool",
          instruction: "Look up order.",
          toolRef: "order_lookup",
          ordinal: 1,
          metadata: {
            inputBindings: {
              email: { kind: "variableRef", ref: "email" },
              includeHistory: { kind: "literal", value: true },
            },
            outputAssignments: {
              status: "order_status",
            },
            mode: "typed",
          },
        },
      ],
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "lookup", guardKind: "slot_filled", guardText: "{{slot.email}}", ordinal: 0 },
        { fromStep: "lookup", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };

    expect(compileRoutineDefinition(definition).steps).toContainEqual(
      expect.objectContaining({
        id: "lookup",
        kind: "skill",
        skillName: "order_lookup",
        inputBindings: {
          email: { kind: "variableRef", ref: "email" },
          includeHistory: { kind: "literal", value: true },
        },
        outputAssignments: {
          status: "order_status",
        },
        mode: "typed",
      }),
    );
  });

  it("leaves compiled skill steps unchanged when they have no typed bindings", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        { stableStepId: "lookup", kind: "tool", instruction: "Look up order.", toolRef: "order_lookup", ordinal: 0, metadata: {} },
      ],
      slots: [],
      transitions: [
        { fromStep: "lookup", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 },
      ],
    };

    const step = compileRoutineDefinition(definition).steps.find((candidate) => candidate.id === "lookup");

    expect(step).toEqual({
      id: "lookup",
      kind: "skill",
      skillName: "order_lookup",
      action: "Look up order.",
      metadata: { authoredKind: "tool" },
    });
  });

  it("rejects a tool step that names no skill", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
        { stableStepId: "lookup", kind: "tool", instruction: "Look up order.", toolRef: null, ordinal: 1, metadata: {} },
      ],
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "lookup", guardKind: "slot_filled", guardText: "{{slot.email}}", ordinal: 0 },
        { fromStep: "lookup", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "dangling_action_reference",
      location: "step:lookup",
    }));
  });

  it("compiles an action step with its authored follow-up transition", () => {
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      steps: [
        ...baseDefinition().steps,
        { stableStepId: "send", kind: "action", instruction: "Emit side effect.", toolRef: null, actionType: "contact.send", ordinal: 2, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_name", toRef: "ask_topic", guardKind: "llm", guardText: "The user provided {{slot.name}}.", ordinal: 0 },
        { fromStep: "ask_topic", toRef: "send", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 1 },
        { fromStep: "send", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
      ],
    };

    const routine = compileRoutineDefinition(definition);

    expect(routine.steps).toContainEqual(expect.objectContaining({
      id: "send",
      kind: "action",
      actionType: "contact.send",
    }));
    expect(routine.transitions).toContainEqual({
      from: "send",
      to: "done",
      condition: "default",
      guard: { kind: "default" },
    });
  });

  it("runs an authored two-slot/two-step compiled routine through the existing 069 runtime", async () => {
    const routine = compileRoutineDefinition(baseDefinition());
    const registry = new RoutineRegistry([{ routine, trigger: { description: "Start test routine", priority: 0 } }]);
    const rows = new Map<string, RoutineState>();
    const store: ConversationRoutineStore = {
      loadActive: async ({ sessionId }) => rows.get(sessionId) ?? null,
      save: async (state) => { rows.set(state.sessionId, state); },
      clear: async ({ sessionId }) => { rows.delete(sessionId); },
    };
    // Faithful fake: like the real LLM selector, only advance off a step when the
    // user's message actually satisfies its guard. The activation/trigger turn
    // ("start") carries no name, so the routine stays at and renders its root step.
    const selector: ConversationRoutineNextStepSelector = {
      async select({ currentStep, turn }) {
        const content = turn.inputEvent.content;
        if (currentStep.id === "ask_name") {
          if (content === "start") return { nextStepId: "ask_name" };
          return { nextStepId: "ask_topic", variables: { name: content } };
        }
        if (currentStep.id === "ask_topic") {
          return { nextStepId: "done", variables: { topic: content } };
        }
        return { nextStepId: currentStep.id };
      },
    };
    const renderer: ConversationRoutineStepRenderer = {
      render: async ({ step }) => ({ answer: step.id }),
    };
    const events: ConversationEvent[] = [];
    const input = (content: string): ProcessTurnInput => ({
      agent: { id: "agent_1" },
      sessionId: "conv_1",
      inputEvent: { kind: "message", content },
      skills: [],
      directives: [],
      stores: {
        loadHistory: async () => [],
        appendEvent: async (event) => { events.push(event); },
      },
      modelGateway: { complete: async () => ({ text: "" }) },
      directiveMatcher: { match: async () => [] },
      selector: { select: async () => ({ selected: [], reason: "none" }) },
      dispatcher: { dispatch: async () => { throw new Error("unexpected normal dispatch"); } },
      composer: { compose: async () => ({ answer: "normal" }) },
      routineStore: store,
      routineRunner: new DefaultRoutineRunner([routine], selector, renderer),
      routineActivator: registry.activator({
        complete: async () => ({
          text: JSON.stringify({ matches: [{ routineId: routine.id, confidence: 0.95 }] }),
        }),
      }),
    });

    const engine = createConversationEngine();
    expect((await engine.processTurn(input("start"))).response.answer).toBe("ask_name");
    expect((await engine.processTurn(input("Alex"))).response.answer).toBe("ask_topic");
    expect((await engine.processTurn(input("Pricing"))).response.answer).toBe("done");
    expect(rows.get("conv_1")).toMatchObject({
      status: "completed",
      metadata: { terminalKind: "complete", terminalStepId: "done" },
    });
  });

  it("auto-gated bare-default collection step routes through the selector and captures the slot at runtime", async () => {
    // The behaviour the compile-time auto-gate exists to deliver, proven through the
    // real runtime. The collection step is authored with a bare `default` edge; before
    // the auto-gate, the runner advanced past it via the no-selector fast path, so the
    // slot was never captured and the wait was skipped. Drive the compiled routine
    // through the engine and assert the opposite: it waits, the selector runs, and the
    // slot lands in state.
    const definition: RoutineDefinition = {
      ...baseDefinition(),
      slots: [
        { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
      ],
      steps: [
        { stableStepId: "ask_email", kind: "chat", instruction: "Ask for {{slot.email}}.", toolRef: null, ordinal: 0, metadata: {} },
        { stableStepId: "wrap", kind: "chat", instruction: "Thank the user.", toolRef: null, ordinal: 1, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_email", toRef: "wrap", guardKind: "default", guardText: null, ordinal: 0 },
        { fromStep: "wrap", toRef: "done", guardKind: "llm", guardText: "The user acknowledged.", ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Confirm completion.", ordinal: 0 },
      ],
    };
    const routine = compileRoutineDefinition(definition);
    const registry = new RoutineRegistry([{ routine, trigger: { description: "Start test routine", priority: 0 } }]);
    const rows = new Map<string, RoutineState>();
    const store: ConversationRoutineStore = {
      loadActive: async ({ sessionId }) => rows.get(sessionId) ?? null,
      save: async (state) => { rows.set(state.sessionId, state); },
      clear: async ({ sessionId }) => { rows.delete(sessionId); },
    };
    // The selector is the only place variables are extracted; advance off the collection
    // step only once the user actually supplies an email. A bare-default (non-promoted)
    // edge would never reach this function.
    let askEmailSelectorCalls = 0;
    const selector: ConversationRoutineNextStepSelector = {
      async select({ currentStep, turn }) {
        const content = turn.inputEvent.content;
        if (currentStep.id === "ask_email") {
          askEmailSelectorCalls += 1;
          if (!content.includes("@")) return { nextStepId: "ask_email" };
          return { nextStepId: "wrap", variables: { email: content } };
        }
        if (currentStep.id === "wrap") return { nextStepId: "done" };
        return { nextStepId: currentStep.id };
      },
    };
    const renderer: ConversationRoutineStepRenderer = {
      render: async ({ step }) => ({ answer: step.id }),
    };
    const events: ConversationEvent[] = [];
    const input = (content: string): ProcessTurnInput => ({
      agent: { id: "agent_1" },
      sessionId: "conv_email",
      inputEvent: { kind: "message", content },
      skills: [],
      directives: [],
      stores: {
        loadHistory: async () => [],
        appendEvent: async (event) => { events.push(event); },
      },
      modelGateway: { complete: async () => ({ text: "" }) },
      directiveMatcher: { match: async () => [] },
      selector: { select: async () => ({ selected: [], reason: "none" }) },
      dispatcher: { dispatch: async () => { throw new Error("unexpected normal dispatch"); } },
      composer: { compose: async () => ({ answer: "normal" }) },
      routineStore: store,
      routineRunner: new DefaultRoutineRunner([routine], selector, renderer),
      routineActivator: registry.activator({
        complete: async () => ({
          text: JSON.stringify({ matches: [{ routineId: routine.id, confidence: 0.95 }] }),
        }),
      }),
    });

    const engine = createConversationEngine();
    // Activation turn carries no email: the step WAITS (the pre-fix default fast path
    // would have skipped straight to "wrap").
    expect((await engine.processTurn(input("start"))).response.answer).toBe("ask_email");
    // The answer turn advances, and the slot is captured into routine state.
    expect((await engine.processTurn(input("alex@example.com"))).response.answer).toBe("wrap");
    expect(rows.get("conv_email")?.variables).toEqual({ email: "alex@example.com" });
    // The collection step was routed through the selector — the no-selector default fast
    // path would have left this counter at 0.
    expect(askEmailSelectorCalls).toBeGreaterThanOrEqual(2);
    expect((await engine.processTurn(input("thanks"))).response.answer).toBe("done");
    expect(rows.get("conv_email")).toMatchObject({
      status: "completed",
      metadata: { terminalKind: "complete", terminalStepId: "done" },
    });
  });
});

describe("routine field guards (deterministic branch-on-value) and provenance", () => {
  // A routine that branches on a value rather than the model — the deterministic
  // procedures spec FR-4. The eligibility gate decides in code; only the residual is llm.
  const fieldDefinition = (): RoutineDefinition => ({
    ...baseDefinition(),
    slots: [{ stableSlotId: "is_final_sale", key: "is_final_sale", type: "boolean", required: true, description: "Final sale flag", ordinal: 0 }],
    steps: [
      { stableStepId: "check", kind: "chat", instruction: "Check the order status.", toolRef: null, ordinal: 0, metadata: {} },
    ],
    transitions: [
      { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, fieldRef: "is_final_sale", fieldOp: "is_true", ordinal: 0 },
      { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
    ],
    terminals: [
      { stableStepId: "explain", kind: "complete", instruction: "Explain the policy.", ordinal: 0 },
      { stableStepId: "refund", kind: "complete", instruction: "Issue the refund.", ordinal: 1 },
    ],
  });

  it("compiles a field guard into the routine contract", () => {
    const routine = compileRoutineDefinition(fieldDefinition());
    expect(routine.transitions).toEqual([
      { from: "check", to: "explain", condition: "field", guard: { kind: "field", ref: "is_final_sale", op: "is_true" } },
      { from: "check", to: "refund", condition: "default", guard: { kind: "default" } },
    ]);
    expect(validateRoutineDefinition(fieldDefinition())).toEqual({ ok: true, diagnostics: [] });
  });

  it("compiles equals/in field guards with their values", () => {
    const definition: RoutineDefinition = {
      ...fieldDefinition(),
      slots: [{ stableSlotId: "status", key: "status", type: "text", required: true, description: "Order status", ordinal: 0 }],
      transitions: [
        { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, fieldRef: "status", fieldOp: "in", fieldValues: ["closed", "void"], ordinal: 0 },
        { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };
    const routine = compileRoutineDefinition(definition);
    expect(routine.transitions[0]).toEqual({
      from: "check",
      to: "explain",
      condition: "field",
      guard: { kind: "field", ref: "status", op: "in", values: ["closed", "void"] },
    });
  });

  it("rejects a field guard with no reference or operator", () => {
    const definition: RoutineDefinition = {
      ...fieldDefinition(),
      slots: [],
      transitions: [
        { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, ordinal: 0 },
        { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };
    const result = validateRoutineDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "structured_guard_missing_parameter",
      location: "transition:check->explain",
    }));
  });

  it("rejects an equals field guard with no value", () => {
    const definition: RoutineDefinition = {
      ...fieldDefinition(),
      slots: [{ stableSlotId: "status", key: "status", type: "text", required: true, description: "Order status", ordinal: 0 }],
      transitions: [
        { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, fieldRef: "status", fieldOp: "equals", ordinal: 0 },
        { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };
    const result = validateRoutineDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "structured_guard_missing_parameter",
    }));
  });

  it("rejects a field guard that references an undeclared variable (honest provenance)", () => {
    const definition: RoutineDefinition = {
      ...fieldDefinition(),
      slots: [],
      transitions: [
        { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, fieldRef: "ghost", fieldOp: "is_true", ordinal: 0 },
        { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };
    const result = validateRoutineDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "field_guard_unknown_reference",
      location: "transition:check->explain",
    }));
  });

  it("rejects an older_than guard on a non-date variable", () => {
    const definition: RoutineDefinition = {
      ...fieldDefinition(),
      slots: [{ stableSlotId: "status", key: "status", type: "text", required: true, description: "Order status", ordinal: 0 }],
      transitions: [
        { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, fieldRef: "status", fieldOp: "older_than", fieldValue: 6, fieldUnit: "months", ordinal: 0 },
        { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };
    const result = validateRoutineDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "field_guard_incompatible_type",
      location: "transition:check->explain",
    }));
  });

  it("accepts an older_than guard on a date variable", () => {
    const definition: RoutineDefinition = {
      ...fieldDefinition(),
      slots: [{ stableSlotId: "order_date", key: "order_date", type: "date", required: true, description: "Order date", ordinal: 0 }],
      transitions: [
        { fromStep: "check", toRef: "explain", guardKind: "field", guardText: null, fieldRef: "order_date", fieldOp: "older_than", fieldValue: 6, fieldUnit: "months", ordinal: 0 },
        { fromStep: "check", toRef: "refund", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };
    expect(validateRoutineDefinition(definition)).toEqual({ ok: true, diagnostics: [] });
  });

  it("classifies guard provenance: only llm guards are model judgments", () => {
    expect(routineGuardProvenance("llm")).toBe("judgment");
    const exactKinds: RoutineGuardKind[] = ["default", "slot_filled", "outcome", "counter", "field"];
    for (const kind of exactKinds) {
      expect(routineGuardProvenance(kind)).toBe("exact");
    }
  });
});
