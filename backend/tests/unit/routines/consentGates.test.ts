import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import type {
  ConversationRoutineConsentPort,
  ConversationRoutineNextStepSelector,
  ConversationRoutineStepRenderer,
  RoutineStep,
  TurnContext,
} from "@radioso/conversation-contract";

import { compileRoutineDefinition, type RoutineDefinition } from "../../../src/modules/routines/public.js";

type Consent = NonNullable<RoutineDefinition["consents"]>[number];

const consent = (key: string, slotKeys: string[], onDecline: Consent["onDecline"] = "continue"): Consent => ({
  key,
  slotKeys,
  variants: [{ locale: "en", body: `We ask about ${key} to book the right session.`, agreeLabel: "I agree", declineLabel: "No thanks" }],
  onDecline,
});

// Name, then two health questions, then a booking: `ask_health` collects both sensitive slots and
// `confirm` only reads one of them back.
const intake = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: "def_intake",
  agentId: "agent_1",
  lineageId: "def_intake",
  name: "intake",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor wants to book a session.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "slot_pregnant", key: "pregnant", type: "boolean", required: true, description: null, ordinal: 1, sensitivity: "sensitive" },
    { stableSlotId: "slot_injury", key: "injury", type: "text", required: false, description: null, ordinal: 2, sensitivity: "sensitive" },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_health", kind: "chat", instruction: "Ask whether {{slot.pregnant}} and about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} },
    { stableStepId: "confirm", kind: "chat", instruction: "Confirm the booking for {{slot.name}}, noting {{slot.pregnant}}.", toolRef: null, ordinal: 2, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_health", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "ask_health", toRef: "confirm", guardKind: "default", guardText: null, ordinal: 1 },
    { fromStep: "confirm", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thank the visitor.", ordinal: 0 }],
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...overrides,
});

const stepIds = (steps: readonly RoutineStep[]): string[] => steps.map((step) => step.id);

