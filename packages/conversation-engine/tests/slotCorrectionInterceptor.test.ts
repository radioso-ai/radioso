import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine, DefaultRoutineRunner } from "../src/index.js";
import type {
  AttemptRoutineInput,
  ConversationEvent,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  RoutineSlotCorrectionCandidate,
  RoutineState,
} from "@radioso/conversation-contract";

const completed: RoutineState = {
  sessionId: "session_1",
  routineId: "routine_intake",
  path: ["done"],
  variables: { email: "old@example.com" },
  status: "completed",
};

const mutableEmailSlot: RoutineSlotCorrectionCandidate["slots"] = [
  { id: "s_email", key: "email", type: "email", required: true, mutable: true },
];

const noCorrection: ConversationRoutineSlotCorrection["detect"] = async () => ({ kind: "none", reason: "not_a_correction" });

const correction = (candidate: RoutineSlotCorrectionCandidate): ConversationRoutineSlotCorrection["detect"] =>
  async () => ({ kind: "correction", ...candidate });

const buildInput = (overrides: {
  detect?: ConversationRoutineSlotCorrection["detect"];
  confirm?: ConversationRoutineSlotCorrection["confirm"];
  rejectInvalid?: ConversationRoutineSlotCorrection["rejectInvalid"];
  completedStates?: RoutineState[];
  save?: (state: RoutineState) => Promise<void>;
  routineActivator?: ConversationRoutineActivator;
  routineReentryGate?: ConversationRoutineReentryGate;
  routineRunner?: AttemptRoutineInput["routineRunner"];
}): { input: AttemptRoutineInput; events: ConversationEvent[]; save: ReturnType<typeof vi.fn>; rejectInvalid: ReturnType<typeof vi.fn> } => {
  const events: ConversationEvent[] = [];
  const save = vi.fn(overrides.save ?? (async () => {}));
  const rejectInvalid = vi.fn(overrides.rejectInvalid ?? (async () => "That doesn't look like a valid email — what should I use?"));
  const input: AttemptRoutineInput = {
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_1", kind: "message", content: "actually my email is new@example.com" },
    stores: {
      loadHistory: vi.fn(async () => []),
      appendEvent: vi.fn(async (event: ConversationEvent) => {
        events.push(event);
      }),
    },
    routineStore: {
      loadActive: vi.fn(async () => null),
      loadCompleted: vi.fn(async () => overrides.completedStates ?? [completed]),
      save,
      clear: vi.fn(async () => {}),
    },
    // Unused by the correction path unless a test says otherwise, but attemptRoutine requires it.
    routineRunner: overrides.routineRunner ?? { resume: vi.fn() },
    routineSlotCorrection: {
      detect: overrides.detect ?? vi.fn(noCorrection),
      confirm: overrides.confirm ?? vi.fn(async () => "Updated."),
      rejectInvalid,
    },
    ...(overrides.routineActivator ? { routineActivator: overrides.routineActivator } : {}),
    ...(overrides.routineReentryGate ? { routineReentryGate: overrides.routineReentryGate } : {}),
  };
  return { input, events, save, rejectInvalid };
};

