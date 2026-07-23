import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineSkillDispatcher,
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

  it("substitutes captured slot values into the rendered step instruction", async () => {
    const slotRoutine: Routine = {
      id: "contact",
      rootStepId: "confirm",
      steps: [{ id: "confirm", kind: "chat", action: "Confirm we will call you at {{slot.phone}}." }],
      transitions: [],
    };
    // A dedicated renderer that echoes the projected step instruction it receives.
    const renderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ steering }) => ({ answer: steering[0]?.action ?? "", metadata: {} })),
    };
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "confirm" })) },
      renderer,
    );

    const result = await runner.resume({
      turn,
      state: state(["confirm"], { phone: "555-1234" }),
    });

    // The captured value is filled into the instruction; the raw token is never shown.
    expect(result.response.answer).toBe("Confirm we will call you at 555-1234.");
    expect(result.response.answer).not.toContain("{{slot.phone}}");
  });

  it("dispatches a root skill step and passes its outputs as staged context to the rendered chat step", async () => {
    const toolRoutine: Routine = {
      id: "contact",
      rootStepId: "retrieve_context",
      steps: [
        { id: "retrieve_context", kind: "skill", skillName: "retrieval.context", action: "Find grounding context." },
        { id: "answer", kind: "chat", action: "Answer from the retrieved context." },
      ],
      transitions: [
        { from: "retrieve_context", to: "answer", condition: "context gathered", guard: { kind: "default" } },
      ],
    };
    const dispatch: ConversationRoutineSkillDispatcher["dispatch"] = vi.fn(async () => ({
      status: "completed",
      outputs: {
        has_context: true,
        contexts: [{ title: "Guide", content: "Kriya is described here." }],
      },
    }));
    const renderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ turn }) => ({
        answer: JSON.stringify(turn.stagedContext),
        metadata: {},
      })),
    };
    const runner = new DefaultRoutineRunner(
      [toolRoutine],
      { select: vi.fn(async () => ({ nextStepId: "answer" })) },
      renderer,
      { dispatch },
    );

    const result = await runner.resume({ turn, state: state([]) });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ skillName: "retrieval.context" }));
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "answer" }),
      turn: expect.objectContaining({
        stagedContext: [expect.objectContaining({
          kind: "skill_result",
          source: "retrieval.context",
          data: expect.objectContaining({ has_context: true }),
        })],
      }),
    }));
    expect(result.nextState).toMatchObject({ path: ["retrieve_context", "answer"] });
  });

  it("carries non-model skill metadata on staged context metadata", async () => {
    const toolRoutine: Routine = {
      id: "contact",
      rootStepId: "retrieve_context",
      steps: [
        { id: "retrieve_context", kind: "skill", skillName: "retrieval.context", action: "Find grounding context." },
        { id: "answer", kind: "chat", action: "Answer from the retrieved context." },
      ],
      transitions: [
        { from: "retrieve_context", to: "answer", condition: "context gathered", guard: { kind: "default" } },
      ],
    };
    const dispatch: ConversationRoutineSkillDispatcher["dispatch"] = vi.fn(async () => ({
      status: "context_ready",
      outputs: { has_context: true, contexts: [{ title: "Guide", content: "Kriya is described here." }] },
      metadata: { retrievalResultKey: "hidden-result" },
    }));
    const renderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ turn }) => ({
        answer: JSON.stringify(turn.stagedContext),
        metadata: {},
      })),
    };
    const runner = new DefaultRoutineRunner(
      [toolRoutine],
      { select: vi.fn(async () => ({ nextStepId: "answer" })) },
      renderer,
      { dispatch },
    );

    await runner.resume({ turn, state: state([]) });

    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        stagedContext: [expect.objectContaining({
          kind: "skill_result",
          source: "retrieval.context",
          metadata: expect.objectContaining({
            stepId: "retrieve_context",
            status: "context_ready",
            skillMetadata: { retrievalResultKey: "hidden-result" },
          }),
        })],
      }),
    }));
  });

  it("routes root skill steps by their routable outcome status", async () => {
    const toolRoutine: Routine = {
      id: "contact",
      rootStepId: "retrieve_context",
      steps: [
        { id: "retrieve_context", kind: "skill", skillName: "retrieval.context", action: "Find grounding context." },
        { id: "answer", kind: "chat", action: "Answer from the retrieved context." },
        { id: "ask_followup", kind: "chat", action: "Ask a follow-up question." },
      ],
      transitions: [
        { from: "retrieve_context", to: "answer", condition: "context gathered", guard: { kind: "outcome", status: "context_ready" } },
        { from: "retrieve_context", to: "ask_followup", condition: "no context", guard: { kind: "outcome", status: "no_context" } },
      ],
    };
    const dispatch: ConversationRoutineSkillDispatcher["dispatch"] = vi.fn(async () => ({
      status: "no_context",
      outputs: { has_context: false, contexts: [] },
    }));
    const renderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ step }) => ({ answer: step.id, metadata: {} })),
    };
    const runner = new DefaultRoutineRunner(
      [toolRoutine],
      { select: vi.fn(async () => ({ nextStepId: "answer" })) },
      renderer,
      { dispatch },
    );

    const result = await runner.resume({ turn, state: state([]) });

    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_followup" }),
    }));
    expect(result.nextState).toMatchObject({ path: ["retrieve_context", "ask_followup"] });
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

  it("emits a webhook.send action when a matching completion-export terminal is reached", async () => {
    const exportRoutine: Routine = {
      ...routine,
      id: "routine:agent_1:lead_capture:v3",
      slots: [
        { id: "slot_email", key: "email", type: "email", required: true },
        { id: "slot_message", key: "message", type: "text", required: true },
      ],
      completionExport: {
        enabled: true,
        destinationRef: "33333333-3333-4333-8333-333333333333",
        triggerKinds: ["complete"],
      },
    };
    const runner = new DefaultRoutineRunner(
      [exportRoutine],
      { select: vi.fn(async () => ({ nextStepId: "done" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({
      turn,
      state: {
        ...state(["ask_email", "ask_message"], { email: "a@b.c", message: "hi" }),
        routineId: exportRoutine.id,
      },
    });

    expect(result.actions).toEqual([{
      type: "webhook.send",
      payload: {
        destinationRef: "33333333-3333-4333-8333-333333333333",
        source: {
          routineId: "routine:agent_1:lead_capture:v3",
          stepId: "done",
          terminalKind: "complete",
          status: "completed",
        },
        data: { email: "a@b.c", message: "hi" },
      },
    }]);
    expect(result.nextState).toBeNull();
  });

  it("filters completion-export data to declared routine slot keys", async () => {
    const exportRoutine: Routine = {
      ...routine,
      id: "routine:agent_1:lead_capture:v4",
      slots: [
        { id: "slot_email", key: "email", type: "email", required: true },
      ],
      completionExport: {
        enabled: true,
        destinationRef: "33333333-3333-4333-8333-333333333333",
        triggerKinds: ["complete"],
      },
    };
    const runner = new DefaultRoutineRunner(
      [exportRoutine],
      { select: vi.fn(async () => ({ nextStepId: "done" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({
      turn,
      state: {
        ...state(["ask_email", "ask_message"], {
          email: "a@b.c",
          company: "Acme",
          budget: "$10k",
        }),
        routineId: exportRoutine.id,
      },
    });

    expect(result.actions?.[0]?.payload).toEqual(expect.objectContaining({
      data: { email: "a@b.c" },
    }));
  });

  it("does not emit completion export when the terminal kind is not configured", async () => {
    const exportRoutine: Routine = {
      ...routine,
      completionExport: {
        enabled: true,
        destinationRef: "33333333-3333-4333-8333-333333333333",
        triggerKinds: ["handoff"],
      },
    };
    const runner = new DefaultRoutineRunner(
      [exportRoutine],
      { select: vi.fn(async () => ({ nextStepId: "done" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({
      turn,
      state: state(["ask_email", "ask_message"], { email: "a@b.c", message: "hi" }),
    });

    expect(result.actions).toBeUndefined();
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

  it("does not yield on the activation turn — lands on (renders) the current step instead", async () => {
    // Fresh activation: state was built this turn (path []), so the user's message is the
    // routine's trigger, not a reply to ask_email. A selector that reads it as off-topic
    // and yields must be overridden to stay on the root step so the activation isn't dropped.
    const render = vi.fn(async ({ step }: { step: { id: string } }) => ({ answer: `[${step.id}]`, metadata: {} }));
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", yieldTurn: true })) },
      { render },
    );

    const result = await runner.resume({ turn, state: state([]), activationTurn: true });

    expect(result.yielded).toBeFalsy();
    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_email" }),
    }));
    expect(result.response.answer).toContain("ask_email");
    // Staying on the root step keeps the (empty) path stable and the routine active.
    expect(result.nextState).toMatchObject({ path: [], status: "active" });
  });

  it("still yields off-topic mid-routine when it is not an activation turn (activationTurn false)", async () => {
    const render = vi.fn();
    const runner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message", yieldTurn: true })) },
      { render },
    );

    const result = await runner.resume({
      turn,
      state: state(["ask_email"]),
      activationTurn: false,
    });

    expect(result.yielded).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });

  it("converts a main-selection yield and fast-forwards past the satisfied root on the activation turn", async () => {
    // Activation seeds the root slot (name). The main selection's yield is converted to a
    // stay on ask_name, which is satisfied and has a single outgoing edge, so the routine
    // fast-forwards deterministically and renders the unsatisfied ask_email step.
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
        { id: "bail", kind: "terminal", action: "Bail out." },
      ],
      transitions: [
        { from: "ask_name", to: "ask_email", condition: "name was provided" },
        { from: "ask_email", to: "done", condition: "email was provided" },
        { from: "ask_email", to: "bail", condition: "the user gave up" },
      ],
    };
    const render = vi.fn(async ({ step }: { step: { id: string } }) => ({ answer: `[${step.id}]`, metadata: {} }));
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", yieldTurn: true })) },
      { render },
    );

    const result = await runner.resume({
      turn,
      state: { ...state([], { name: "Alex" }), routineId: "intake" },
      activationTurn: true,
    });

    expect(result.yielded).toBeFalsy();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0]!.step.id).toBe("ask_email");
    expect(result.response.answer).toContain("ask_email");
  });

  it("does not yield when the fast-forward selector itself yields on the activation turn", async () => {
    // The satisfied root has TWO outgoing edges, so the fast-forward walk consults the
    // selector; its yield is converted to a stay, which stops the walk and renders the
    // step the routine is on (degrade-don't-throw) instead of dropping the activation.
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
        { id: "bail", kind: "terminal", action: "Bail out." },
      ],
      transitions: [
        { from: "ask_name", to: "ask_email", condition: "name was provided" },
        { from: "ask_name", to: "bail", condition: "the user gave up" },
        { from: "ask_email", to: "done", condition: "email was provided" },
      ],
    };
    const render = vi.fn(async ({ step }: { step: { id: string } }) => ({ answer: `[${step.id}]`, metadata: {} }));
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", yieldTurn: true })) },
      { render },
    );

    const result = await runner.resume({
      turn,
      state: { ...state([], { name: "Alex" }), routineId: "intake" },
      activationTurn: true,
    });

    expect(result.yielded).toBeFalsy();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0]!.step.id).toBe("ask_name");
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

  it("renders instead of throwing when a counter back-edge re-enters a satisfied slot step (loop)", async () => {
    // Two chat steps both reference {{slot.idea}} (so both are slot-collection steps),
    // with a counter back-edge forming a bounded loop. Once `idea` is filled, naive
    // fast-forward would skip step_ask → step_ack → step_ask … forever and throw
    // routine_fast_forward_exceeded (issue #733). The cycle must degrade to a render.
    const loopRoutine: Routine = {
      id: "ideas",
      rootStepId: "step_ask",
      slots: [{ id: "slot_idea", key: "idea", type: "text", required: true }],
      steps: [
        { id: "step_ask", kind: "chat", action: "Ask for one product idea {{slot.idea}}.", metadata: { collectsSlots: ["idea"] } },
        { id: "step_ack", kind: "chat", action: "Thank them for {{slot.idea}} and ask for another.", metadata: { collectsSlots: ["idea"] } },
        { id: "end", kind: "terminal", action: "Wrap up." },
      ],
      transitions: [
        { from: "step_ask", to: "step_ack", condition: "an idea was provided" },
        { from: "step_ack", to: "step_ask", condition: "more ideas welcome", guard: { kind: "counter", limit: 3 } },
        { from: "step_ack", to: "end", condition: "default", guard: { kind: "default" } },
      ],
    };
    const render = vi.fn(async ({ step }: { step: { id: string } }) => ({ answer: `[${step.id}]`, metadata: {} }));
    const runner = new DefaultRoutineRunner(
      [loopRoutine],
      { select: vi.fn(async () => ({ nextStepId: "step_ack", variables: { idea: "solar" } })) },
      { render },
    );

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "ideas", path: ["step_ask"], variables: {}, status: "active" },
    });

    // The turn settles on a chat step rather than throwing, and the routine continues.
    expect(render).toHaveBeenCalledTimes(1);
    expect(["step_ask", "step_ack"]).toContain(render.mock.calls[0]![0]!.step.id);
    expect(result.nextState).not.toBeNull();
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

  it("passes typed input bindings through skill dispatch so the host can build collected input", async () => {
    const typedRoutine: Routine = {
      ...singleEdge,
      steps: singleEdge.steps.map((step) =>
        step.id === "submit"
          ? {
              ...step,
              inputBindings: {
                message: { kind: "variableRef", ref: "message" },
                priority: { kind: "literal", value: "high" },
              },
            }
          : step,
      ),
    };
    let collected: Record<string, unknown> | undefined;
    const dispatch: ConversationRoutineSkillDispatcher["dispatch"] = vi.fn(async (input) => {
      collected = {};
      for (const [key, binding] of Object.entries(input.inputBindings ?? {})) {
        if (binding.kind === "literal") {
          collected[key] = binding.value;
        } else if (input.state.variables[binding.ref] !== undefined) {
          collected[key] = input.state.variables[binding.ref];
        }
      }
      return { status: "completed" as const };
    });
    const runner = new DefaultRoutineRunner(
      [typedRoutine],
      { select: vi.fn(async () => ({ nextStepId: "submit" })) },
      { render: vi.fn(echoRenderer.render) },
      { dispatch },
    );

    await runner.resume({ turn, state: atMessage() });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      inputBindings: {
        message: { kind: "variableRef", ref: "message" },
        priority: { kind: "literal", value: "high" },
      },
    }));
    expect(collected).toEqual({ message: "hi", priority: "high" });
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

  it("branches on structured outcome guards without consulting the selector for the skill result", async () => {
    const outcomeRoutine: Routine = {
      id: "order",
      rootStepId: "ask",
      steps: [
        { id: "ask", kind: "chat", action: "Ask for order info." },
        { id: "lookup", kind: "skill", skillName: "order_lookup" },
        { id: "found", kind: "terminal", action: "Share the order." },
        { id: "not_found", kind: "terminal", action: "Say it was not found." },
      ],
      transitions: [
        { from: "ask", to: "lookup", condition: "ready" },
        { from: "lookup", to: "found", condition: "found", guard: { kind: "outcome", status: "found" } },
        { from: "lookup", to: "not_found", condition: "not found", guard: { kind: "outcome", status: "not_found" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "lookup" }));
    const dispatch = vi.fn(async () => ({ status: "not_found" as const }));
    const runner = new DefaultRoutineRunner([outcomeRoutine], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: { ...atMessage("order"), path: ["ask"] } });

    expect(select).toHaveBeenCalledTimes(1);
    expect(result.response.answer).toContain("not_found");
    expect(result.nextState).toBeNull();
  });

  it("routes to a default handoff when the counter retry is exhausted", async () => {
    const retryRoutine: Routine = {
      id: "order",
      rootStepId: "ask",
      steps: [
        { id: "ask", kind: "chat", action: "Ask for order info." },
        { id: "lookup", kind: "skill", skillName: "order_lookup" },
        { id: "alternate_email", kind: "chat", action: "Ask for another email." },
        { id: "handoff", kind: "terminal", action: "Route to a human.", metadata: { terminalKind: "handoff" } },
      ],
      transitions: [
        { from: "ask", to: "lookup", condition: "ready" },
        { from: "alternate_email", to: "lookup", condition: "alternate email provided" },
        { from: "lookup", to: "alternate_email", condition: "retry available", guard: { kind: "counter", limit: 2 } },
        { from: "lookup", to: "handoff", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "lookup" }));
    const dispatch = vi.fn(async () => ({ status: "not_found" as const }));
    const runner = new DefaultRoutineRunner([retryRoutine], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const first = await runner.resume({ turn, state: { ...atMessage("order"), path: ["ask"], attempts: { ask: 1 } } });
    expect(first.response.answer).toContain("alternate_email");
    expect(first.nextState?.attempts).toMatchObject({ lookup: 1, alternate_email: 1 });

    const second = await runner.resume({
      turn,
      state: {
        sessionId: "session_1",
        routineId: "order",
        path: ["ask", "lookup", "alternate_email"],
        variables: {},
        status: "active",
        attempts: first.nextState?.attempts,
      },
    });

    expect(select).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(second.response.answer).toContain("handoff");
    expect(second.nextState).toBeNull();
    expect(second.terminal).toEqual({ kind: "handoff", stepId: "handoff" });
    expect(second.actions).toBeUndefined();
  });

  it("forces the default edge when a counter guard is exhausted", async () => {
    const counterDefaultRoutine: Routine = {
      id: "counter_default",
      rootStepId: "collect",
      steps: [
        { id: "collect", kind: "chat", action: "Ask for a new email." },
        { id: "lookup", kind: "skill", skillName: "order_lookup" },
        { id: "handoff", kind: "terminal", action: "Hand off.", metadata: { terminalKind: "handoff" } },
      ],
      transitions: [
        { from: "collect", to: "lookup", condition: "default", guard: { kind: "default" } },
        { from: "lookup", to: "collect", condition: "retry limit available", guard: { kind: "counter", limit: 2 } },
        { from: "lookup", to: "handoff", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "lookup" }));
    const dispatch = vi.fn(async () => ({ status: "not_found" as const }));
    const runner = new DefaultRoutineRunner([counterDefaultRoutine], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({
      turn,
      state: {
        sessionId: "session_1",
        routineId: "counter_default",
        path: ["collect", "lookup", "collect"],
        variables: {},
        status: "active",
        attempts: { collect: 2, lookup: 2 },
      },
    });

    expect(select).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.response.answer).toContain("handoff");
    expect(result.nextState).toBeNull();
    expect(result.terminal).toEqual({ kind: "handoff", stepId: "handoff" });
  });

  it("uses a slot_filled guard purely before falling back to the selector", async () => {
    const slotRoutine: Routine = {
      id: "slot_guard",
      rootStepId: "ask_email",
      steps: [
        { id: "ask_email", kind: "chat", action: "Ask for email." },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
      transitions: [
        { from: "ask_email", to: "done", condition: "email present", guard: { kind: "slot_filled", slots: ["email"] } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "ask_email" }));
    const runner = new DefaultRoutineRunner([slotRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "slot_guard", path: ["ask_email"], variables: { email: "a@b.c" }, status: "active" },
    });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("done");
    expect(result.nextState).toBeNull();
  });

  it("advances sole default transitions deterministically without consulting the selector", async () => {
    const alwaysRoutine: Routine = {
      id: "always_guard",
      rootStepId: "ask_email",
      steps: [
        { id: "ask_email", kind: "chat", action: "Ask for email." },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
      transitions: [
        { from: "ask_email", to: "done", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "ask_email" }));
    const runner = new DefaultRoutineRunner([alwaysRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "always_guard", path: ["ask_email"], variables: {}, status: "active" },
    });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("done");
    expect(result.nextState).toBeNull();
  });

  it("keeps llm-condition-only skill branches on the selector path for parity", async () => {
    const select = vi.fn(async ({ currentStep }) =>
      currentStep.id === "ask_message" ? { nextStepId: "submit" } : { nextStepId: "failed" },
    );
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner([multiEdge], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: atMessage() });

    expect(select).toHaveBeenCalledTimes(2);
    expect(result.response.answer).toContain("failed");
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

  it("writes assigned skill outputs into variables before later interpolation and field guards", async () => {
    const outputRoutine: Routine = {
      id: "refund",
      rootStepId: "ask",
      steps: [
        { id: "ask", kind: "chat", action: "Ask for the order." },
        {
          id: "lookup",
          kind: "skill",
          skillName: "check_order",
          outputAssignments: {
            is_final_sale: "finalSale",
            policy_message: "policyMessage",
          },
        },
        { id: "explain", kind: "chat", action: "Explain: {{slot.policyMessage}}." },
        { id: "refund", kind: "terminal", action: "Issue the refund." },
      ],
      transitions: [
        { from: "ask", to: "lookup", condition: "ready" },
        { from: "lookup", to: "explain", condition: "assigned final sale", guard: { kind: "field", ref: "finalSale", op: "is_true" } },
        { from: "lookup", to: "refund", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "lookup" }));
    const dispatch = vi.fn(async () => ({
      status: "completed" as const,
      outputs: { is_final_sale: true, policy_message: "This order is final sale." },
    }));
    const renderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ steering }) => ({ answer: steering[0]?.action ?? "", metadata: {} })),
    };
    const runner = new DefaultRoutineRunner([outputRoutine], { select }, renderer, { dispatch });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "refund", path: ["ask"], variables: {}, status: "active" },
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "explain" }),
    }));
    expect(result.response.answer).toBe("Explain: This order is final sale..");
    expect(result.nextState).toMatchObject({
      variables: {
        finalSale: true,
        policyMessage: "This order is final sale.",
      },
    });
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

