import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  Routine,
  RoutineState,
  RoutineStep,
  RoutineTransition,
  TurnContext,
} from "@radioso/conversation-contract";

import { RoutineNextStepSelector } from "../../src/modules/chat/services/routines/routineNextStepSelector.js";

const turn: TurnContext = {
  agent: { id: "a", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "alex@example.com" },
  history: [{ role: "assistant", content: "What is your email?" }],
  stagedContext: [],
  steering: [],
};
const routine: Routine = { id: "contact", rootStepId: "ask_email", steps: [], transitions: [] };
const currentStep: RoutineStep = { id: "ask_email", kind: "chat", action: "Ask for the user's email." };
const transitions: RoutineTransition[] = [
  { from: "ask_email", to: "ask_message", condition: "a valid email was provided" },
];
const state: RoutineState = { sessionId: "s1", routineId: "contact", path: ["ask_email"], variables: {}, status: "active" };

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

describe("RoutineNextStepSelector", () => {
  it("maps the chosen condition number to its transition target and captures variables", async () => {
    const selector = new RoutineNextStepSelector(gateway('{"condition": 1, "variables": {"email": "alex@example.com"}}'));
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_message", variables: { email: "alex@example.com" } });
  });

  it("tolerates a code-fenced / prose-wrapped JSON object", async () => {
    const selector = new RoutineNextStepSelector(gateway('Sure:\n```json\n{"condition": 1, "variables": {}}\n```'));
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision.nextStepId).toBe("ask_message");
  });

  it("extracts the first balanced JSON object from surrounding prose with trailing text", async () => {
    const selector = new RoutineNextStepSelector(
      gateway('Reasoning: the user gave an email. {"condition": 1, "variables": {"email": "a@b.c"}} — done.'),
    );
    const decision = await selector.select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_message", variables: { email: "a@b.c" } });
  });

  it("stays on the current step when the model returns null or unparseable output", async () => {
    for (const text of ['{"condition": null, "variables": {}}', "not json at all"]) {
      const decision = await new RoutineNextStepSelector(gateway(text)).select({ routine, state, currentStep, transitions, turn });
      expect(decision.nextStepId).toBe("ask_email");
    }
  });

  it("stays on the current step when the choice is out of range", async () => {
    const decision = await new RoutineNextStepSelector(gateway('{"condition": 9, "variables": {}}'))
      .select({ routine, state, currentStep, transitions, turn });
    expect(decision.nextStepId).toBe("ask_email");
  });

  it("stays put without calling the model when there are no outgoing transitions", async () => {
    const gw = gateway("{}");
    const decision = await new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions: [], turn });
    expect(decision.nextStepId).toBe("ask_email");
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("frames the transition conditions, the skill result, and the latest user message in the prompt", async () => {
    const gw = gateway('{"condition": 1, "variables": {}}');
    await new RoutineNextStepSelector(gw).select({
      routine, state, currentStep, transitions, turn,
      skillResult: { status: "completed", outputs: { requestId: "r1" } },
    });
    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("a valid email was provided");
    expect(call.systemPrompt).toContain("completed");
    expect(call.systemPrompt).toContain("requestId");
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "alex@example.com" });
  });
});
