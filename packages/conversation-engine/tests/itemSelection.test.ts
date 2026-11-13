import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineItemSelection,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultRoutineRunner } from "../src/routineRunner.js";
import { slotValuesTraceFields } from "../src/routineTraceSlots.js";
import { correctableSlots, verifySlotCorrection } from "../src/slotCorrection.js";
import { checkSlotValue } from "../src/slotValue.js";
import { stepForReply } from "../src/stepReferences.js";

// The shape the compiler gives a property search (#1763): a brief, a tool step that searches, a
// step that shows its results as cards and binds the visitor's pick, and a hand-off that names it.
const homes = (): Routine => ({
  id: "homes",
  rootStepId: "brief",
  slots: [
    { id: "s_area", key: "area", type: "text", required: true },
    { id: "s_home", key: "chosen_home", type: "item", required: true },
  ],
  steps: [
    { id: "brief", kind: "chat", action: "Ask where they want to live. {{slot.area}}", metadata: { collectsSlots: ["area"] } },
    { id: "search", kind: "skill", skillName: "search_homes" },
    {
      id: "choose",
      kind: "chat",
      action: "Show the matches and ask which one they like.",
      present: { from: "search", selection: "single", slot: "chosen_home" },
      metadata: { collectsSlots: ["chosen_home"] },
    },
    { id: "handoff", kind: "terminal", action: "Tell them an agent will call about {{slot.chosen_home}}.", metadata: { terminalKind: "handoff" } },
  ],
  transitions: [
    { from: "brief", to: "search", condition: "The user provided {{slot.area}}.", guard: { kind: "llm" }, origin: "compiler_slot_gate" },
    { from: "search", to: "choose", condition: "default", guard: { kind: "default" } },
    { from: "choose", to: "handoff", condition: "The user provided {{slot.chosen_home}}.", guard: { kind: "llm" }, origin: "compiler_slot_gate" },
  ],
});

const villa = { key: "/results/1", title: "Villa Rosa", link: "https://homes.example/villa-rosa", fields: { id: "h-2", rooms: 3 } };

const turn = (content: string, itemSelection?: RoutineItemSelection): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content, ...(itemSelection ? { itemSelection } : {}) },
  history: [],
  stagedContext: [],
  steering: [],
});

const state = (path: string[], variables: Record<string, unknown> = {}): RoutineState => ({
  sessionId: "session_1",
  routineId: "homes",
  path,
  variables,
  status: "active",
});

const renderer = (): ConversationRoutineStepRenderer => ({
  render: vi.fn(async ({ step }) => ({ answer: `[${step.id}] ${step.action ?? ""}`.trim() })),
});

const reading = (variables: Record<string, unknown>): ConversationRoutineNextStepSelector => ({
  select: vi.fn(async ({ currentStep }) => ({ nextStepId: currentStep.id, variables })),
});

const search = (): ConversationRoutineSkillDispatcher => ({
  dispatch: vi.fn(async () => ({ status: "completed" as const, outputs: { results: [{ id: "h-1", name: "Casa Blu" }, { id: "h-2", name: "Villa Rosa" }] } })),
});

const pick = (overrides: Partial<RoutineItemSelection> = {}): RoutineItemSelection => ({
  routineId: "homes",
  stepId: "choose",
  slot: "chosen_home",
  item: villa,
  ...overrides,
});

describe("a pick on a presenting step (#1763)", () => {
  it("fills the bound item slot and moves on by the step's structure, with no selector call", async () => {
    const selector = reading({});
    const render = renderer();
    const result = await new DefaultRoutineRunner([homes()], selector, render, search())
      .resume({ turn: turn("Villa Rosa", pick()), state: state(["brief", "search", "choose"], { area: "Mitte" }) });

    expect(selector.select).not.toHaveBeenCalled();
    expect(result.terminal?.kind).toBe("handoff");
    expect(result.response.answer).toBe("[handoff] Tell them an agent will call about Villa Rosa.");
    expect(result.trace?.steps[0]).toEqual({ stepId: "choose", kind: "chat", event: "item_selected", capturedSlotKeys: ["chosen_home"] });
  });

  it.each([
    ["another step", pick({ stepId: "brief" })],
    ["another routine", pick({ routineId: "other" })],
    ["another slot", pick({ slot: "area" })],
    ["an item that does not fit", pick({ item: { ...villa, link: "javascript:alert(1)" } })],
  ])("changes nothing for a pick from %s: the message reads as any reply", async (_label, selection) => {
    const selector = reading({});
    const result = await new DefaultRoutineRunner([homes()], selector, renderer(), search())
      .resume({ turn: turn("Villa Rosa", selection), state: state(["brief", "search", "choose"], { area: "Mitte" }) });

    expect(selector.select).toHaveBeenCalled();
    expect(result.nextState?.variables.chosen_home).toBeUndefined();
    expect(result.nextState?.path.at(-1)).toBe("choose");
  });

  it("does not let a pick from an older reply fill the slot once the run moved past its step", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({}), renderer(), search())
      .resume({ turn: turn("Villa Rosa", pick()), state: state(["brief"]) });

    expect(result.nextState?.variables.chosen_home).toBeUndefined();
  });
});

