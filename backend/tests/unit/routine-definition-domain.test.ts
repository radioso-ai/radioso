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
  validateRoutineDefinition,
  type RoutineDefinition,
} from "../../src/modules/routines/public.js";

const baseDefinition = (): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
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
      id: "routine:agent_1:handoff:v1",
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
        { fromStep: "ask_email", toRef: "handoff", guardKind: "fallback", guardText: null, ordinal: 2 },
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
      { from: "ask_email", to: "handoff", condition: "fallback", guard: { kind: "fallback" } },
    ]);
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
        { fromStep: "ask_topic", toRef: "send", guardKind: "always" as const, guardText: null, ordinal: 1 },
        { fromStep: "send", toRef: "done", guardKind: "always" as const, guardText: null, ordinal: 2 },
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

  it("rejects tool steps until routine skill dispatch is supported", () => {
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
        { fromStep: "lookup", toRef: "done", guardKind: "always", guardText: null, ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unsupported_tool_step",
      location: "step:lookup",
      message: expect.stringContaining("tool steps are not yet supported"),
    }));
    expect(() => compileRoutineDefinition(definition)).toThrow("tool steps are not yet supported");
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
        { fromStep: "send", toRef: "done", guardKind: "always", guardText: null, ordinal: 2 },
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
      condition: "always",
      guard: { kind: "always" },
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
