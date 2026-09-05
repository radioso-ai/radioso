import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import type {
  AttemptRoutineInput,
  ConversationEvent,
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

const buildInput = (overrides: {
  detect?: ConversationRoutineSlotCorrection["detect"];
  confirm?: ConversationRoutineSlotCorrection["confirm"];
  rejectInvalid?: ConversationRoutineSlotCorrection["rejectInvalid"];
  completedStates?: RoutineState[];
  save?: (state: RoutineState) => Promise<void>;
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
    // Unused by the correction path, but attemptRoutine requires it to be wired.
    routineRunner: { resume: vi.fn() },
    routineSlotCorrection: {
      detect: overrides.detect ?? vi.fn(async () => null),
      confirm: overrides.confirm ?? vi.fn(async () => "Updated."),
      rejectInvalid,
    },
  };
  return { input, events, save, rejectInvalid };
};

describe("completed-instance slot-correction interceptor", () => {
  it("patches the stored variable and replies when a valid correction is detected", async () => {
    const { input, events, save } = buildInput({
      detect: vi.fn(async () => ({ slots: mutableEmailSlot, slotKey: "email", rawValue: "new@example.com" })),
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
      detect: vi.fn(async () => ({ slots: mutableEmailSlot, slotKey: "email", rawValue: "new@example.com" })),
      confirm: vi.fn(async () => {
        throw new Error("confirmation_failed");
      }),
    });

    await expect(new DefaultConversationEngine().attemptRoutine(input)).rejects.toThrow("confirmation_failed");
    expect(save).not.toHaveBeenCalled();
  });

  it("falls through (no patch) when no correction is detected", async () => {
    const { input, save } = buildInput({ detect: vi.fn(async () => null) });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("falls through (no patch, no re-ask) when the detected slot is immutable", async () => {
    // Immutable slot — detection misfired; the deterministic gate must reject it and leave
    // the turn to normal answering (only invalid_value re-asks).
    const { input, save, rejectInvalid } = buildInput({
      detect: vi.fn(async () => ({
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

  it("re-asks (no patch) when the replacement value fails the slot's type", async () => {
    const { input, save, rejectInvalid } = buildInput({
      detect: vi.fn(async () => ({ slots: mutableEmailSlot, slotKey: "email", rawValue: "not-an-email" })),
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
    const detect = vi.fn(async () => null);
    const { input, save } = buildInput({ detect, completedStates: [] });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(detect).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
