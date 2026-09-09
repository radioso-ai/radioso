import { describe, expect, it, vi } from "vitest";

import type { AttemptRoutineInput } from "@radioso/conversation-contract";
import { attemptRoutine } from "../src/routineActivation.js";

const inputWithActivator = (activate: AttemptRoutineInput["routineActivator"]): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "please help" },
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  routineStore: {
    loadActive: vi.fn(async () => null),
    loadCompleted: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  routineRunner: {
    resume: vi.fn(async () => ({ response: { answer: "unused" }, nextState: null })),
  },
  routineActivator: activate,
});

describe("routine activation failures", () => {
  it("preserves the originating selection error as a cause while keeping the public message safe", async () => {
    const cause = new Error("provider adapter failed");

    await expect(attemptRoutine(inputWithActivator({
      activate: vi.fn(async () => { throw cause; }),
    }))).rejects.toMatchObject({
      name: "RoutineActivationFailure",
      phase: "selection",
      message: "Routine selection failed",
      cause,
    });
  });
});
