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

  it("yields the turn (no render, state unchanged) when the selector declines as off-topic", async () => {
    const render = vi.fn();
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", yieldTurn: true })) },
      { render },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.yielded).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });

  it("resumes from the last step in a multi-element path, not the root", async () => {
    const select = vi.fn(async () => ({ nextStepId: "done" }));
    const runner = new DefaultRoutineRunner([routine], { select }, { render: vi.fn(echoRenderer.render) });

    await runner.resume({ turn, state: state(["ask_email", "ask_message"]) });

    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      currentStep: expect.objectContaining({ id: "ask_message" }),
      transitions: [expect.objectContaining({ from: "ask_message", to: "done" })],
    }));
  });

  it("merges newly captured variables onto the ones already collected", async () => {
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message", variables: { message: "hi" } })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"], { email: "a@b.c" }) });

    expect(result.nextState?.variables).toEqual({ email: "a@b.c", message: "hi" });
  });

  it("treats a selector choice that is not a declared successor as staying put", async () => {
    // "done" is not an outgoing target of ask_email (only ask_message is) — the runner
    // must not let the selector jump the turn to an arbitrary step.
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "done" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.nextState?.path).toEqual(["ask_email"]);
    expect(result.response.answer).toContain("ask_email");
  });

  it("fast-forwards through multiple already-filled typed slot collection steps in one turn", async () => {
    const slotRoutine: Routine = {
      id: "intake",
      rootStepId: "ask_name",
      slots: [
        { id: "slot_name", key: "name", type: "text", required: true },
        { id: "slot_email", key: "email", type: "email", required: true },
      ],
      steps: [
        { id: "ask_name", kind: "chat", action: "Ask for name.", metadata: { collectsSlots: ["name"] } },
        { id: "ask_email", kind: "chat", action: "Ask for email.", metadata: { collectsSlots: ["email"] } },
        { id: "done", kind: "terminal", action: "Confirm intake." },
      ],
      transitions: [
        { from: "ask_name", to: "ask_email", condition: "name was provided" },
        { from: "ask_email", to: "done", condition: "email was provided" },
      ],
    };
    const select = vi.fn(async () => ({
      nextStepId: "ask_email",
      variables: { name: "Alex", email: "alex@example.com" },
    }));
    const renderer: ConversationRoutineStepRenderer = { render: vi.fn(echoRenderer.render) };
    const runner = new DefaultRoutineRunner([slotRoutine], { select }, renderer);

    const result = await runner.resume({ turn, state: { ...state(["ask_name"]), routineId: "intake" } });

    expect(select).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "done" }),
    }));
    expect(result.nextState).toBeNull();
  });

  it("fast-forwards past filled typed slot steps and renders the first missing slot prompt", async () => {
    const slotRoutine: Routine = {
      id: "intake",
      rootStepId: "ask_name",
      slots: [
        { id: "slot_name", key: "name", type: "text", required: true },
        { id: "slot_email", key: "email", type: "email", required: true },
      ],
      steps: [
        { id: "ask_name", kind: "chat", action: "Ask for name.", metadata: { collectsSlots: ["name"] } },
        { id: "ask_email", kind: "chat", action: "Ask for email.", metadata: { collectsSlots: ["email"] } },
        { id: "done", kind: "terminal", action: "Confirm intake." },
      ],
      transitions: [
        { from: "ask_name", to: "ask_email", condition: "name was provided" },
        { from: "ask_email", to: "done", condition: "email was provided" },
      ],
    };
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", variables: { name: "Alex" } })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: { ...state(["ask_name"]), routineId: "intake" } });

    expect(result.response.answer).toContain("ask_email");
    expect(result.nextState).toMatchObject({
      path: ["ask_name", "ask_email"],
      variables: { name: "Alex" },
    });
  });

  it("does not fast-forward contact-shaped routines without a typed slot schema", async () => {
    const noSchemaRoutine: Routine = {
      ...routine,
      steps: routine.steps.map((step) =>
        step.id === "ask_message"
          ? { ...step, metadata: { collectsSlots: ["message"] } }
          : step,
      ),
    };
    const runner = new DefaultRoutineRunner(
      [noSchemaRoutine],
      {
        select: vi.fn(async () => ({
          nextStepId: "ask_message",
          variables: { email: "alex@example.com", message: "hello" },
        })),
      },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.response.answer).toContain("ask_message");
    expect(result.nextState).toMatchObject({
      path: ["ask_email", "ask_message"],
      variables: { email: "alex@example.com", message: "hello" },
    });
  });

  it("throws on a skill-step cycle instead of looping forever (or re-dispatching the skill)", async () => {
    const cyclic: Routine = {
      id: "loop",
      rootStepId: "a",
      steps: [
        { id: "a", kind: "chat", action: "start" },
        { id: "s1", kind: "skill", skillName: "x" },
        { id: "s2", kind: "skill", skillName: "y" },
      ],
      transitions: [
        { from: "a", to: "s1", condition: "go" },
        { from: "s1", to: "s2", condition: "next" },
        { from: "s2", to: "s1", condition: "back" },
      ],
    };
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner(
      [cyclic],
      { select: vi.fn(async () => ({ nextStepId: "s1" })) },
      { render: vi.fn() },
      { dispatch },
    );

    await expect(runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "loop", path: ["a"], variables: {}, status: "active" },
    })).rejects.toThrow("routine_walk_exceeded");
    // The guard fires after a bounded number of dispatches, not unboundedly.
    expect(dispatch.mock.calls.length).toBeLessThanOrEqual(cyclic.steps.length + 1);
  });
});