describe("consent gates in the compiled routine (#1544)", () => {
  it("compiles a routine without consents exactly as before", () => {
    const routine = compileRoutineDefinition(intake());

    expect(routine).not.toHaveProperty("consents");
    expect(routine.steps.some((step) => step.kind === "consent")).toBe(false);
    expect(compileRoutineDefinition(intake({ consents: [] }))).toEqual(routine);
  });

  it("asks a consent immediately before the step that collects its slot, and carries the consent", () => {
    const routine = compileRoutineDefinition(intake({ consents: [consent("health", ["pregnant"], "handoff")] }));

    expect(routine.consents).toEqual([{ key: "health", slotKeys: ["pregnant"], onDecline: "handoff" }]);
    expect(stepIds(routine.steps)).toEqual(["ask_name", "consent:health:ask_health", "ask_health", "confirm", "done"]);
    expect(routine.steps.find((step) => step.kind === "consent")).toEqual({ id: "consent:health:ask_health", kind: "consent", consentKey: "health" });
    expect(routine.rootStepId).toBe("ask_name");
    // Every way into the collecting step now leads through the gate, and only the gate leads in.
    expect(routine.transitions.filter((transition) => transition.to === "ask_health")).toEqual([
      { from: "consent:health:ask_health", to: "ask_health", condition: "default", guard: { kind: "default" } },
    ]);
    expect(routine.transitions.find((transition) => transition.from === "ask_name")).toMatchObject({
      to: "consent:health:ask_health",
      origin: "compiler_slot_gate",
    });
  });

  it("asks nothing before a step that only reads a covered slot back", () => {
    const routine = compileRoutineDefinition(intake({ consents: [consent("health", ["pregnant"])] }));

    expect(routine.steps.filter((step) => step.kind === "consent")).toHaveLength(1);
    expect(routine.transitions.find((transition) => transition.to === "confirm")).toMatchObject({ from: "ask_health" });
  });

  it("makes the gate the root when the first step collects a covered slot", () => {
    const routine = compileRoutineDefinition(intake({
      slots: [{ stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0, sensitivity: "sensitive" }],
      steps: [{ stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "ask_name", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
      consents: [consent("identity", ["name"])],
    }));

    expect(routine.rootStepId).toBe("consent:identity:ask_name");
    expect(routine.transitions).toContainEqual({ from: "consent:identity:ask_name", to: "ask_name", condition: "default", guard: { kind: "default" } });
  });

  it("chains two consents on one step in the order they are written", () => {
    const routine = compileRoutineDefinition(intake({
      consents: [consent("injury_details", ["injury"]), consent("health", ["pregnant"])],
    }));

    expect(stepIds(routine.steps)).toEqual([
      "ask_name",
      "consent:injury_details:ask_health",
      "consent:health:ask_health",
      "ask_health",
      "confirm",
      "done",
    ]);
    expect(routine.transitions.find((transition) => transition.from === "ask_name")?.to).toBe("consent:injury_details:ask_health");
    expect(routine.transitions).toContainEqual({ from: "consent:injury_details:ask_health", to: "consent:health:ask_health", condition: "default", guard: { kind: "default" } });
    expect(routine.transitions).toContainEqual({ from: "consent:health:ask_health", to: "ask_health", condition: "default", guard: { kind: "default" } });
  });

  it("gates every step that collects one of a consent's slots", () => {
    const routine = compileRoutineDefinition(intake({
      steps: [
        { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
        { stableStepId: "ask_health", kind: "chat", instruction: "Ask whether {{slot.pregnant}}.", toolRef: null, ordinal: 1, metadata: {} },
        { stableStepId: "confirm", kind: "chat", instruction: "Ask about {{slot.injury}} and confirm for {{slot.name}}.", toolRef: null, ordinal: 2, metadata: {} },
      ],
      consents: [consent("health", ["pregnant", "injury"])],
    }));

    expect(stepIds(routine.steps.filter((step) => step.kind === "consent"))).toEqual(["consent:health:ask_health", "consent:health:confirm"]);
    expect(routine.transitions.find((transition) => transition.from === "ask_health")?.to).toBe("consent:health:confirm");
  });

  it("refuses two consents with one key, which would make two gates one step", () => {
    expect(() => compileRoutineDefinition(intake({
      consents: [consent("health", ["pregnant"]), consent("health", ["injury"])],
    }))).toThrow("routine_consent_key_duplicate");
  });

  it("parks the engine on the gate with the consent wording, not on the collecting step", async () => {
    const routine = compileRoutineDefinition(intake({ consents: [consent("health", ["pregnant"])] }));
    const port = {
      standing: vi.fn(async () => ({ asks: true, decisions: {} })),
      read: vi.fn(async () => null),
      prompt: vi.fn(async () => ({ reply: { render: async () => ({ answer: "[consent wording]" }) }, wording: { version: "v1" } })),
    } satisfies ConversationRoutineConsentPort;
    const selector: ConversationRoutineNextStepSelector = {
      select: vi.fn(async ({ currentStep }) => ({ nextStepId: currentStep.id, variables: { name: "Ada" } })),
    };
    const renderer: ConversationRoutineStepRenderer = { render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]` })) };
    const turn: TurnContext = {
      agent: { id: "agent_1", name: "Assistant" },
      sessionId: "session_1",
      inputEvent: { id: "in_1", kind: "message", content: "I'm Ada" },
      history: [],
      stagedContext: [],
      steering: [],
    };

    const result = await new DefaultRoutineRunner([routine], selector, renderer, undefined, { consent: port })
      .resume({ turn, state: { sessionId: "session_1", routineId: routine.id, path: ["ask_name"], variables: {}, status: "active" } });

    expect(result.response.answer).toBe("[consent wording]");
    expect(result.nextState).toMatchObject({ path: ["ask_name", "consent:health:ask_health"], variables: { name: "Ada" } });
  });
});
