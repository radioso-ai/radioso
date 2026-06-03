import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  Routine,
  RoutineState,
  RoutineStep,
  RoutineTransition,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  InMemoryConversationRoutineStore,
  RoutineNextStepSelector,
  RoutineRegistry,
  RoutineStepRenderer,
} from "../src/index.js";

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

describe("routine defaults", () => {
  it("activates the first registered routine whose registration claims the turn", async () => {
    const first = vi.fn(async () => null);
    const registry = new RoutineRegistry([
      { routine: { ...routine, id: "a" }, activates: first },
      { routine: { ...routine, id: "b" }, activates: vi.fn(async () => ({ variables: { email: "x@y.z" } })) },
    ]);

    expect(registry.routines.map((candidate) => candidate.id)).toEqual(["a", "b"]);
    expect(registry.isEmpty).toBe(false);
    await expect(registry.activator().activate({ turn })).resolves.toEqual({
      routineId: "b",
      variables: { email: "x@y.z" },
    });
    expect(first).toHaveBeenCalledWith({ turn });
  });

  it("selects a transition from balanced JSON output and captures variables", async () => {
    const selector = new RoutineNextStepSelector(gateway('Reasoning: {"condition": 1, "variables": {"email": "a@b.c"}} done.'));
    await expect(selector.select({ routine, state, currentStep, transitions, turn })).resolves.toEqual({
      nextStepId: "ask_message",
      variables: { email: "a@b.c" },
    });
  });

  it("stays put without calling the model when there are no outgoing transitions", async () => {
    const gw = gateway("{}");
    const decision = await new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions: [], turn });
    expect(decision.nextStepId).toBe("ask_email");
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("renders a step reply through the model gateway and trims it", async () => {
    const gw = gateway("  What's your email address?  ");
    const result = await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn,
    });

    expect(result.answer).toBe("What's your email address?");
    expect(vi.mocked(gw.complete).mock.calls[0]?.[0].systemPrompt).toContain("Ask the user for their email address.");
  });

  it("expires active routine state after the configured TTL", async () => {
    let now = 1000;
    const store = new InMemoryConversationRoutineStore({ ttlMs: 50, now: () => now });
    await store.save(state);
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toEqual(state);

    now = 1050;
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();
  });
});
