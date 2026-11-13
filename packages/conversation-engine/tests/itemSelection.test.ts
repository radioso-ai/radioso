import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineConsentPort,
  ConversationRoutineNextStepSelector,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineItemSelection,
  RoutineShownItems,
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
const homes = (over: Partial<Routine> = {}): Routine => ({
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
  ...over,
});

const casa = { key: "/results/0", title: "Casa Blu", link: "https://homes.example/casa-blu", fields: { id: "h-1" } };
const villa = { key: "/results/1", title: "Villa Rosa", link: "https://homes.example/villa-rosa", fields: { id: "h-2", rooms: 3 } };

const shown = (over: Partial<RoutineShownItems> = {}): RoutineShownItems => ({
  routineId: "homes", stepId: "choose", executionId: "run-1", messageId: "msg-cards", items: [casa, villa], ...over,
});

const pick = (over: Partial<RoutineItemSelection> = {}): RoutineItemSelection => ({
  routineId: "homes", stepId: "choose", executionId: "run-1", messageId: "msg-cards", slot: "chosen_home", item: villa, ...over,
});

const turn = (content: string, events: { itemSelection?: RoutineItemSelection; shownItems?: RoutineShownItems } = {}): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content, ...events },
  history: [],
  stagedContext: [],
  steering: [],
});

const state = (path: string[], variables: Record<string, unknown> = {}, executionId = "run-1"): RoutineState => ({
  sessionId: "session_1",
  routineId: "homes",
  executionId,
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

const atChoose = state(["brief", "search", "choose"], { area: "Mitte" });

describe("a pick on a presenting step (#1763)", () => {
  it("fills the bound item slot from the step's latest presentation and moves on with no selector call", async () => {
    const selector = reading({});
    const onItemPick = vi.fn();
    const result = await new DefaultRoutineRunner([homes()], selector, renderer(), search(), { onItemPick })
      .resume({ turn: turn("Villa Rosa", { itemSelection: pick(), shownItems: shown() }), state: atChoose });

    expect(selector.select).not.toHaveBeenCalled();
    expect(result.terminal?.kind).toBe("handoff");
    expect(result.terminal?.collected?.chosen_home).toEqual(villa);
    expect(result.response.answer).toBe("[handoff] Tell them an agent will call about Villa Rosa.");
    expect(result.trace?.steps[0]).toEqual({ stepId: "choose", kind: "chat", event: "item_selected", capturedSlotKeys: ["chosen_home"] });
    expect(onItemPick).toHaveBeenCalledWith({ routineId: "homes", stepId: "choose", outcome: "applied" });
  });

  it.each([
    ["the routine moved past the step", state(["brief"], {}), pick(), shown({ stepId: "brief" }), "other_step"],
    ["another routine's card", atChoose, pick({ routineId: "other" }), shown(), "other_routine"],
    ["another run's card, after the routine started over", atChoose, pick({ executionId: "run-0" }), shown(), "other_routine"],
    ["an older presentation, after the step looped back and showed cards again", atChoose, pick({ messageId: "msg-old" }), shown(), "not_latest"],
    ["another slot", atChoose, pick({ slot: "area" }), shown(), "other_step"],
    ["an item that does not fit", atChoose, pick({ item: { ...villa, link: "javascript:alert(1)" } }), shown(), "invalid"],
  ])("fills nothing for %s, and reads nothing else from the message", async (_label, at, selection, shownItems, reason) => {
    const selector = reading({ chosen_home: 2, area: "Kreuzberg" });
    const onItemPick = vi.fn();
    const result = await new DefaultRoutineRunner([homes()], selector, renderer(), search(), { onItemPick })
      .resume({ turn: turn("Villa Rosa", { itemSelection: selection, shownItems }), state: at });

    expect(result.nextState?.variables.chosen_home).toBeUndefined();
    expect(result.nextState?.variables.area).toBe(at.variables.area);
    expect(onItemPick).toHaveBeenCalledWith({ routineId: "homes", stepId: selection.stepId, outcome: "ignored", reason });
  });

  it("fills nothing when a consent the visitor withdrew holds the slot back", async () => {
    const routine = homes({
      slots: [
        { id: "s_area", key: "area", type: "text", required: true },
        { id: "s_home", key: "chosen_home", type: "item", required: true, sensitivity: "sensitive" },
      ],
      consents: [{ key: "home", slotKeys: ["chosen_home"], onDecline: "continue" }],
    });
    const consent: ConversationRoutineConsentPort = {
      standing: vi.fn(async () => ({ asks: true, decisions: { home: "declined" as const } })),
      read: vi.fn(async () => null),
      prompt: vi.fn(async () => null),
    };
    const onItemPick = vi.fn();
    const result = await new DefaultRoutineRunner([routine], reading({}), renderer(), search(), { consent, onItemPick })
      .resume({ turn: turn("Villa Rosa", { itemSelection: pick(), shownItems: shown() }), state: atChoose });

    expect(result.terminal?.collected?.chosen_home ?? result.nextState?.variables.chosen_home).toBeUndefined();
    expect(onItemPick).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ignored", reason: "consent" }));
  });
});

describe("an item slot read from a typed reply", () => {
  it.each([
    ["its position as shown", 2],
    ["its position as digits", "2"],
    ["its exact title, in any case and spacing", "villa  rosa"],
    ["its key", "/results/1"],
  ])("resolves %s to the stored item, exactly as a tap would", async (_label, value) => {
    const result = await new DefaultRoutineRunner([homes()], reading({ chosen_home: value }), renderer(), search())
      .resume({ turn: turn("the second one", { shownItems: shown() }), state: atChoose });

    expect(result.terminal?.collected?.chosen_home).toEqual(villa);
  });

  it.each([
    ["a position nothing showed", 3],
    ["a name nothing showed", "Casa Verde"],
    ["an object the selector wrote, with a link of its own", { key: "/results/1", title: "Villa Rosa", link: "https://evil.example/", fields: {} }],
  ])("fills nothing for %s, and the step asks again", async (_label, value) => {
    const result = await new DefaultRoutineRunner([homes()], reading({ chosen_home: value }), renderer(), search())
      .resume({ turn: turn("that one", { shownItems: shown() }), state: atChoose });

    expect(result.nextState?.variables.chosen_home).toBeUndefined();
    expect(result.nextState?.path.at(-1)).toBe("choose");
  });

  it("fills nothing when the step showed nothing this run", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({ chosen_home: 2 }), renderer(), search())
      .resume({ turn: turn("the second one", { shownItems: shown({ executionId: "run-0" }) }), state: atChoose });

    expect(result.nextState?.variables.chosen_home).toBeUndefined();
  });

  it("is dropped on any other step: only the presenting step's reply names an item", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({ area: "Mitte", chosen_home: 2 }), renderer(), search())
      .resume({ turn: turn("Mitte, and the second one", { shownItems: shown() }), state: state(["brief"]) });

    expect(result.nextState?.path.at(-1)).toBe("choose");
    expect(result.nextState?.variables).toEqual({ area: "Mitte" });
  });

  it("is dropped from the values a routine opens with", async () => {
    const result = await new DefaultRoutineRunner([homes()], reading({}), renderer(), search())
      .resume({ turn: turn("Villa Rosa in Mitte"), state: state([], { area: "Mitte", chosen_home: villa }), activationTurn: true });

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
  it("keeps a stored card as it is", () => {
    expect(checkSlotValue("item", villa)).toEqual({ ok: true, value: villa });
  });

  it.each([
    ["a name", "Casa Blu"],
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
