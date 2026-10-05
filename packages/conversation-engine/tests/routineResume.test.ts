import { describe, expect, it, vi } from "vitest";

import type {
  AttemptRoutineInput,
  ConversationRoutineRunner,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { resumeRoutine } from "../src/routineResume.js";

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

const requestWith = (runner: ConversationRoutineRunner, save: ReturnType<typeof vi.fn>): AttemptRoutineInput => ({
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
    const save = vi.fn(async () => {});
    const runner: ConversationRoutineRunner = {
      resume: vi.fn(async () => ({
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
      })),
    };
    const state = stateOn("ask_contact");

    await resumeRoutine({
      request: requestWith(runner, save),
      baseTurn: turn,
      state,
      resuming: true,
      history: [],
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].path).toEqual(["ask_contact"]);
    expect(save.mock.calls[0][0].status).toBe("completed");
  });

  it("still appends the terminal step a normal completion actually moved to", async () => {
    const save = vi.fn(async () => {});
    const runner: ConversationRoutineRunner = {
      resume: vi.fn(async () => ({
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
      })),
    };
    const state = stateOn("ask_contact");

    await resumeRoutine({
      request: requestWith(runner, save),
      baseTurn: turn,
      state,
      resuming: true,
      history: [],
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].path).toEqual(["ask_contact", "done"]);
  });
});
