import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  Routine,
  RoutineReentryMode,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineReentryGate } from "../src/index.js";

const routine = (reentryMode: RoutineReentryMode): Routine => ({
  id: "routine_qualify",
  rootStepId: "ask",
  steps: [],
  transitions: [],
  activation: { reentryMode, triggerDescription: "Qualify a prospect.", priority: 0 },
});

const completedState: RoutineState = {
  sessionId: "session_1",
  routineId: "routine_qualify",
  path: ["done"],
  variables: { budget: "10k" },
  status: "completed",
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "i1", kind: "message", content: "let's qualify another lead" },
  history: [],
  stagedContext: [],
  steering: [],
};

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

describe("RoutineReentryGate", () => {
  it("suppresses without a model call when the routine is not in semantic mode", async () => {
    const gw = gateway("{}");
    for (const mode of ["once_per_conversation", "always"] as const) {
      const decision = await new RoutineReentryGate([routine(mode)], gw).decide({ turn, completedState });
      expect(decision).toEqual({ kind: "suppress" });
    }
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("returns the model's structured decision for a semantic routine", async () => {
    for (const kind of ["resume_existing", "start_new", "suppress"] as const) {
      const gw = gateway(JSON.stringify({ decision: kind }));
      const decision = await new RoutineReentryGate([routine("semantic")], gw).decide({ turn, completedState });
      expect(decision).toEqual({ kind });
    }
  });

  it("includes the routine guidance and collected variables in the prompt", async () => {
    const gw = gateway(JSON.stringify({ decision: "suppress" }));
    await new RoutineReentryGate([routine("semantic")], gw).decide({ turn, completedState });
    const prompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(prompt).toContain("Qualify a prospect.");
    expect(prompt).toContain("budget: 10k");
  });

  it("defaults to suppress on malformed model output", async () => {
    const gw = gateway("not json");
    const decision = await new RoutineReentryGate([routine("semantic")], gw).decide({ turn, completedState });
    expect(decision).toEqual({ kind: "suppress" });
  });

  it("suppresses for an unknown routine id without a model call", async () => {
    const gw = gateway("{}");
    const decision = await new RoutineReentryGate([routine("semantic")], gw)
      .decide({ turn, completedState: { ...completedState, routineId: "missing" } });
    expect(decision).toEqual({ kind: "suppress" });
    expect(gw.complete).not.toHaveBeenCalled();
  });
});