describe("DefaultRoutineRunner skill (tool) steps", () => {
  const singleEdge: Routine = {
    id: "contact",
    rootStepId: "ask_message",
    steps: [
      { id: "ask_message", kind: "chat", action: "Ask for the message." },
      { id: "submit", kind: "skill", skillName: "human_contact.request" },
      { id: "done", kind: "terminal", action: "Confirm the request was sent." },
    ],
    transitions: [
      { from: "ask_message", to: "submit", condition: "a message was provided" },
      { from: "submit", to: "done", condition: "the submission completed" },
    ],
  };
  const multiEdge: Routine = {
    ...singleEdge,
    steps: [...singleEdge.steps, { id: "failed", kind: "terminal", action: "Apologize; it failed." }],
    transitions: [
      ...singleEdge.transitions,
      { from: "submit", to: "failed", condition: "the submission failed" },
    ],
  };
  const atMessage = (routineId = "contact"): RoutineState => ({
    sessionId: "session_1", routineId, path: ["ask_message"], variables: { message: "hi" }, status: "active",
  });

  it("auto-advances past a single-edge skill step without calling the selector again", async () => {
    const select = vi.fn(async () => ({ nextStepId: "submit" }));
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner([singleEdge], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: atMessage() });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ skillName: "human_contact.request" }));
    // Selector ran once (to land on the skill step); the post-skill hop was deterministic.
    expect(select).toHaveBeenCalledTimes(1);
    expect(result.response.answer).toContain("done");
    expect(result.nextState).toBeNull();
  });

  it("defers a multi-edge skill step's follow-up to the selector, passing the skill result", async () => {
    const select = vi.fn(async ({ currentStep }) =>
      currentStep.id === "ask_message" ? { nextStepId: "submit" } : { nextStepId: "done" },
    );
    const dispatch = vi.fn(async () => ({ status: "completed" as const, outputs: { requestId: "r1" } }));
    const runner = new DefaultRoutineRunner([multiEdge], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: atMessage() });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({
      currentStep: expect.objectContaining({ id: "submit" }),
      skillResult: expect.objectContaining({ status: "completed" }),
    }));
    expect(result.response.answer).toContain("done");
  });

  it("throws when a skill step is reached without a dispatcher", async () => {
    const runner = new DefaultRoutineRunner(
      [singleEdge],
      { select: vi.fn(async () => ({ nextStepId: "submit" })) },
      { render: vi.fn() },
    );
    await expect(runner.resume({ turn, state: atMessage() })).rejects.toThrow("routine_skill_dispatcher_missing");
  });

  it("throws when a skill step has no follow-up edge (rather than parking on it)", async () => {
    const noFollowUp: Routine = {
      id: "contact",
      rootStepId: "ask_message",
      steps: [
        { id: "ask_message", kind: "chat", action: "Ask for the message." },
        { id: "submit", kind: "skill", skillName: "x" },
      ],
      transitions: [{ from: "ask_message", to: "submit", condition: "a message was provided" }],
    };
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner(
      [noFollowUp],
      { select: vi.fn(async () => ({ nextStepId: "submit" })) },
      { render: vi.fn() },
      { dispatch },
    );
    await expect(runner.resume({ turn, state: atMessage() })).rejects.toThrow("routine_skill_step_no_follow_up");
  });

  it("advances along the first edge (never parks/re-dispatches) when the selector declines on a multi-edge skill step", async () => {
    // From ask_message land on submit; on submit the selector declines (returns the
    // current step id) → the runner advances to the first edge (done) instead of
    // parking on the skill step and re-dispatching next turn.
    const select = vi.fn(async () => ({ nextStepId: "submit" }));
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner([multiEdge], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: atMessage() });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.response.answer).toContain("done");
    expect(result.nextState).toBeNull();
  });
});

