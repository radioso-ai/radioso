import { describe, expect, it } from "vitest";

import {
  decideTaskOnRead,
  decideTaskAfterTurn,
  marksHumanStretch,
  type OpenTaskFacts,
  type TurnTaskFacts,
} from "../../../src/modules/a2a/domain/taskState.js";

const aiTurn = (overrides: Partial<TurnTaskFacts> = {}): TurnTaskFacts => ({
  ownership: "ai_owned",
  routine: null,
  activeRoutineExecutionId: null,
  invocationOutcome: null,
  unseenHumanMessages: false,
  ...overrides,
});

const routineTask = (executionId = "exec-1"): OpenTaskFacts => ({ routineExecutionId: executionId, humanStretch: false });
const humanStretchTask = (): OpenTaskFacts => ({ routineExecutionId: null, humanStretch: true });

describe("decideTaskAfterTurn (the precedence table, rows 1-10)", () => {
  it("row 1: human-owned with a person's message the caller has not seen is INPUT_REQUIRED on that message", () => {
    // Opened for it when no task is open: the caller sent without seeing what a person wrote.
    expect(decideTaskAfterTurn(null, aiTurn({ ownership: "human_owned", unseenHumanMessages: true })))
      .toMatchObject({ target: "new", state: "input_required", reason: "human_message", status: "later_message" });
    expect(decideTaskAfterTurn(routineTask(), aiTurn({ ownership: "human_owned", unseenHumanMessages: true }))).toEqual({
      kind: "task",
      target: "open",
      replacesOpenTask: false,
      state: "input_required",
      reason: "human_message",
      status: "later_message",
      artifact: false,
      routineExecutionId: "exec-1",
    });
  });

  it("row 2: human-owned is WORKING on the turn's reply, routine in flight or not, and opens a task when none is open", () => {
    const handedOff = aiTurn({
      ownership: "human_owned",
      routine: { status: "waiting_for_input", executionId: "exec-2" },
    });
    expect(decideTaskAfterTurn(null, handedOff)).toMatchObject({
      kind: "task",
      target: "new",
      state: "working",
      reason: "human_owned",
      status: "reply",
      routineExecutionId: "exec-2",
    });
    // An authored routine end that hands off: the routine is done, the person owns the thread.
    expect(decideTaskAfterTurn(routineTask(), aiTurn({ ownership: "human_owned", routine: { status: "completed", executionId: "exec-1" } })))
      .toMatchObject({ target: "open", state: "working", reason: "human_owned", artifact: false });
  });

  it("row 3 does not apply on a turn: the turn's own reply is what the caller is shown", () => {
    expect(decideTaskAfterTurn(null, aiTurn())).toEqual({ kind: "message" });
  });

  it("row 4: a routine waiting on an operator's approval is WORKING on the agent's reply", () => {
    expect(decideTaskAfterTurn(routineTask(), aiTurn({ routine: { status: "waiting_for_approval", executionId: "exec-1" } })))
      .toMatchObject({ target: "open", state: "working", reason: "awaiting_approval", status: "reply" });
  });

  it("row 5: the same routine waiting for input, or active, is INPUT_REQUIRED on the agent's reply", () => {
    for (const status of ["waiting_for_input", "active"] as const) {
      expect(decideTaskAfterTurn(routineTask(), aiTurn({ routine: { status, executionId: "exec-1" } })))
        .toMatchObject({ target: "open", replacesOpenTask: false, state: "input_required", reason: "awaiting_input", status: "reply" });
    }
  });

  it("row 6: a different routine in flight replaces the open task and opens a new one that takes rows 4-5", () => {
    expect(decideTaskAfterTurn(routineTask("exec-1"), aiTurn({ routine: { status: "waiting_for_input", executionId: "exec-2" } })))
      .toEqual({
        kind: "task",
        target: "new",
        replacesOpenTask: true,
        state: "input_required",
        reason: "awaiting_input",
        status: "reply",
        artifact: false,
        routineExecutionId: "exec-2",
      });
    expect(decideTaskAfterTurn(routineTask("exec-1"), aiTurn({ routine: { status: "waiting_for_approval", executionId: "exec-2" } })))
      .toMatchObject({ target: "new", replacesOpenTask: true, state: "working", reason: "awaiting_approval" });
  });

  it("row 6 never replaces a task that follows no routine: a stretch of human ownership takes the routine on", () => {
    expect(decideTaskAfterTurn(humanStretchTask(), aiTurn({ routine: { status: "waiting_for_input", executionId: "exec-2" } })))
      .toMatchObject({ target: "open", replacesOpenTask: false, state: "input_required", routineExecutionId: "exec-2" });
  });

  it("row 8: a routine completed this turn is COMPLETED with no status message; the reply is the artifact", () => {
    expect(decideTaskAfterTurn(routineTask(), aiTurn({ routine: { status: "completed", executionId: "exec-1" } }))).toEqual({
      kind: "task",
      target: "open",
      replacesOpenTask: false,
      state: "completed",
      reason: "routine_completed",
      status: "none",
      artifact: true,
      routineExecutionId: "exec-1",
    });
    // Started and finished in one turn: a task opens already complete.
    expect(decideTaskAfterTurn(null, aiTurn({ routine: { status: "completed", executionId: "exec-3" } })))
      .toMatchObject({ target: "new", state: "completed", artifact: true });
  });

  it("row 7: a declined invocation is REJECTED on the agent's reply, checked before row 8 reads its completed routine", () => {
    // A declined call reports the routine it named as completed, with no execution id.
    expect(decideTaskAfterTurn(null, aiTurn({ invocationOutcome: "declined", routine: { status: "completed", executionId: null } })))
      .toMatchObject({ kind: "task", target: "new", state: "rejected", reason: "routine_declined", status: "reply", artifact: false });
  });

  it("row 9: AI-owned with no routine in flight after a stretch of human ownership is COMPLETED on the reply", () => {
    expect(decideTaskAfterTurn(humanStretchTask(), aiTurn())).toMatchObject({
      target: "open",
      state: "completed",
      reason: "handed_back",
      status: "reply",
      artifact: false,
    });
  });

  it("row 9 also closes the task a turn opens for human messages the caller had not seen", () => {
    expect(decideTaskAfterTurn(null, aiTurn({ unseenHumanMessages: true }))).toMatchObject({
      kind: "task",
      target: "new",
      state: "completed",
      reason: "handed_back",
      status: "reply",
    });
  });

  it("row 10: AI-owned with no routine run active after the turn is CANCELED with reason routine_ended", () => {
    expect(decideTaskAfterTurn(routineTask(), aiTurn())).toMatchObject({ target: "open", state: "canceled", reason: "routine_ended", status: "reply" });
    expect(decideTaskAfterTurn(routineTask(), aiTurn({ routine: { status: "abandoned", executionId: "exec-1" } })))
      .toMatchObject({ state: "canceled", reason: "routine_ended" });
  });

  it("keeps a routine task open at INPUT_REQUIRED on the reply when its run yielded the turn and is still active", () => {
    // An off-topic message: the engine parks the routine without saving it, so the turn reports none.
    expect(decideTaskAfterTurn(routineTask("exec-1"), aiTurn({ activeRoutineExecutionId: "exec-1" }))).toEqual({
      kind: "task",
      target: "open",
      replacesOpenTask: false,
      state: "input_required",
      reason: "awaiting_input",
      status: "reply",
      artifact: false,
      routineExecutionId: "exec-1",
    });
  });

  it("opens a task for a routine run still active after a turn that reported none, rather than answering a plain Message", () => {
    expect(decideTaskAfterTurn(null, aiTurn({ activeRoutineExecutionId: "exec-4" })))
      .toMatchObject({ kind: "task", target: "new", state: "input_required", reason: "awaiting_input", routineExecutionId: "exec-4" });
  });

  it("row 9 and row 10 apply only when no routine run is active after the turn", () => {
    expect(decideTaskAfterTurn(humanStretchTask(), aiTurn({ activeRoutineExecutionId: "exec-5" })))
      .toMatchObject({ target: "open", state: "input_required", reason: "awaiting_input", routineExecutionId: "exec-5" });
    expect(decideTaskAfterTurn(routineTask("exec-1"), aiTurn({ activeRoutineExecutionId: "exec-6" })))
      .toMatchObject({ target: "new", replacesOpenTask: true, state: "input_required", routineExecutionId: "exec-6" });
  });

  it("answers a plain Message when no task is open, the AI owns the thread, and nothing is pending", () => {
    expect(decideTaskAfterTurn(null, aiTurn())).toEqual({ kind: "message" });
    expect(decideTaskAfterTurn(null, aiTurn({ routine: { status: "abandoned", executionId: "exec-1" } }))).toEqual({ kind: "message" });
  });

  it("lets the routine actually in flight decide when the invocation did not start or re-entered", () => {
    for (const invocationOutcome of ["not_started", "reentered"]) {
      expect(decideTaskAfterTurn(routineTask(), aiTurn({ invocationOutcome, routine: { status: "waiting_for_input", executionId: "exec-1" } })))
        .toMatchObject({ state: "input_required", reason: "awaiting_input" });
    }
  });
});

