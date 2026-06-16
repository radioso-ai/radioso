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

describe("routine definition compiler and validator", () => {
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
    ["referenced-but-undeclared slot", (def: RoutineDefinition) => ({ ...def, steps: [{ ...def.steps[0]!, instruction: "Ask for {{slot.missing}}." }, def.steps[1]!] })],
    ["attempt-limit-without-fallback", (def: RoutineDefinition) => ({ ...def, steps: [{ ...def.steps[0]!, metadata: { attemptLimit: 2 } }, def.steps[1]!] })],
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
    expect(rows.get("conv_1")).toBeUndefined();
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