describe("DefaultRoutineRunner field guards (deterministic branch-on-value)", () => {
  // A tool step returns a typed field; the routine branches on it in code, never via
  // the model. Mirrors the eligibility gate in the deterministic-procedures spec.
  const eligibility = (extra: Partial<Routine> = {}): Routine => ({
    id: "refund",
    rootStepId: "ask",
    steps: [
      { id: "ask", kind: "chat", action: "Ask for the order." },
      { id: "lookup", kind: "skill", skillName: "check_order" },
      { id: "explain", kind: "terminal", action: "Explain the policy." },
      { id: "refund", kind: "terminal", action: "Issue the refund." },
    ],
    transitions: [
      { from: "ask", to: "lookup", condition: "ready" },
      { from: "lookup", to: "explain", condition: "final sale", guard: { kind: "field", ref: "is_final_sale", op: "is_true" } },
      { from: "lookup", to: "refund", condition: "default", guard: { kind: "default" } },
    ],
    ...extra,
  });
  const atAsk = (): RoutineState => ({
    sessionId: "session_1", routineId: "refund", path: ["ask"], variables: {}, status: "active",
  });

  it("branches on a tool-output field guard deterministically, never consulting the selector", async () => {
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "lookup" }));
    const dispatch = vi.fn(async () => ({ status: "completed" as const, outputs: { is_final_sale: true } }));
    const runner = new DefaultRoutineRunner([eligibility()], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: atAsk() });

    // Selector ran once to land on the skill step; the eligibility branch was decided in code.
    expect(select).toHaveBeenCalledTimes(1);
    expect(result.response.answer).toContain("explain");
    expect(result.nextState).toBeNull();
  });

  it("takes the default edge when the field guard is false — still no selector for the branch", async () => {
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "lookup" }));
    const dispatch = vi.fn(async () => ({ status: "completed" as const, outputs: { is_final_sale: false } }));
    const runner = new DefaultRoutineRunner([eligibility()], { select }, { render: vi.fn(echoRenderer.render) }, { dispatch });

    const result = await runner.resume({ turn, state: atAsk() });

    expect(select).toHaveBeenCalledTimes(1);
    expect(result.response.answer).toContain("refund");
  });

  it("branches on a captured slot via `in` membership without a tool step", async () => {
    const tierRoutine: Routine = {
      id: "tier",
      rootStepId: "check",
      steps: [
        { id: "check", kind: "chat", action: "Check tier." },
        { id: "priority", kind: "terminal", action: "Priority queue." },
        { id: "standard", kind: "terminal", action: "Standard queue." },
      ],
      transitions: [
        { from: "check", to: "priority", condition: "premium tier", guard: { kind: "field", ref: "tier", op: "in", values: ["gold", "platinum"] } },
        { from: "check", to: "standard", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "check" }));
    const runner = new DefaultRoutineRunner([tierRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "tier", path: ["check"], variables: { tier: "platinum" }, status: "active" },
    });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("priority");
    expect(result.nextState).toBeNull();
  });

  // A relative-date comparison ("older than 6 months") decided in code against an
  // injected clock — the date math the model gets wrong, done deterministically.
  const dateEligibility = (): Routine => ({
    id: "refund",
    rootStepId: "check",
    steps: [
      { id: "check", kind: "chat", action: "Check the order." },
      { id: "explain", kind: "terminal", action: "Explain the policy." },
      { id: "refund", kind: "terminal", action: "Issue the refund." },
    ],
    transitions: [
      { from: "check", to: "explain", condition: "older than 6 months", guard: { kind: "field", ref: "order_date", op: "older_than", value: 6, unit: "months" } },
      { from: "check", to: "refund", condition: "default", guard: { kind: "default" } },
    ],
  });
  const fixedNow = () => new Date("2026-06-14T00:00:00.000Z");
  const atCheck = (variables: Record<string, unknown>): RoutineState => ({
    sessionId: "session_1", routineId: "refund", path: ["check"], variables, status: "active",
  });

  it("takes the older_than branch for a date more than 6 months before now", async () => {
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "check" }));
    const runner = new DefaultRoutineRunner([dateEligibility()], { select }, { render: vi.fn(echoRenderer.render) }, undefined, fixedNow);

    const result = await runner.resume({ turn, state: atCheck({ order_date: "2025-10-01" }) });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("explain");
  });

  it("falls through for a recent date (not older than 6 months)", async () => {
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "check" }));
    const runner = new DefaultRoutineRunner([dateEligibility()], { select }, { render: vi.fn(echoRenderer.render) }, undefined, fixedNow);

    const result = await runner.resume({ turn, state: atCheck({ order_date: "2026-05-01" }) });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("refund");
  });

  it("branches on a numeric greater-than comparison", async () => {
    const numericRoutine: Routine = {
      id: "budget",
      rootStepId: "check",
      steps: [
        { id: "check", kind: "chat", action: "Check budget." },
        { id: "high", kind: "terminal", action: "High tier." },
        { id: "low", kind: "terminal", action: "Low tier." },
      ],
      transitions: [
        { from: "check", to: "high", condition: "over 5000", guard: { kind: "field", ref: "budget", op: "gt", value: 5000 } },
        { from: "check", to: "low", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "check" }));
    const runner = new DefaultRoutineRunner([numericRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "budget", path: ["check"], variables: { budget: 7500 }, status: "active" },
    });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("high");
  });
});