describe("decideTaskOnRead (rows 1 and 3, observed without a turn)", () => {
  it("row 1: a person's reply on a human-owned task is INPUT_REQUIRED on that reply", () => {
    expect(decideTaskOnRead({ ownership: "human_owned", laterMessage: { author: "human" } }))
      .toEqual({ state: "input_required", reason: "human_message", status: "later_message" });
  });

  it("row 3: an agent message on an AI-owned task (an approval's outcome) is INPUT_REQUIRED on that message", () => {
    expect(decideTaskOnRead({ ownership: "ai_owned", laterMessage: { author: "agent" } }))
      .toEqual({ state: "input_required", reason: "agent_message", status: "later_message" });
  });

  it("keeps the task as it is when nothing new arrived, so the state is sticky until the caller's next turn", () => {
    expect(decideTaskOnRead({ ownership: "human_owned", laterMessage: null })).toBeNull();
    expect(decideTaskOnRead({ ownership: "ai_owned", laterMessage: null })).toBeNull();
  });
});

describe("marksHumanStretch", () => {
  it("marks a task a stretch of human ownership once a person's ownership or message sets its state", () => {
    expect(marksHumanStretch("human_owned")).toBe(true);
    expect(marksHumanStretch("human_message")).toBe(true);
    expect(marksHumanStretch("agent_message")).toBe(false);
    expect(marksHumanStretch("awaiting_input")).toBe(false);
    expect(marksHumanStretch("handed_back")).toBe(false);
  });
});