describe("completed-instance slot-correction interceptor", () => {
  it("patches the stored variable and replies when a valid correction is detected", async () => {
    const { input, events, save } = buildInput({
      detect: vi.fn(correction({ slots: mutableEmailSlot, slotKey: "email", rawValue: "new@example.com" })),
      confirm: vi.fn(async () => "Done — I updated your email."),
    });

    const result = await new DefaultConversationEngine().attemptRoutine(input);

    expect(result).not.toBeNull();
    expect(result!.response.answer).toBe("Done — I updated your email.");
    expect(result!.decision.reason).toBe("routine_slot_correction");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      routineId: "routine_intake",
      status: "completed",
      variables: { email: "new@example.com" },
    });
    // Input + assistant response persisted; no routine started.
    expect(events).toHaveLength(2);
    // Trace carries the slot key only, never the value.
    const correctionStage = result!.trace.stages.find((s) => s.kind === "routine_slot_correction");
    expect(correctionStage?.outputs).toEqual({ routineId: "routine_intake", slotKey: "email" });
    expect(JSON.stringify(result!.trace)).not.toContain("new@example.com");
  });

  it("does not patch state when confirmation generation fails", async () => {
    const { input, save } = buildInput({
      detect: vi.fn(correction({ slots: mutableEmailSlot, slotKey: "email", rawValue: "new@example.com" })),
      confirm: vi.fn(async () => {
        throw new Error("confirmation_failed");
      }),
    });

    await expect(new DefaultConversationEngine().attemptRoutine(input)).rejects.toThrow("confirmation_failed");
    expect(save).not.toHaveBeenCalled();
  });

  it("falls through (no patch) when no correction is detected", async () => {
    const { input, save } = buildInput({ detect: vi.fn(noCorrection) });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("falls through (no patch, no re-ask) when the detected slot is immutable", async () => {
    // Immutable slot — detection misfired; the deterministic gate must reject it and leave
    // the turn to normal answering (only invalid_value re-asks).
    const { input, save, rejectInvalid } = buildInput({
      detect: vi.fn(correction({
        slots: [{ id: "s_email", key: "email", type: "email", required: true, mutable: false }],
        slotKey: "email",
        rawValue: "new@example.com",
      })),
    });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(rejectInvalid).not.toHaveBeenCalled();
  });

  it("never writes a slot the routine's own consent covers, whatever the detector reports (#1544)", async () => {
    // The detector offers the change without naming the routine's consents; the runner knows them.
    const routineRunner = new DefaultRoutineRunner(
      [{
        id: "routine_intake",
        rootStepId: "ask",
        slots: mutableEmailSlot,
        consents: [{ key: "contact", slotKeys: ["email"], onDecline: "continue" }],
        steps: [{ id: "ask", kind: "chat" }, { id: "done", kind: "terminal" }],
        transitions: [],
      }],
      { select: vi.fn() },
      { render: vi.fn() },
    );
    const { input, save, rejectInvalid } = buildInput({
      detect: vi.fn(correction({ slots: mutableEmailSlot, slotKey: "email", rawValue: "new@example.com" })),
      routineRunner,
    });

    const result = await new DefaultConversationEngine().attemptRoutine(input);

    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(rejectInvalid).not.toHaveBeenCalled();
  });

  it("re-asks (no patch) when the replacement value fails the slot's type", async () => {
    const { input, save, rejectInvalid } = buildInput({
      detect: vi.fn(correction({ slots: mutableEmailSlot, slotKey: "email", rawValue: "not-an-email" })),
      rejectInvalid: vi.fn(async () => "That doesn't look like a valid email — what should I use?"),
    });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).not.toBeNull();
    expect(result!.response.answer).toBe("That doesn't look like a valid email — what should I use?");
    expect(rejectInvalid).toHaveBeenCalledTimes(1);
    // Value rejected: nothing persisted, and the correction stage records the rejection.
    expect(save).not.toHaveBeenCalled();
    const correctionStage = result!.trace.stages.find((s) => s.kind === "routine_slot_correction");
    expect(correctionStage?.status).toBe("rejected");
    expect(correctionStage?.outputs).toEqual({ routineId: "routine_intake", slotKey: "email", reason: "invalid_value" });
  });

  it("does nothing when there is no completed routine instance", async () => {
    const detect = vi.fn(noCorrection);
    const { input, save } = buildInput({ detect, completedStates: [] });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(detect).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  // #1714: a booking routine ended holding nothing, and "I'd like to book from 8 to 10 January"
  // was taken as a change to an arrival the run never held — confirmed as updated, and the
  // request never reached activation.
  it("never claims a change to a value the completed run does not hold, and lets activation have the turn", async () => {
    const confirm = vi.fn(async () => "Perfect, I've updated your arrival.");
    const activate = vi.fn<ConversationRoutineActivator["activate"]>(async () => null);
    const { input, save, rejectInvalid } = buildInput({
      completedStates: [{ ...completed, variables: {} }],
      detect: vi.fn(correction({
        slots: [{ id: "s_arrival", key: "arrival", type: "date", required: true, mutable: true }],
        slotKey: "arrival",
        rawValue: "2027-01-08",
      })),
      confirm,
      routineActivator: { activate },
    });

    const result = await new DefaultConversationEngine().attemptRoutine(input);

    expect(result).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(rejectInvalid).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("hands a message the detector reads as a new request on to reentry and activation", async () => {
    const decide = vi.fn<ConversationRoutineReentryGate["decide"]>(async () => ({ kind: "suppress" }));
    const activate = vi.fn<ConversationRoutineActivator["activate"]>(async () => null);
    const { input, save } = buildInput({
      detect: vi.fn<ConversationRoutineSlotCorrection["detect"]>(async () => ({ kind: "none", reason: "new_request" })),
      routineReentryGate: { decide },
      routineActivator: { activate },
    });

    const result = await new DefaultConversationEngine().attemptRoutine(input);

    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ suppressedRoutineIds: ["routine_intake"] }));
  });
});
