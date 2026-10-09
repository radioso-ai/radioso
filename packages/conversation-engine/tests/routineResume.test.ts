import { describe, expect, it, vi } from "vitest";

import type {
  AttemptRoutineInput,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { claimRoutineResume } from "../src/routineResume.js";

/** A whole resume: claim the turn, render its reply, settle. */
const resumeRoutine = async (input: Parameters<typeof claimRoutineResume>[0]) => {
  const claim = await claimRoutineResume(input);
  return claim ? claim.settle(await claim.reply.render()) : null;
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "still nothing useful" },
  history: [],
  stagedContext: [],
  steering: [],
};

const stateOn = (stepId: string): RoutineState => ({
  sessionId: "session_1",
  routineId: "contact",
  path: [stepId],
  variables: {},
  status: "active",
});

const runnerReturning = (result: ConversationRoutineResumeResult): ConversationRoutineRunner => ({
  resume: vi.fn(async () => result),
});

const saveSpy = () => vi.fn(async (_state: RoutineState) => {});

const requestWith = (runner: ConversationRoutineRunner, save: (state: RoutineState) => Promise<void>): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: turn.inputEvent,
  inputEventAlreadyAppended: true,
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  routineStore: {
    loadActive: vi.fn(async () => null),
    loadCompleted: vi.fn(async () => []),
    save,
    clear: vi.fn(async () => {}),
  },
  routineRunner: runner,
});

describe("resumeRoutine completion persistence", () => {
  it("does not duplicate the current step when a stuck ending lands on it without moving (#1384)", async () => {
    const save = saveSpy();
    const runner = runnerReturning({
      response: { answer: "A person will continue from here." },
      nextState: null,
      terminal: { kind: "stuck", stepId: "ask_contact", collected: { full_name: "Giulia" } },
      trace: {
        routineId: "contact",
        startStepId: "ask_contact",
        landedStepId: "ask_contact",
        terminalKind: "stuck",
        capturedSlotKeys: [],
        filledSlotKeys: ["full_name"],
        steps: [],
      },
    });
    const state = stateOn("ask_contact");

    await resumeRoutine({
      request: requestWith(runner, save),
      baseTurn: turn,
      state,
      resuming: true,
      history: [],
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ path: ["ask_contact"], status: "completed" }));
  });

  it("still appends the terminal step a normal completion actually moved to", async () => {
    const save = saveSpy();
    const runner = runnerReturning({
      response: { answer: "Thanks, all set." },
      nextState: null,
      terminal: { kind: "complete", stepId: "done", collected: { full_name: "Giulia" } },
      trace: {
        routineId: "contact",
        startStepId: "ask_contact",
        landedStepId: "done",
        terminalKind: "complete",
        capturedSlotKeys: [],
        filledSlotKeys: ["full_name"],
        steps: [],
      },
    });
    const state = stateOn("ask_contact");

    await resumeRoutine({
      request: requestWith(runner, save),
      baseTurn: turn,
      state,
      resuming: true,
      history: [],
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ path: ["ask_contact", "done"] }));
  });

  it("appends the terminal step from the ending itself when the runner reports no trace", async () => {
    const save = saveSpy();
    const runner = runnerReturning({
      response: { answer: "Thanks, all set." },
      nextState: null,
      terminal: { kind: "complete", stepId: "done" },
    });

    await resumeRoutine({
      request: requestWith(runner, save),
      baseTurn: turn,
      state: stateOn("ask_contact"),
      resuming: true,
      history: [],
    });

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ path: ["ask_contact", "done"], status: "completed" }));
  });

  it("keeps every value the run ended with, the ending turn's included, on the completed record (#1452)", async () => {
    const save = saveSpy();
    const runner = runnerReturning({
      response: { answer: "Thanks, all set." },
      nextState: null,
      terminal: { kind: "complete", stepId: "done", collected: { full_name: "Giulia", email: "giulia@example.com" } },
      endedVariables: { full_name: "Giulia", email: "giulia@example.com", request_ref: "REQ-7" },
      trace: {
        routineId: "contact",
        startStepId: "ask_contact",
        landedStepId: "done",
        terminalKind: "complete",
        capturedSlotKeys: ["email"],
        filledSlotKeys: ["full_name", "email"],
        steps: [],
      },
    });
    const state = { ...stateOn("ask_contact"), variables: { full_name: "Giulia" } };

    await resumeRoutine({
      request: requestWith(runner, save),
      baseTurn: turn,
      state,
      resuming: true,
      history: [],
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      variables: { full_name: "Giulia", email: "giulia@example.com", request_ref: "REQ-7" },
    }));
  });
});