describe("DefaultRoutineRunner action (fire-and-forget) steps", () => {
  const actionRoutine: Routine = {
    id: "contact",
    rootStepId: "ask_message",
    steps: [
      { id: "ask_message", kind: "chat", action: "Ask for the message." },
      { id: "submit", kind: "action", actionType: "contact.send" },
      { id: "done", kind: "terminal", action: "Confirm the request was sent." },
    ],
    transitions: [
      { from: "ask_message", to: "submit", condition: "a message was provided" },
      { from: "submit", to: "done", condition: "after emitting" },
    ],
  };
  const atMessage = (variables: Record<string, unknown> = {}): RoutineState => ({
    sessionId: "session_1", routineId: "contact", path: ["ask_message"], variables, status: "active",
  });

  it("emits an action request (authored type + the routine variables as payload) and auto-advances", async () => {
    const select = vi.fn(async () => ({ nextStepId: "submit" }));
    const runner = new DefaultRoutineRunner([actionRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({ turn, state: atMessage({ email: "a@b.c", message: "hi" }) });

    expect(result.actions).toEqual([{ type: "contact.send", payload: { email: "a@b.c", message: "hi" } }]);
    // Advanced past the action step to the confirmation/terminal step and cleared state.
    expect(result.response.answer).toContain("done");
    expect(result.nextState).toBeNull();
    // No selector call for the action step's hop (auto-advance), and no skill dispatcher needed.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("throws when an action step has no follow-up edge", async () => {
    const noFollowUp: Routine = {
      id: "contact",
      rootStepId: "ask_message",
      steps: [
        { id: "ask_message", kind: "chat", action: "Ask." },
        { id: "submit", kind: "action", actionType: "contact.send" },
      ],
      transitions: [{ from: "ask_message", to: "submit", condition: "a message was provided" }],
    };
    const runner = new DefaultRoutineRunner([noFollowUp], { select: vi.fn(async () => ({ nextStepId: "submit" })) }, { render: vi.fn() });
    await expect(runner.resume({ turn, state: atMessage() })).rejects.toThrow("routine_action_step_no_follow_up");
  });

  it("throws when an action step declares no actionType", async () => {
    const noType: Routine = {
      ...actionRoutine,
      steps: [
        { id: "ask_message", kind: "chat", action: "Ask." },
        { id: "submit", kind: "action" },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
    };
    const runner = new DefaultRoutineRunner([noType], { select: vi.fn(async () => ({ nextStepId: "submit" })) }, { render: vi.fn() });
    await expect(runner.resume({ turn, state: atMessage() })).rejects.toThrow("routine_action_step_missing_type");
  });
});
