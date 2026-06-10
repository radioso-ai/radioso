import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT,
  DEFAULT_ROUTINE_NEXT_STEP_PROMPT,
  DEFAULT_ROUTINE_STEP_REPLY_PROMPT,
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
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendPrompt = (relativePath: string): string =>
  readFileSync(path.resolve(testDirectory, "../../../backend/prompts", relativePath), "utf8").trimEnd();

describe("routine defaults", () => {
  it("keeps package fallback prompts byte-equal to the backend prompt files", () => {
    expect(DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT).toBe(backendPrompt("chat/directive-match.md"));
    expect(DEFAULT_ROUTINE_NEXT_STEP_PROMPT).toBe(backendPrompt("chat/routine-next-step.md"));
    expect(DEFAULT_ROUTINE_STEP_REPLY_PROMPT).toBe(backendPrompt("chat/routine-step-reply.md"));
  });

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

  it("yields the turn when the model marks the latest message off-topic", async () => {
    const decision = await new RoutineNextStepSelector(
      gateway('{"condition": null, "offTopic": true, "variables": {}}'),
    ).select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_email", yieldTurn: true });
  });

  it("follows a decline transition instead of yielding or re-asking", async () => {
    const declineTransitions: RoutineTransition[] = [
      { from: "ask_email", to: "cancelled", condition: "the user declined, cancelled, refused, or wants to stop" },
    ];
    const decision = await new RoutineNextStepSelector(
      gateway('{"condition": 1, "offTopic": false, "variables": {}}'),
    ).select({ routine, state, currentStep, transitions: declineTransitions, turn });
    expect(decision).toEqual({ nextStepId: "cancelled", variables: {} });
  });

  it("throws when a prompt template leaves a variable unfilled", async () => {
    const selector = new RoutineNextStepSelector(gateway("{}"), {
      promptTemplate: "{{currentStep}}\n{{missing}}",
    });

    await expect(selector.select({ routine, state, currentStep, transitions, turn })).rejects.toThrow(
      'Missing prompt variable "missing" for template chat/routine-next-step.md',
    );
  });

  it("substitutes prompt variables in a single pass", async () => {
    const gw = gateway("ok");
    await new RoutineStepRenderer(gw, { promptTemplate: "{{instructions}}" }).render({
      step: { ...currentStep, action: "Ask literally for {{missing}}." },
      steering: [],
      turn,
    });

    expect(vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt).toBe("- Ask literally for {{missing}}.");
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

  it("injects the agent scope and an out-of-scope decline rule into the routine reply prompt", async () => {
    const gw = gateway("ok");
    const scopedTurn: TurnContext = {
      ...turn,
      agent: { id: "a", name: "Ananda", instructions: ["Help only with Ananda Europe programs and events."] },
    };
    await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn: scopedTurn,
    });

    const systemPrompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(systemPrompt).toContain("Ananda");
    expect(systemPrompt).toContain("Help only with Ananda Europe programs and events.");
    expect(systemPrompt).toContain("do not answer or perform it");
    expect(systemPrompt).toContain("Never produce off-scope content");
  });

  it("keeps only declared slots when a routine declares a slot schema", async () => {
    const slotted: Routine = {
      ...routine,
      slots: [{ id: "s_email", key: "email", type: "email", required: true }],
    };
    const selector = new RoutineNextStepSelector(
      gateway('{"condition": 1, "variables": {"email": "a@b.c", "message": "write me code", "<name>": "x"}}'),
    );

    await expect(selector.select({ routine: slotted, state, currentStep, transitions, turn })).resolves.toEqual({
      nextStepId: "ask_message",
      variables: { email: "a@b.c" },
    });
  });

  it("drops echoed placeholder keys even when no slot schema is declared", async () => {
    const selector = new RoutineNextStepSelector(
      gateway('{"condition": 1, "variables": {"email": "a@b.c", "<name>": "x"}}'),
    );

    await expect(selector.select({ routine, state, currentStep, transitions, turn })).resolves.toEqual({
      nextStepId: "ask_message",
      variables: { email: "a@b.c" },
    });
  });

  it("expires active routine state after the configured TTL", async () => {
    let now = 1000;
    const store = new InMemoryConversationRoutineStore({ ttlMs: 50, now: () => now });
    await store.save(state);
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toEqual(state);

    now = 1050;
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();
  });

  it("does not load completed or explicitly expired routine state", async () => {
    const store = new InMemoryConversationRoutineStore();

    await store.save({ ...state, status: "completed" });
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();

    await store.save({ ...state, status: "expired" });
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();
  });
});
