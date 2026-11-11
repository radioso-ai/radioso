import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Routine, RoutineState, TurnContext } from "@radioso/conversation-contract";
import { REDACTED_VALUE } from "@radioso/conversation-contract";
import { RoutineSlotCorrector } from "../src/index.js";

// A run that only talked: it ends on a complete ending that notifies no one.
const routine: Routine = {
  id: "routine_intake",
  rootStepId: "ask",
  steps: [
    { id: "ask", kind: "chat", action: "Ask for the details" },
    { id: "done", kind: "terminal", metadata: { terminalKind: "complete" } },
    { id: "notified", kind: "terminal", metadata: { terminalKind: "complete", operatorNotice: {} } },
  ],
  transitions: [],
  slots: [
    { id: "s_email", key: "email", type: "email", required: true, mutable: true },
    { id: "s_name", key: "name", type: "text", required: true },
    { id: "s_arrival", key: "arrival", type: "date", required: false, mutable: true, description: "The day the visitor arrives." },
  ],
};

const completedState: RoutineState = {
  sessionId: "session_1",
  routineId: "routine_intake",
  path: ["ask", "done"],
  variables: { email: "old@example.com", name: "Sam" },
  status: "completed",
};

const turn = (content: string, timeZone?: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "i1", kind: "message", content },
  history: [],
  stagedContext: [],
  steering: [],
  ...(timeZone ? { referenceTimeZone: { timeZone, source: "visitor" as const } } : {}),
});

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

const decision = (intent: string, slotKey: string | null = null, value: string | null = null): string =>
  JSON.stringify({ intent, slotKey, value });

// 2026-11-09 23:30 UTC is already 10 November in Rome.
const clock = (): Date => new Date("2026-11-09T23:30:00.000Z");

const systemPrompt = (gw: ConversationModelGateway): string => vi.mocked(gw.complete).mock.calls[0][0].systemPrompt ?? "";

describe("RoutineSlotCorrector", () => {
  it("detects a correction to an editable value the completed run holds", async () => {
    const gw = gateway(decision("correction", "email", "new@example.com"));
    const corrector = new RoutineSlotCorrector([routine], gw, { clock });

    const result = await corrector.detect({ turn: turn("actually use new@example.com"), completedState });

    expect(result).toEqual({ kind: "correction", slots: routine.slots, slotKey: "email", rawValue: "new@example.com" });
  });

  it("shows the model only the editable values the run holds, with what each holds and today's date", async () => {
    const gw = gateway(decision("other"));
    const corrector = new RoutineSlotCorrector([routine], gw, { clock });

    await corrector.detect({ turn: turn("thanks!", "Europe/Rome"), completedState });

    const prompt = systemPrompt(gw);
    expect(prompt).toContain("key: email");
    expect(prompt).toContain("old@example.com");
    // Not editable, and editable but never held: neither is offered.
    expect(prompt).not.toContain("key: name");
    expect(prompt).not.toContain("key: arrival");
    expect(prompt).toContain("2026-11-10");
    expect(prompt).toContain("Europe/Rome");
  });

  it("shows a sensitive held value masked", async () => {
    const gw = gateway(decision("other"));
    const sensitive: Routine = {
      ...routine,
      slots: [{ id: "s_email", key: "email", type: "email", required: true, mutable: true, sensitivity: "sensitive" }],
    };
    const corrector = new RoutineSlotCorrector([sensitive], gw, { clock });

    await corrector.detect({ turn: turn("thanks!"), completedState });

    expect(systemPrompt(gw)).toContain(REDACTED_VALUE);
    expect(systemPrompt(gw)).not.toContain("old@example.com");
  });

  // #1714: the run ended on its opening turn holding nothing, and "I'd like to book from 8 to
  // 10 January" was read as a change to the arrival.
  it("offers no correction, without a model call, when the run holds none of its editable values", async () => {
    const gw = gateway(decision("correction", "arrival", "2027-01-08"));
    const corrector = new RoutineSlotCorrector([routine], gw, { clock });

    const result = await corrector.detect({
      turn: turn("I'd like to book from 8 to 10 January"),
      completedState: { ...completedState, variables: {} },
    });

    expect(result).toEqual({ kind: "none", reason: "not_held" });
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("offers no correction, without a model call, when the run's ending already notified operators", async () => {
    const gw = gateway(decision("correction", "email", "new@example.com"));
    const corrector = new RoutineSlotCorrector([routine], gw, { clock });

    const result = await corrector.detect({
      turn: turn("actually use new@example.com"),
      completedState: { ...completedState, path: ["ask", "notified"] },
    });

    expect(result).toEqual({ kind: "none", reason: "already_sent" });
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("reports a new request when the model reads the message as asking for something new", async () => {
    const gw = gateway(decision("new_request"));
    const corrector = new RoutineSlotCorrector([routine], gw, { clock });

    const result = await corrector.detect({ turn: turn("I'd also like to book a second stay"), completedState });

    expect(result).toEqual({ kind: "none", reason: "new_request" });
  });

  it("offers no correction when the model names an editable value the run never held", async () => {
    const gw = gateway(decision("correction", "arrival", "2027-01-08"));
    const corrector = new RoutineSlotCorrector([routine], gw, { clock });

    const result = await corrector.detect({ turn: turn("arrive on the 8th"), completedState });

    expect(result).toEqual({ kind: "none", reason: "not_a_correction" });
  });

  it("short-circuits without a model call when the routine has no editable slots", async () => {
    const gw = gateway("{}");
    const immutable: Routine = { ...routine, slots: [{ id: "s_name", key: "name", type: "text", required: true }] };
    const corrector = new RoutineSlotCorrector([immutable], gw);

    const result = await corrector.detect({ turn: turn("change my name to Alex"), completedState });

    expect(result).toEqual({ kind: "none", reason: "no_mutable_slot" });
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("never offers a correction to a slot a consent covers, even one marked editable (#1544)", async () => {
    const gw = gateway(decision("correction", "email", "new@example.com"));
    const covered: Routine = { ...routine, consents: [{ key: "contact", slotKeys: ["email"], onDecline: "continue" }] };
    const corrector = new RoutineSlotCorrector([covered], gw, { clock });

    const result = await corrector.detect({ turn: turn("actually use new@example.com"), completedState });

    expect(result).toEqual({ kind: "none", reason: "not_held" });
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("offers no correction when the model picks a slot that is not editable", async () => {
    const gw = gateway(decision("correction", "name", "Alex"));
    const corrector = new RoutineSlotCorrector([routine], gw);
    expect(await corrector.detect({ turn: turn("change my name"), completedState }))
      .toEqual({ kind: "none", reason: "not_a_correction" });
  });

  it("offers no correction when the model reports none, or answers with anything unreadable", async () => {
    for (const text of [decision("other"), "not json", JSON.stringify({ slotKey: "email", value: "new@example.com" })]) {
      const corrector = new RoutineSlotCorrector([routine], gateway(text));
      expect(await corrector.detect({ turn: turn("what's the weather?"), completedState }))
        .toEqual({ kind: "none", reason: "not_a_correction" });
    }
  });

  it("offers no correction for an unknown routine id", async () => {
    const gw = gateway("{}");
    const corrector = new RoutineSlotCorrector([routine], gw);
    const result = await corrector.detect({ turn: turn("x"), completedState: { ...completedState, routineId: "missing" } });
    expect(result).toEqual({ kind: "none", reason: "unknown_routine" });
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
    const prompt = vi.mocked(gw.complete).mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("email");
  });
});