describe("an item slot read from a message", () => {
  it("is kept on the presenting step, as the name the visitor gave", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({ chosen_home: "Casa Blu" }), renderer(), search())
      .resume({ turn: turn("Casa Blu please"), state: state(["brief", "search", "choose"], { area: "Mitte" }) });

    expect(result.terminal?.kind).toBe("handoff");
    expect(result.terminal?.collected?.chosen_home).toEqual({ key: "Casa Blu", title: "Casa Blu", fields: {} });
  });

  it("is dropped on any other step: only the presenting step's reply names an item", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({ area: "Mitte", chosen_home: "Villa Rosa" }), renderer(), search())
      .resume({ turn: turn("Mitte, and I want Villa Rosa"), state: state(["brief"]) });

    expect(result.nextState?.path.at(-1)).toBe("choose");
    expect(result.nextState?.variables).toEqual({ area: "Mitte" });
  });

  it("is dropped from the values a routine opens with", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({}), renderer(), search())
      .resume({ turn: turn("Villa Rosa in Mitte"), state: state([], { area: "Mitte", chosen_home: "Villa Rosa" }), activationTurn: true });

    expect(result.nextState?.variables.chosen_home).toBeUndefined();
  });

  it("stages the search's records for the presenting step's reply, under the step that ran it", async () => {
    const render = renderer();
    await new DefaultRoutineRunner([homes()], reading({ area: "Mitte" }), render, search())
      .resume({ turn: turn("Mitte"), state: state(["brief"]) });

    const input = vi.mocked(render.render).mock.calls.at(-1)?.[0];
    expect(input?.step.id).toBe("choose");
    expect(input?.step.present).toEqual({ from: "search", selection: "single", slot: "chosen_home" });
    expect(input?.turn.stagedContext).toEqual([
      expect.objectContaining({ kind: "skill_result", source: "search_homes", metadata: expect.objectContaining({ stepId: "search", status: "completed" }) }),
    ]);
  });
});

describe("checkSlotValue for an item", () => {
  it("keeps a card's value as it is", () => {
    expect(checkSlotValue("item", villa)).toEqual({ ok: true, value: villa });
  });

  it("reads a name given in text as an item with no fields", () => {
    expect(checkSlotValue("item", "  Casa Blu ")).toEqual({ ok: true, value: { key: "Casa Blu", title: "Casa Blu", fields: {} } });
  });

  it.each([
    ["a number", 3],
    ["a blank title", { ...villa, title: " " }],
    ["a link that is not a web address", { ...villa, link: "ftp://homes.example/x" }],
    ["a nested field", { ...villa, fields: { photos: ["a"] } }],
    ["too many fields", { ...villa, fields: Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`f${index}`, index])) }],
    ["a missing fields record", { key: "k", title: "t" }],
  ])("rejects %s", (_label, value) => {
    expect(checkSlotValue("item", value)).toEqual({ ok: false, reason: "type_mismatch" });
  });

  it("still rejects an object for a scalar slot", () => {
    expect(checkSlotValue("text", villa)).toEqual({ ok: false, reason: "not_scalar" });
  });
});

describe("an item wherever a scalar is read", () => {
  it("fills {{slot.x}} with the item's title", () => {
    const { step } = stepForReply({ id: "s", kind: "chat", action: "You chose {{slot.chosen_home}}." }, { chosen_home: villa }, [], undefined);
    expect(step.action).toBe("You chose Villa Rosa.");
  });

  it("reads as its title in a trace that carries slot values", () => {
    expect(slotValuesTraceFields(homes(), { chosen_home: villa }, true).slotValues).toEqual([
      { key: "chosen_home", type: "item", value: "Villa Rosa" },
    ]);
  });

  it("is never offered for a correction after the routine completes", () => {
    const slots = [{ id: "s_home", key: "chosen_home", type: "item" as const, required: true, mutable: true }];
    expect(correctableSlots(slots, { chosen_home: villa })).toEqual([]);
    expect(verifySlotCorrection({ slots, slotKey: "chosen_home", rawValue: "Casa Blu" })).toEqual({ ok: false, reason: "immutable" });
  });
});
