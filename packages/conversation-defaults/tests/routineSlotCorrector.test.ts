import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Routine, RoutineState, TurnContext } from "@radioso/conversation-contract";
import { RoutineSlotCorrector } from "../src/index.js";

const routine: Routine = {
  id: "routine_intake",
  rootStepId: "ask",
  steps: [],
  transitions: [],
  slots: [
    { id: "s_email", key: "email", type: "email", required: true, mutable: true },
    { id: "s_name", key: "name", type: "text", required: true },
  ],
};

const completedState: RoutineState = {
  sessionId: "session_1",
  routineId: "routine_intake",
  path: ["done"],
  variables: { email: "old@example.com", name: "Sam" },
  status: "completed",
};

const turn = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "i1", kind: "message", content },
  history: [],
  stagedContext: [],
  steering: [],
});

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

describe("RoutineSlotCorrector", () => {
  it("detects a correction over a declared mutable slot", async () => {
    const gw = gateway(JSON.stringify({ slotKey: "email", value: "new@example.com" }));
    const corrector = new RoutineSlotCorrector([routine], gw);

    const result = await corrector.detect({ turn: turn("actually use new@example.com"), completedState });

    expect(result).toEqual({ slots: routine.slots, slotKey: "email", rawValue: "new@example.com" });
    // The model only saw the mutable slot.
    const prompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(prompt).toContain("email");
    expect(prompt).not.toContain("key: name");
  });

  it("short-circuits without a model call when the routine has no mutable slots", async () => {
    const gw = gateway("{}");
    const immutable: Routine = { ...routine, slots: [{ id: "s_name", key: "name", type: "text", required: true }] };
    const corrector = new RoutineSlotCorrector([immutable], gw);

    const result = await corrector.detect({ turn: turn("change my name to Alex"), completedState });

    expect(result).toBeNull();
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("returns null when the model picks a slot that is not a declared mutable key", async () => {
    const gw = gateway(JSON.stringify({ slotKey: "name", value: "Alex" }));
    const corrector = new RoutineSlotCorrector([routine], gw);
    expect(await corrector.detect({ turn: turn("change my name"), completedState })).toBeNull();
  });

  it("returns null when the model reports no correction", async () => {
    const gw = gateway(JSON.stringify({ slotKey: null, value: null }));
    const corrector = new RoutineSlotCorrector([routine], gw);
    expect(await corrector.detect({ turn: turn("what's the weather?"), completedState })).toBeNull();
  });

  it("returns null for an unknown routine id", async () => {
    const gw = gateway("{}");
    const corrector = new RoutineSlotCorrector([routine], gw);
    const result = await corrector.detect({ turn: turn("x"), completedState: { ...completedState, routineId: "missing" } });
    expect(result).toBeNull();
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("produces a confirmation string from the model", async () => {
    const gw = gateway("All set — your email is updated.");
    const corrector = new RoutineSlotCorrector([routine], gw);
    const answer = await corrector.confirm({ turn: turn("thanks"), routineId: "routine_intake", slotKey: "email", value: "new@example.com" });
    expect(answer).toBe("All set — your email is updated.");
  });

  it("produces an invalid-value re-ask carrying the slot type", async () => {
    const gw = gateway("That doesn't look like a valid email — what should I use?");
    const corrector = new RoutineSlotCorrector([routine], gw);
    const answer = await corrector.rejectInvalid({ turn: turn("change it"), routineId: "routine_intake", slotKey: "email" });
    expect(answer).toBe("That doesn't look like a valid email — what should I use?");
    const prompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(prompt).toContain("email");
  });
});