describe("DefaultRoutineRunner trace", () => {
  const slotRoutine: Routine = {
    id: "contact",
    rootStepId: "ask_email",
    slots: [
      { id: "slot_email", key: "email", type: "email", required: true },
      { id: "slot_message", key: "message", type: "text", required: true },
    ],
    steps: [
      { id: "ask_email", kind: "chat", action: "Ask for {{slot.email}}.", metadata: { collectsSlots: ["email"] } },
      { id: "ask_message", kind: "chat", action: "Ask for {{slot.message}}.", metadata: { collectsSlots: ["message"] } },
      { id: "done", kind: "terminal", action: "Confirm sent." },
    ],
    transitions: [
      { from: "ask_email", to: "ask_message", condition: "The user provided {{slot.email}}." },
      { from: "ask_message", to: "done", condition: "The user provided {{slot.message}}." },
    ],
  };

  it("records the resumed step, the advance, captured slot keys, and the rendered step", async () => {
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message", variables: { email: "a@b.c" } })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.trace).toMatchObject({
      routineId: "contact",
      startStepId: "ask_email",
      landedStepId: "ask_message",
      capturedSlotKeys: ["email"],
      filledSlotKeys: ["email"],
    });
    expect(result.trace?.steps).toEqual([
      { stepId: "ask_email", kind: "chat", event: "advanced", capturedSlotKeys: ["email"], viaSelector: true },
      { stepId: "ask_message", kind: "chat", event: "rendered" },
    ]);
  });

  it("records a re-ask (no advance) and carries no slot value, only the key", async () => {
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.trace?.landedStepId).toBe("ask_email");
    // A re-ask renders the very step it stayed on — listed once, not duplicated as a
    // separate "rendered" entry.
    expect(result.trace?.steps).toEqual([
      { stepId: "ask_email", kind: "chat", event: "reasked", viaSelector: true },
    ]);
    // The trace never carries the captured value, only declared keys.
    expect(JSON.stringify(result.trace)).not.toContain("a@b.c");
  });

  it("records fast-forwarding over a satisfied downstream slot-collection step", async () => {
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      // Selector advances off ask_email; both slots are already filled, so the landed
      // ask_message step is satisfied and fast-forwards to the terminal.
      { select: vi.fn(async () => ({ nextStepId: "ask_message" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"], { email: "a@b.c", message: "hi" }) });

    const events = result.trace?.steps.map((entry) => `${entry.stepId}:${entry.event}`);
    expect(events).toContain("ask_message:fast_forwarded");
    expect(result.trace?.landedStepId).toBe("done");
    expect(result.trace?.filledSlotKeys).toEqual(expect.arrayContaining(["email", "message"]));
  });

  it("records a skill dispatch with its name and status", async () => {
    const skillRoutine: Routine = {
      id: "contact",
      rootStepId: "ask_email",
      steps: [
        { id: "ask_email", kind: "chat", action: "Ask for email." },
        { id: "lookup", kind: "skill", skillName: "crm_lookup" },
        { id: "done", kind: "terminal", action: "Done." },
      ],
      transitions: [
        { from: "ask_email", to: "lookup", condition: "email provided" },
        { from: "lookup", to: "done", condition: "default", guard: { kind: "default" } },
      ],
    };
    const runner = new DefaultRoutineRunner(
      [skillRoutine],
      { select: vi.fn(async () => ({ nextStepId: "lookup" })) },
      { render: vi.fn(echoRenderer.render) },
      { dispatch: vi.fn(async () => ({ status: "ok" as const, outputs: { found: true } })) },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    const skillEntry = result.trace?.steps.find((entry) => entry.event === "skill_dispatched");
    expect(skillEntry).toMatchObject({ stepId: "lookup", kind: "skill", skillName: "crm_lookup", skillStatus: "ok" });
  });

  it("extracts the slot on a step that branches on it deterministically (no llm edge)", async () => {
    // "Ask for budget, then branch on budget in code." The step collects a slot but its
    // only edges are a field guard + a default — no llm edge. The selector must still run
    // to capture the slot, and the field guard must then see the freshly-captured value.
    const branchRoutine: Routine = {
      id: "budget",
      rootStepId: "ask_budget",
      slots: [{ id: "slot_budget", key: "budget", type: "number", required: true }],
      steps: [
        { id: "ask_budget", kind: "chat", action: "Ask for {{slot.budget}}.", metadata: { collectsSlots: ["budget"] } },
        { id: "premium", kind: "terminal", action: "Premium." },
        { id: "standard", kind: "terminal", action: "Standard." },
      ],
      transitions: [
        { from: "ask_budget", to: "premium", condition: "budget is at least 1000", guard: { kind: "field", ref: "budget", op: "gte", value: 1000 } },
        { from: "ask_budget", to: "standard", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn(async () => ({ nextStepId: "ask_budget", variables: { budget: 5000 } }));
    const runner = new DefaultRoutineRunner([branchRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "budget", path: ["ask_budget"], variables: {}, status: "active" },
    });

    expect(select).toHaveBeenCalledTimes(1); // the selector ran for extraction
    expect(result.nextState).toBeNull(); // reached the premium terminal
    expect(result.response.answer).toContain("premium");
    expect(result.trace?.capturedSlotKeys).toEqual(["budget"]);
    expect(result.trace?.filledSlotKeys).toEqual(["budget"]);
  });

  it("does NOT run the extraction selector on an already-satisfied deterministic-branch step", async () => {
    // Same shape, but the slot is already filled (the satisfied/fast-forward case).
    // Extraction would be a wasted model round-trip and could overwrite the value or
    // yield — so it must be skipped and the field guard decides in code, model-free.
    const branchRoutine: Routine = {
      id: "budget",
      rootStepId: "ask_budget",
      slots: [{ id: "slot_budget", key: "budget", type: "number", required: true }],
      steps: [
        { id: "ask_budget", kind: "chat", action: "Ask for {{slot.budget}}.", metadata: { collectsSlots: ["budget"] } },
        { id: "premium", kind: "terminal", action: "Premium." },
        { id: "standard", kind: "terminal", action: "Standard." },
      ],
      transitions: [
        { from: "ask_budget", to: "premium", condition: "budget is at least 1000", guard: { kind: "field", ref: "budget", op: "gte", value: 1000 } },
        { from: "ask_budget", to: "standard", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn();
    const runner = new DefaultRoutineRunner([branchRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "budget", path: ["ask_budget"], variables: { budget: 5000 }, status: "active" },
    });

    expect(select).not.toHaveBeenCalled(); // already collected → no extraction round-trip
    expect(result.response.answer).toContain("premium"); // field guard still decided it
  });

  it("does not mislabel a cycle-broken step as fast-forwarded (renders it)", async () => {
    // Two satisfied slot steps whose edges form a loop (a→b→a). The fast-forward walk
    // skips `a`, lands on `b`, then would loop back to the visited `a` and breaks —
    // rendering `b`. `b` must read as rendered, not "Skipped", in the debug timeline.
    const cycleRoutine: Routine = {
      id: "loop",
      rootStepId: "start",
      slots: [
        { id: "sx", key: "x", type: "text", required: true },
        { id: "sy", key: "y", type: "text", required: true },
      ],
      steps: [
        { id: "start", kind: "chat", action: "start" },
        { id: "a", kind: "chat", action: "a", metadata: { collectsSlots: ["x"] } },
        { id: "b", kind: "chat", action: "b", metadata: { collectsSlots: ["y"] } },
      ],
      transitions: [
        { from: "start", to: "a", condition: "default", guard: { kind: "default" } },
        { from: "a", to: "b", condition: "default", guard: { kind: "default" } },
        { from: "b", to: "a", condition: "default", guard: { kind: "default" } },
      ],
    };
    const select = vi.fn();
    const runner = new DefaultRoutineRunner([cycleRoutine], { select }, { render: vi.fn(echoRenderer.render) });

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "loop", path: ["start"], variables: { x: "1", y: "2" }, status: "active" },
    });

    expect(result.trace?.landedStepId).toBe("b");
    const bEntries = result.trace?.steps.filter((entry) => entry.stepId === "b") ?? [];
    expect(bEntries).toEqual([{ stepId: "b", kind: "chat", event: "rendered" }]);
    expect(bEntries.some((entry) => entry.event === "fast_forwarded")).toBe(false);
  });

  it("omits the trace when the routine yields the turn", async () => {
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", yieldTurn: true })) },
      { render: vi.fn() },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.yielded).toBe(true);
    expect(result.trace).toBeUndefined();
  });
});
