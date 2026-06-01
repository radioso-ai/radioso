import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationRoutineStepRenderer,
  Routine,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";

const routine: Routine = {
  id: "contact",
  rootStepId: "ask_email",
  steps: [
    { id: "ask_email", kind: "chat", action: "Ask the user for their email address." },
    { id: "ask_message", kind: "chat", action: "Ask the user for the message they want to send." },
    { id: "done", kind: "terminal", action: "Confirm the request was sent." },
  ],
  transitions: [
    { from: "ask_email", to: "ask_message", condition: "a valid email was provided" },
    { from: "ask_message", to: "done", condition: "a message was provided" },
  ],
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content: "alex@example.com" },
  history: [],
  stagedContext: [],
  steering: [],
};

const state = (path: string[], variables: Record<string, unknown> = {}): RoutineState => ({
  sessionId: "session_1",
  routineId: "contact",
  path,
  variables,
  status: "active",
});

const echoRenderer: ConversationRoutineStepRenderer = {
  render: vi.fn(async ({ step, steering }) => ({
    answer: `[${step.id}] ${steering[0]?.action ?? ""}`,
    metadata: { steeringCount: steering.length },
  })),
};

describe("DefaultRoutineRunner", () => {
  it("advances to the selected next step, projects its action into routine steering, and captures variables", async () => {
    const renderer: ConversationRoutineStepRenderer = { render: vi.fn(echoRenderer.render) };
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message", variables: { email: "alex@example.com" } })) },
      renderer,
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    // Projected the landed step's action as routine-sourced steering, passed to the renderer.
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_message" }),
      steering: [expect.objectContaining({
        source: "routine",
        action: "Ask the user for the message they want to send.",
        lifespan: "response",
      })],
    }));
    expect(result.response.answer).toContain("ask_message");
    expect(result.nextState).toMatchObject({
      path: ["ask_email", "ask_message"],
      variables: { email: "alex@example.com" },
      status: "active",
    });
  });

  it("clears state (null next) when the routine reaches a terminal step", async () => {
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "done" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email", "ask_message"], { email: "a@b.c", message: "hi" }) });

    expect(result.response.answer).toContain("done");
    expect(result.nextState).toBeNull();
  });

  it("stays on the current step (re-ask) without growing the path", async () => {
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.nextState).toMatchObject({ path: ["ask_email"] });
  });

  it("offers the current step's outgoing transitions to the selector", async () => {
    const select = vi.fn(async () => ({ nextStepId: "ask_message" }));
    const runner = new DefaultRoutineRunner([routine], { select }, { render: vi.fn(echoRenderer.render) });

    await runner.resume({ turn, state: state(["ask_email"]) });

    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      currentStep: expect.objectContaining({ id: "ask_email" }),
      transitions: [expect.objectContaining({ from: "ask_email", to: "ask_message" })],
    }));
  });

  it("throws when the routine id is not registered", async () => {
    const runner = new DefaultRoutineRunner([], { select: vi.fn() }, { render: vi.fn() });
    await expect(runner.resume({ turn, state: state(["ask_email"]) })).rejects.toThrow("routine_not_found:contact");
  });
});
