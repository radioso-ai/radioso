import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import type {
  AttemptRoutineInput,
  ConversationEvent,
  RoutineReentryDecision,
  RoutineState,
} from "@radioso/conversation-contract";

const completed: RoutineState = {
  sessionId: "session_1",
  routineId: "routine_qualify",
  path: ["done"],
  variables: { budget: "10k", name: "Sam" },
  status: "completed",
};

const buildInput = (overrides: {
  decide?: (input: { completedState: RoutineState }) => Promise<RoutineReentryDecision>;
  completedStates?: RoutineState[];
  gate?: boolean;
}): { input: AttemptRoutineInput; resume: ReturnType<typeof vi.fn> } => {
  const events: ConversationEvent[] = [];
  const resume = vi.fn(async () => ({ response: { answer: "ok" }, nextState: null }));
  const input: AttemptRoutineInput = {
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_1", kind: "message", content: "let's go again" },
    stores: {
      loadHistory: vi.fn(async () => []),
      appendEvent: vi.fn(async (event: ConversationEvent) => {
        events.push(event);
      }),
    },
    routineStore: {
      loadActive: vi.fn(async () => null),
      loadCompleted: vi.fn(async () => overrides.completedStates ?? [completed]),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
    routineRunner: { resume },
    // No activator: when the gate suppresses, the turn falls through and returns null.
    ...(overrides.gate === false
      ? {}
      : { routineReentryGate: { decide: overrides.decide ?? (async () => ({ kind: "suppress" })) } }),
  };
  return { input, resume };
};

describe("completed-instance reentry gate interceptor", () => {
  it("resumes the existing instance with captured variables preserved", async () => {
    const { input, resume } = buildInput({ decide: async () => ({ kind: "resume_existing" }) });

    const result = await new DefaultConversationEngine().attemptRoutine(input);

    expect(result).not.toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0]).toMatchObject({
      state: { routineId: "routine_qualify", path: [], variables: { budget: "10k", name: "Sam" }, status: "active" },
    });
  });

  it("starts a fresh instance with captured variables cleared", async () => {
    const { input, resume } = buildInput({ decide: async () => ({ kind: "start_new" }) });

    const result = await new DefaultConversationEngine().attemptRoutine(input);

    expect(result).not.toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0]).toMatchObject({
      state: { routineId: "routine_qualify", path: [], variables: {}, status: "active" },
    });
  });

  it("falls through (no resume) when the gate suppresses", async () => {
    const { input, resume } = buildInput({ decide: async () => ({ kind: "suppress" }) });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not consult the gate when no routine has completed", async () => {
    const decide = vi.fn(async () => ({ kind: "start_new" as const }));
    const { input, resume } = buildInput({ decide, completedStates: [] });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("falls through when no reentry gate is wired", async () => {
    const { input, resume } = buildInput({ gate: false });
    const result = await new DefaultConversationEngine().attemptRoutine(input);
    expect(result).toBeNull();
    expect(resume).not.toHaveBeenCalled();
  });
});
