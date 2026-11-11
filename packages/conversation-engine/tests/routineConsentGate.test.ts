import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineConsentPort,
  Routine,
  RoutineConsentDecision,
  RoutineConsentReading,
  RoutineStep,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineConsentGate } from "../src/routineConsentGate.js";

const routine: Routine = {
  id: "intake",
  rootStepId: "ask",
  slots: [
    { id: "a", key: "pregnant", type: "boolean", required: true, sensitivity: "sensitive" },
    { id: "b", key: "religion", type: "text", required: false, sensitivity: "sensitive" },
    { id: "c", key: "union", type: "text", required: false, sensitivity: "sensitive" },
  ],
  consents: [
    { key: "health", slotKeys: ["pregnant"], onDecline: "continue" },
    { key: "beliefs", slotKeys: ["religion"], onDecline: "continue" },
    { key: "membership", slotKeys: ["union"], onDecline: "handoff" },
  ],
  steps: [],
  transitions: [],
};

const gateFor = (consentKey: string): RoutineStep => ({ id: `consent:${consentKey}:ask`, kind: "consent", consentKey });

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content: "hm" },
  history: [],
  stagedContext: [],
  steering: [],
};

const port = (options: {
  asks?: boolean;
  decisions?: Record<string, RoutineConsentDecision>;
  reading?: RoutineConsentReading;
} = {}): ConversationRoutineConsentPort => ({
  standing: vi.fn(async () => ({ asks: options.asks ?? true, decisions: options.decisions ?? {} })),
  read: vi.fn(async () => ({ decision: options.reading ?? "unclear", method: "reply" as const, wording: "w" })),
  prompt: vi.fn(async () => ({ reply: { render: async () => ({ answer: "wording" }) }, wording: "w" })),
});

describe("RoutineConsentGate", () => {
  it("keeps every covered slot closed until the conversation granted its consent, and runs without the declined ones", async () => {
    const gate = await RoutineConsentGate.open(routine, port({ decisions: { health: "granted", beliefs: "declined" } }), turn);

    expect([...gate.blocked].sort()).toEqual(["religion", "union"]);
    expect([...gate.waived]).toEqual(["religion"]);
  });

  it.each([
    ["a channel that asks no consent", port({ asks: false })],
    ["no consent port", undefined],
  ])("runs without every ungranted covered slot on %s", async (_label, consentPort) => {
    const gate = await RoutineConsentGate.open(routine, consentPort, turn);

    expect([...gate.blocked].sort()).toEqual(["pregnant", "religion", "union"]);
    expect([...gate.waived].sort()).toEqual(["pregnant", "religion", "union"]);
  });

  it("is inert for a routine with no consents, without reading the conversation", async () => {
    const consentPort = port();
    const gate = await RoutineConsentGate.open({ ...routine, consents: [] }, consentPort, turn);

    expect(gate.blocked.size).toBe(0);
    expect(consentPort.standing).not.toHaveBeenCalled();
  });

  it("asks once more after an unclear reply, then counts the next unclear reply as declined", async () => {
    const consentPort = port({ reading: "unclear" });
    const gate = await RoutineConsentGate.open(routine, consentPort, turn);

    const first = await gate.land(gateFor("health"), { reaskCount: 0 });
    expect(first.outcome).toMatchObject({ kind: "park", reaskCount: 1 });

    const next = await RoutineConsentGate.open(routine, consentPort, turn);
    const second = await next.land(gateFor("health"), { reaskCount: 1 });
    expect(second.outcome).toEqual({ kind: "pass" });
    expect(next.events).toEqual([expect.objectContaining({ kind: "decided", decision: "declined", defaulted: true })]);
    expect([...next.waived]).toContain("pregnant");
  });

  it("applies a decision made this turn when the routine reaches the same consent again, without asking or reading again", async () => {
    const consentPort = port({ reading: "declined" });
    const gate = await RoutineConsentGate.open(routine, consentPort, turn);

    const answered = await gate.land(gateFor("membership"), { reaskCount: 0 });
    const again = await gate.land(gateFor("membership"), null);

    expect(answered.outcome).toEqual({ kind: "handoff" });
    expect(again.outcome).toEqual({ kind: "handoff" });
    expect(consentPort.read).toHaveBeenCalledTimes(1);
    expect(consentPort.prompt).not.toHaveBeenCalled();
    expect(gate.events).toHaveLength(1);
  });

  it("does not let a grant made this turn open its slots until the next turn", async () => {
    const gate = await RoutineConsentGate.open(routine, port({ reading: "granted" }), turn);

    await gate.land(gateFor("health"), { reaskCount: 0 });

    expect(gate.blocked.has("pregnant")).toBe(true);
    expect(gate.waived.has("pregnant")).toBe(false);
  });

  it("fails loudly on a consent step naming a consent the routine does not carry", async () => {
    const gate = await RoutineConsentGate.open(routine, port(), turn);

    await expect(gate.land(gateFor("unknown"), null)).rejects.toThrow("routine_consent_not_found:intake:consent:unknown:ask");
  });
});
