import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineContextRenderer,
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

  describe("context variable references in a step instruction", () => {
    const pageRoutine: Routine = {
      id: "contact",
      rootStepId: "confirm_program",
      steps: [{
        id: "confirm_program",
        kind: "chat",
        action: "{{context.page_context}} If it is a program page, confirm it; otherwise ask which program {{slot.program}}.",
      }],
      transitions: [],
    };
    const stagedPage: TurnContext["stagedContext"][number] = {
      kind: "context_variable",
      id: "page_context",
      data: { kind: "page_context", pageUrl: "https://example.com/programs/yoga" },
    };
    const echoInstruction: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ steering }) => ({ answer: steering[0]?.action ?? "", metadata: {} })),
    };
    const contextRenderer: RoutineContextRenderer = {
      render: vi.fn(({ name, stagedContext }) => {
        const staged = stagedContext.find((entry) => entry.id === name);
        return staged ? `<page>${String((staged.data as { pageUrl: string }).pageUrl)}</page>` : null;
      }),
    };

    it("replaces the token with the context renderer's text and leaves slot tokens to slot interpolation", async () => {
      const runner = new DefaultRoutineRunner(
        [pageRoutine],
        { select: vi.fn(async () => ({ nextStepId: "confirm_program" })) },
        { render: vi.fn(echoInstruction.render) },
        undefined,
        { contextRenderer },
      );

      const result = await runner.resume({
        turn: { ...turn, stagedContext: [stagedPage] },
        state: state(["confirm_program"], { program: "Yoga" }),
      });

      expect(contextRenderer.render).toHaveBeenCalledWith({ name: "page_context", stagedContext: [stagedPage] });
      expect(result.response.answer).toBe(
        "<page>https://example.com/programs/yoga</page> If it is a program page, confirm it; otherwise ask which program Yoga.",
      );
    });

    it("replaces the token with an empty string when the renderer returns null", async () => {
      const runner = new DefaultRoutineRunner(
        [pageRoutine],
        { select: vi.fn(async () => ({ nextStepId: "confirm_program" })) },
        { render: vi.fn(echoInstruction.render) },
        undefined,
        { contextRenderer: { render: () => null } },
      );

      const result = await runner.resume({ turn, state: state(["confirm_program"]) });

      expect(result.response.answer).toBe(" If it is a program page, confirm it; otherwise ask which program .");
    });

    it("replaces the token with an empty string when no context renderer is configured", async () => {
      const runner = new DefaultRoutineRunner(
        [pageRoutine],
        { select: vi.fn(async () => ({ nextStepId: "confirm_program" })) },
        { render: vi.fn(echoInstruction.render) },
      );

      const result = await runner.resume({ turn: { ...turn, stagedContext: [stagedPage] }, state: state(["confirm_program"]) });

      expect(result.response.answer).not.toContain("{{context.page_context}}");
      expect(result.response.answer).toBe(" If it is a program page, confirm it; otherwise ask which program .");
    });

    it("resolves the token in an await step's instruction too", async () => {
      const awaitRoutine: Routine = {
        id: "contact",
        rootStepId: "approve",
        steps: [{
          id: "approve",
          kind: "await",
          action: "Confirm booking for {{context.page_context}}?",
          decision: { captureKey: "decision", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
        }],
        transitions: [],
      };
      const runner = new DefaultRoutineRunner(
        [awaitRoutine],
        { select: vi.fn(async () => ({ nextStepId: "approve" })) },
        { render: vi.fn(echoInstruction.render) },
        undefined,
        { contextRenderer },
      );

      const result = await runner.resume({ turn: { ...turn, stagedContext: [stagedPage] }, state: state([]) });

      expect(result.response.answer).toBe("Confirm booking for <page>https://example.com/programs/yoga</page>?");
    });
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

  it("carries the declared slot values on a handoff terminal, without undeclared variables", async () => {
    const bookingRoutine: Routine = {
      id: "booking",
      rootStepId: "ask_program",
      slots: [
        { id: "slot_program", key: "program", type: "text", required: true },
        { id: "slot_arrival", key: "arrival_date", type: "text", required: true },
        { id: "slot_guests", key: "guests", type: "number", required: false },
      ],
      steps: [
        { id: "ask_program", kind: "chat", action: "Ask which program." },
        { id: "handoff", kind: "terminal", action: "Hand off to the booking desk.", metadata: { terminalKind: "handoff" } },
      ],
      transitions: [{ from: "ask_program", to: "handoff", condition: "program known" }],
    };
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "handoff", variables: { arrival_date: "2026-10-12" } })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({
      turn,
      state: {
        ...state(["ask_program"], { program: "Yoga retreat", scratch: "not a slot" }),
        routineId: bookingRoutine.id,
      },
    });

    expect(result.nextState).toBeNull();
    expect(result.terminal).toEqual({
      kind: "handoff",
      stepId: "handoff",
      collected: { program: "Yoga retreat", arrival_date: "2026-10-12" },
    });
  });

  it("carries the declared slot values on a complete terminal too", async () => {
    const slotRoutine: Routine = {
      ...routine,
      slots: [{ id: "slot_email", key: "email", type: "email", required: true }],
    };
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "done" })) },
      { render: vi.fn(echoRenderer.render) },
    );

    const result = await runner.resume({
      turn,
      state: state(["ask_email", "ask_message"], { email: "a@b.c", message: "hi" }),
    });

    expect(result.terminal).toEqual({ kind: "complete", stepId: "done", collected: { email: "a@b.c" } });
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
    expect(render.mock.calls[0][0].step.id).toBe("ask_email");
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
    expect(render.mock.calls[0][0].step.id).toBe("ask_name");
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
    expect(["step_ask", "step_ack"]).toContain(render.mock.calls[0][0].step.id);
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
    expect(second.terminal).toEqual({ kind: "handoff", stepId: "handoff", collected: {} });
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
    expect(result.terminal).toEqual({ kind: "handoff", stepId: "handoff", collected: {} });
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

  describe("a held selector decision (#1375)", () => {
    const heldRoutine = (transitions: Routine["transitions"]): Routine => ({
      id: "held",
      rootStepId: "ask_email",
      slots: [{ id: "s_email", key: "email", type: "email", required: true }],
      steps: [
        { id: "ask_email", kind: "chat", action: "Ask for email.", metadata: { collectsSlots: ["email"] } },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
      transitions,
    });
    const held = {
      nextStepId: "ask_email",
      variables: { email: "x@y.z" },
      hold: true,
      selection: { outcome: "authority_claim" as const, returnedSlotKeys: ["email"] },
    };
    const resumeHeld = async (transitions: Routine["transitions"], decision: typeof held = held) => {
      const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => decision);
      const runner = new DefaultRoutineRunner([heldRoutine(transitions)], { select }, { render: vi.fn(echoRenderer.render) });
      const result = await runner.resume({
        turn,
        state: { sessionId: "session_1", routineId: "held", path: ["ask_email"], variables: {}, status: "active" },
      });
      return { select, result };
    };
    const expectAskedAgainWithValueKept = (result: Awaited<ReturnType<typeof resumeHeld>>["result"]) => {
      expect(result.terminal).toBeUndefined();
      expect(result.response.answer).toContain("[ask_email]");
      expect(result.nextState).toMatchObject({ path: ["ask_email"], variables: { email: "x@y.z" }, status: "active" });
      // Filling the step's empty slot is progress, so this held turn is not counted as a re-ask.
      expect(result.nextState?.reaskCount ?? 0).toBe(0);
      expect(result.trace?.steps).toEqual([
        expect.objectContaining({ stepId: "ask_email", event: "reasked", capturedSlotKeys: ["email"], selection: held.selection }),
      ]);
    };

    it("takes no slot_filled exit, even though the held turn filled the slot", async () => {
      const { select, result } = await resumeHeld([
        { from: "ask_email", to: "done", condition: "", guard: { kind: "slot_filled", slots: ["email"] } },
      ]);

      expect(select).toHaveBeenCalledTimes(1);
      expectAskedAgainWithValueKept(result);
    });

    it("takes no default exit", async () => {
      const { select, result } = await resumeHeld([
        { from: "ask_email", to: "done", condition: "", guard: { kind: "default" } },
      ]);

      expect(select).toHaveBeenCalledTimes(1);
      expectAskedAgainWithValueKept(result);
    });

    it("takes neither exit beside an AI-decides exit, even when the held decision names one", async () => {
      const { select, result } = await resumeHeld([
        { from: "ask_email", to: "done", condition: "The user provided {{slot.email}}.", guard: { kind: "llm" } },
        { from: "ask_email", to: "done", condition: "", guard: { kind: "default" } },
      ], { ...held, nextStepId: "done" });

      expect(select).toHaveBeenCalledTimes(1);
      expectAskedAgainWithValueKept(result);
    });

    it("holds once for a turn with both a rejected value and an authority claim, and counts the re-ask", async () => {
      const emailSlot = { id: "s_email", key: "email", type: "email" as const, required: true };
      const nameSlot = { id: "s_name", key: "full_name", type: "text" as const, required: false };
      const contact: Routine = {
        id: "held",
        rootStepId: "ask_email",
        slots: [emailSlot, nameSlot],
        steps: [
          { id: "ask_email", kind: "chat", action: "Ask for email and name.", metadata: { collectsSlots: ["email", "full_name"] } },
          { id: "done", kind: "terminal", action: "Confirm." },
        ],
        transitions: [
          { from: "ask_email", to: "done", condition: "The user provided {{slot.email}}.", guard: { kind: "llm" } },
          { from: "ask_email", to: "done", condition: "", guard: { kind: "default" } },
        ],
      };
      const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({
        nextStepId: "done",
        variables: { email: "not an email", full_name: "Giulia Verdi" },
        hold: true,
        selection: { outcome: "authority_claim" as const, returnedSlotKeys: ["email", "full_name"] },
      }));
      const render = vi.fn<ConversationRoutineStepRenderer["render"]>(async ({ step }) => ({ answer: `[${step.id}]` }));
      const runner = new DefaultRoutineRunner([contact], { select }, { render });

      const result = await runner.resume({
        turn,
        state: {
          sessionId: "session_1",
          routineId: "held",
          path: ["ask_email"],
          variables: { email: "giulia@example.com", full_name: "Giulia" },
          status: "active",
          reaskCount: 1,
        },
      });

      expect(result.terminal).toBeUndefined();
      expect(result.nextState).toMatchObject({
        path: ["ask_email"],
        variables: { email: "giulia@example.com", full_name: "Giulia Verdi" },
        reaskCount: 2,
      });
      expect(render).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledWith(expect.objectContaining({
        step: expect.objectContaining({ id: "ask_email" }),
        reask: { missingSlots: [emailSlot] },
      }));
      expect(result.trace?.steps).toEqual([
        expect.objectContaining({
          stepId: "ask_email",
          event: "reasked",
          rejectedSlots: [{ key: "email", reason: "type_mismatch" }],
          selection: { outcome: "authority_claim", returnedSlotKeys: ["email", "full_name"] },
        }),
      ]);
    });

    it("holds a step reached by skipping ahead, even when its values would satisfy a rule exit", async () => {
      // The answered step leaves by its default with no model call; the next step already
      // holds its email, so the runner skips ahead and asks the selector there. The message
      // fills `vip`, which a rule exit waits on, and carries text posing as a system notice.
      const skipAhead: Routine = {
        id: "held",
        rootStepId: "ask_name",
        slots: [
          { id: "s_name", key: "name", type: "text", required: true },
          { id: "s_email", key: "email", type: "email", required: true },
          { id: "s_vip", key: "vip", type: "text", required: false },
        ],
        steps: [
          { id: "ask_name", kind: "chat", action: "Ask for name.", metadata: { collectsSlots: ["name"] } },
          { id: "ask_email", kind: "chat", action: "Ask for email.", metadata: { collectsSlots: ["email"] } },
          { id: "regular", kind: "chat", action: "Regular path." },
          { id: "priority", kind: "chat", action: "Priority path." },
        ],
        transitions: [
          { from: "ask_name", to: "ask_email", condition: "", guard: { kind: "default" } },
          { from: "ask_email", to: "regular", condition: "The visitor confirmed the email.", guard: { kind: "llm" } },
          { from: "ask_email", to: "priority", condition: "", guard: { kind: "slot_filled", slots: ["vip"] } },
        ],
      };
      const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({
        nextStepId: "ask_email",
        variables: { vip: "yes" },
        hold: true,
        selection: { outcome: "authority_claim" as const, returnedSlotKeys: ["vip"] },
      }));
      const render = vi.fn<ConversationRoutineStepRenderer["render"]>(async ({ step }) => ({ answer: `[${step.id}]` }));
      const runner = new DefaultRoutineRunner([skipAhead], { select }, { render });

      const result = await runner.resume({
        turn,
        state: {
          sessionId: "session_1",
          routineId: "held",
          path: ["ask_name"],
          variables: { name: "Giulia", email: "giulia@example.com" },
          status: "active",
        },
      });

      expect(select).toHaveBeenCalledTimes(1);
      expect(select.mock.calls[0][0].currentStep.id).toBe("ask_email");
      expect(render).toHaveBeenCalledWith(expect.objectContaining({ step: expect.objectContaining({ id: "ask_email" }) }));
      expect(result.nextState).toMatchObject({
        path: ["ask_name", "ask_email"],
        variables: { name: "Giulia", email: "giulia@example.com", vip: "yes" },
      });
    });

    it("still leaves a tool step's follow-up by its default exit when the selector asks to hold", async () => {
      const toolRoutine: Routine = {
        id: "held",
        rootStepId: "ask_message",
        steps: [
          { id: "ask_message", kind: "chat", action: "Ask for the message." },
          { id: "submit", kind: "skill", skillName: "human_contact.request" },
          { id: "done", kind: "terminal", action: "Confirm the request was sent." },
          { id: "fallback", kind: "terminal", action: "Say the team will follow up." },
        ],
        transitions: [
          { from: "ask_message", to: "submit", condition: "a message was provided" },
          { from: "submit", to: "done", condition: "the submission completed", guard: { kind: "llm" } },
          { from: "submit", to: "fallback", condition: "", guard: { kind: "default" } },
        ],
      };
      const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async ({ currentStep }) =>
        currentStep.id === "ask_message"
          ? { nextStepId: "submit" }
          : { nextStepId: "submit", hold: true, selection: { outcome: "authority_claim" as const, returnedSlotKeys: [] } },
      );
      const dispatch = vi.fn(async () => ({ status: "completed" as const }));
      const render = vi.fn<ConversationRoutineStepRenderer["render"]>(async ({ step }) => ({ answer: `[${step.id}]` }));
      const runner = new DefaultRoutineRunner([toolRoutine], { select }, { render }, { dispatch });

      const result = await runner.resume({
        turn,
        state: { sessionId: "session_1", routineId: "held", path: ["ask_message"], variables: {}, status: "active" },
      });

      expect(select).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.terminal).toMatchObject({ stepId: "fallback" });
    });
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
    const runner = new DefaultRoutineRunner([dateEligibility()], { select }, { render: vi.fn(echoRenderer.render) }, undefined, { clock: fixedNow });

    const result = await runner.resume({ turn, state: atCheck({ order_date: "2025-10-01" }) });

    expect(select).not.toHaveBeenCalled();
    expect(result.response.answer).toContain("explain");
  });

  it("falls through for a recent date (not older than 6 months)", async () => {
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>(async () => ({ nextStepId: "check" }));
    const runner = new DefaultRoutineRunner([dateEligibility()], { select }, { render: vi.fn(echoRenderer.render) }, undefined, { clock: fixedNow });

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
    // A default construction never includes slot values — only a runner built with
    // `includeSlotValues: true` does (see the describe block below).
    expect(result.trace).not.toHaveProperty("slotValues");
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

  it("carries the host-private failure reason of a failed skill dispatch onto the trace step", async () => {
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
      {
        dispatch: vi.fn(async () => ({
          status: "failed" as const,
          outputs: { skill: "crm_lookup", reason: "mcp_timeout" },
          metadata: { failureReason: "mcp_timeout" },
        })),
      },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    const skillEntry = result.trace?.steps.find((entry) => entry.event === "skill_dispatched");
    expect(skillEntry).toMatchObject({ stepId: "lookup", skillName: "crm_lookup", skillStatus: "failed", skillReason: "mcp_timeout" });
  });

  it("omits skillReason when the dispatch result carries no host-private failure reason", async () => {
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
    expect(skillEntry).not.toHaveProperty("skillReason");
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

describe("DefaultRoutineRunner includeSlotValues", () => {
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

  it("carries each filled slot's value, self-described by its declared type, in declared order, only when the construction opts in", async () => {
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message" })) },
      { render: vi.fn(echoRenderer.render) },
      undefined,
      { includeSlotValues: true },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"], { email: "a@b.c", message: "hi" }) });

    expect(result.trace?.slotValues).toEqual([
      { key: "email", type: "email", value: "a@b.c" },
      { key: "message", type: "text", value: "hi" },
    ]);
    expect(result.trace?.omittedSlotCount).toBeUndefined();
  });

  it("carries an empty slotValues array before any slot is filled, when the construction opts in", async () => {
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email" })) },
      { render: vi.fn(echoRenderer.render) },
      undefined,
      { includeSlotValues: true },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.trace?.slotValues).toEqual([]);
  });

  it("caps an oversized value and marks the entry truncated", async () => {
    const longValue = "x".repeat(600);
    const runner = new DefaultRoutineRunner(
      [slotRoutine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message" })) },
      { render: vi.fn(echoRenderer.render) },
      undefined,
      { includeSlotValues: true },
    );

    const result = await runner.resume({ turn, state: state(["ask_email"], { email: longValue }) });

    const emailValue = result.trace?.slotValues?.find((entry) => entry.key === "email");
    expect(emailValue?.truncated).toBe(true);
    expect(emailValue?.value).toHaveLength(500); // 499 chars + the ellipsis
    expect(typeof emailValue?.value === "string" && emailValue.value.endsWith("…")).toBe(true);
  });

  it("caps the number of traced slot values and reports how many filled slots were omitted", async () => {
    const manySlotsRoutine: Routine = {
      id: "many-slots",
      rootStepId: "ask",
      slots: Array.from({ length: 55 }, (_, index) => ({
        id: `slot_${index}`,
        key: `field_${index}`,
        type: "text" as const,
        required: false,
      })),
      steps: [
        { id: "ask", kind: "chat", action: "Ask." },
        { id: "done", kind: "terminal", action: "Done." },
      ],
      transitions: [{ from: "ask", to: "done", condition: "always", guard: { kind: "default" } }],
    };
    const filledVariables = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [`field_${index}`, `value_${index}`]),
    );
    const runner = new DefaultRoutineRunner(
      [manySlotsRoutine],
      { select: vi.fn() },
      { render: vi.fn(echoRenderer.render) },
      undefined,
      { includeSlotValues: true },
    );

    const result = await runner.resume({
      turn,
      state: { sessionId: "session_1", routineId: "many-slots", path: [], variables: filledVariables, status: "active" },
      activationTurn: true,
    });

    expect(result.trace?.slotValues).toHaveLength(50);
    expect(result.trace?.omittedSlotCount).toBe(5);
  });
});

describe("DefaultRoutineRunner re-ask signal and selector trace (#1369, #1370)", () => {
  const bookingRoutine: Routine = {
    id: "contact",
    rootStepId: "program",
    slots: [
      { id: "slot_program", key: "program", type: "text", required: true, description: "The program they want to attend." },
      { id: "slot_arrival", key: "arrival", type: "date", required: true },
      { id: "slot_departure", key: "departure", type: "date", required: true },
    ],
    steps: [
      { id: "program", kind: "chat", action: "Name the program and ask them to confirm it.", metadata: { collectsSlots: ["program"] } },
      { id: "dates", kind: "chat", action: "Ask for {{slot.arrival}} and {{slot.departure}}.", metadata: { collectsSlots: ["arrival", "departure"] } },
      { id: "done", kind: "terminal", action: "Confirm the request was sent." },
    ],
    transitions: [
      { from: "program", to: "dates", condition: "The user provided {{slot.program}}." },
      { from: "dates", to: "done", condition: "The user provided {{slot.arrival}} and {{slot.departure}}." },
    ],
  };
  const stay = { outcome: "stay" as const, returnedSlotKeys: [] };
  // A fresh mock per test: wrapping the shared echo mock would share its call history.
  const freshRenderer = (): ConversationRoutineStepRenderer => ({
    render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]` })),
  });

  it("tells the renderer a step is re-asked and which of its slots are still missing", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "program", variables: {}, selection: stay })) },
      renderer,
    );

    await runner.resume({ turn, state: state(["program"]) });

    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "program" }),
      reask: { missingSlots: [bookingRoutine.slots![0]] },
    }));
  });

  it("lists only the step's slots that this turn left unfilled", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: { arrival: "2026-11-11" } })) },
      renderer,
    );

    await runner.resume({ turn, state: state(["program", "dates"], { program: "Retreat" }) });

    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      reask: { missingSlots: [bookingRoutine.slots![2]] },
    }));
  });

  it("does not signal a re-ask on the activation turn, where the step is asked for the first time", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "program", variables: {} })) },
      renderer,
    );

    await runner.resume({ turn, state: state(["program"]), activationTurn: true });

    expect(vi.mocked(renderer.render).mock.calls[0][0]).not.toHaveProperty("reask");
  });

  it("does not signal a re-ask when the turn advances to a new step", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: { program: "Retreat" } })) },
      renderer,
    );

    await runner.resume({ turn, state: state(["program"]) });

    expect(vi.mocked(renderer.render).mock.calls[0][0]).not.toHaveProperty("reask");
  });

  it("lists only required slots as missing on a re-ask", async () => {
    const withOptional: Routine = {
      ...bookingRoutine,
      slots: [...bookingRoutine.slots!, { id: "slot_phone", key: "phone", type: "text", required: false }],
      steps: bookingRoutine.steps.map((step) =>
        step.id === "program" ? { ...step, metadata: { collectsSlots: ["program", "phone"] } } : step,
      ),
    };
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [withOptional],
      { select: vi.fn(async () => ({ nextStepId: "program", variables: {} })) },
      renderer,
    );

    await runner.resume({ turn, state: state(["program"]) });

    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      reask: { missingSlots: [bookingRoutine.slots![0]] },
    }));
  });

  it("does not signal a re-ask when every required slot the step collects is already filled", async () => {
    // Two exits, so the fast-forward check has to ask the selector, which declines.
    const withCancel: Routine = {
      ...bookingRoutine,
      transitions: [...bookingRoutine.transitions, { from: "dates", to: "done", condition: "The user wants to stop." }],
    };
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [withCancel],
      // The selector declines both on the resumed step and on the fast-forward check.
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: {} })) },
      renderer,
    );

    await runner.resume({ turn, state: state(["program", "dates"], { program: "Retreat", arrival: "2026-11-11", departure: "2026-11-14" }) });

    expect(vi.mocked(renderer.render).mock.calls[0][0]).not.toHaveProperty("reask");
  });

  it("extracts from the activation message even when activation already filled the step's slot", async () => {
    const guarded: Routine = {
      ...bookingRoutine,
      transitions: [
        { from: "program", to: "dates", condition: "program filled", guard: { kind: "field", ref: "program", op: "is_present" } },
      ],
    };
    const select = vi.fn(async () => ({
      nextStepId: "program",
      variables: { arrival: "2026-11-11", departure: "2026-11-14" },
    }));
    const runner = new DefaultRoutineRunner([guarded], { select }, freshRenderer());

    const result = await runner.resume({ turn, state: state(["program"], { program: "Retreat" }), activationTurn: true });

    expect(select).toHaveBeenCalled();
    expect(result.nextState?.variables).toMatchObject({ arrival: "2026-11-11", departure: "2026-11-14" });
  });

  it("records what the selector's model returned on the step it judged", async () => {
    const selection = { outcome: "stay" as const, returnedSlotKeys: ["arrival", "departure"], undeclaredKeyCount: 1 };
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      {
        select: vi.fn(async () => ({
          nextStepId: "program",
          variables: { arrival: "2026-11-11", departure: "2026-11-14" },
          selection,
        })),
      },
      freshRenderer(),
    );

    const result = await runner.resume({ turn, state: state(["program"]) });

    expect(result.trace?.steps).toEqual([
      {
        stepId: "program",
        kind: "chat",
        event: "reasked",
        capturedSlotKeys: ["arrival", "departure"],
        viaSelector: true,
        selection,
      },
    ]);
  });

  it("records the extraction-only pass's selection on a step whose branch is decided in code", async () => {
    const guarded: Routine = {
      ...bookingRoutine,
      transitions: [
        { from: "program", to: "dates", condition: "program filled", guard: { kind: "field", ref: "program", op: "is_present" } },
      ],
    };
    const selection = { outcome: "stay" as const, returnedSlotKeys: [] };
    const runner = new DefaultRoutineRunner(
      [guarded],
      { select: vi.fn(async () => ({ nextStepId: "program", variables: {}, selection })) },
      freshRenderer(),
    );

    const result = await runner.resume({ turn, state: state(["program"]) });

    expect(result.trace?.steps[0]).toMatchObject({ stepId: "program", event: "reasked", viaSelector: true, selection });
  });
});

describe("DefaultRoutineRunner satisfied slot steps (#1371, #1372)", () => {
  const slots: Routine["slots"] = [
    { id: "slot_arrival", key: "arrival", type: "date", required: true },
    { id: "slot_departure", key: "departure", type: "date", required: true },
    { id: "slot_full_name", key: "full_name", type: "text", required: true },
    { id: "slot_phone", key: "phone", type: "text", required: false },
  ];
  const steps: Routine["steps"] = [
    { id: "dates", kind: "chat", action: "Ask for {{slot.arrival}} and {{slot.departure}}.", metadata: { collectsSlots: ["arrival", "departure"] } },
    { id: "contact", kind: "chat", action: "Ask for {{slot.full_name}} and, optionally, {{slot.phone}}.", metadata: { collectsSlots: ["full_name", "phone"] } },
    { id: "done", kind: "terminal", action: "Say the request was sent." },
    { id: "cancelled", kind: "terminal", action: "Say the request was cancelled." },
  ];
  const cancelExit = (from: string) => ({ from, to: "cancelled", condition: "The user wants to stop." });
  const bookingWith = (transitions: Routine["transitions"]): Routine => ({ id: "contact", rootStepId: "dates", slots, steps, transitions });
  // The visitor answers the dates step and also gives their name; no AI-decides exit holds.
  const answeredDatesAndName = { arrival: "2026-11-11", departure: "2026-11-14", full_name: "Giulia Verdi" };
  const stayingSelector = (variables: Record<string, unknown>) =>
    ({ select: vi.fn(async () => ({ nextStepId: "dates", variables })) }) satisfies ConversationRoutineNextStepSelector;
  const renderer = (): ConversationRoutineStepRenderer => ({
    render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]` })),
  });

  it("skips a step whose required slots are filled even when its optional slot is empty", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "slot_filled", slots: ["arrival", "departure"] } },
      cancelExit("dates"),
      { from: "contact", to: "done", condition: "", guard: { kind: "slot_filled", slots: ["full_name"] } },
      cancelExit("contact"),
    ]);
    const selector = stayingSelector(answeredDatesAndName);
    const runner = new DefaultRoutineRunner([booking], selector, renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[done]");
    expect(result.trace?.steps.map(({ stepId, event }) => `${stepId}:${event}`)).toEqual([
      "dates:advanced",
      "contact:fast_forwarded",
      "done:rendered",
    ]);
    expect(selector.select).toHaveBeenCalledTimes(1);
  });

  it("skips a step whose only exit is taken once its required slots are filled, optional slot empty", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "slot_filled", slots: ["arrival", "departure"] } },
      { from: "contact", to: "done", condition: "The user provided {{slot.full_name}}." },
    ]);
    const runner = new DefaultRoutineRunner([booking], stayingSelector(answeredDatesAndName), renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[done]");
  });

  it("treats a step as satisfied when its slot_filled exit passes, even with another required slot empty", async () => {
    const booking: Routine = {
      ...bookingWith([
        { from: "dates", to: "contact", condition: "", guard: { kind: "slot_filled", slots: ["arrival", "departure"] } },
        { from: "contact", to: "done", condition: "", guard: { kind: "slot_filled", slots: ["full_name"] } },
        cancelExit("contact"),
      ]),
      slots: slots.map((slot) => (slot.key === "phone" ? { ...slot, required: true } : slot)),
    };
    const runner = new DefaultRoutineRunner([booking], stayingSelector(answeredDatesAndName), renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[done]");
  });

  it("still asks a step that collects only optional slots until one is given", async () => {
    const optionalOnly: Routine = {
      id: "contact",
      rootStepId: "dates",
      slots: [...slots.slice(0, 2), { id: "slot_phone", key: "phone", type: "text", required: false }],
      steps: [
        steps[0],
        { id: "phone", kind: "chat", action: "Offer to take {{slot.phone}}.", metadata: { collectsSlots: ["phone"] } },
        steps[2],
      ],
      transitions: [
        { from: "dates", to: "phone", condition: "", guard: { kind: "slot_filled", slots: ["arrival", "departure"] } },
        { from: "phone", to: "done", condition: "", guard: { kind: "default" } },
      ],
    };
    const runner = new DefaultRoutineRunner(
      [optionalOnly],
      stayingSelector({ arrival: "2026-11-11", departure: "2026-11-14" }),
      renderer(),
    );

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[phone]");
  });

  it("advances along the default exit when the reply fills the step and no AI-decides exit holds", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "default" } },
      cancelExit("dates"),
      { from: "contact", to: "done", condition: "", guard: { kind: "default" } },
      cancelExit("contact"),
    ]);
    const selector = stayingSelector({ arrival: "2026-11-11", departure: "2026-11-14" });
    const runner = new DefaultRoutineRunner([booking], selector, renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[contact]");
    expect(result.trace?.steps[0]).toMatchObject({ stepId: "dates", event: "advanced" });
    expect(selector.select).toHaveBeenCalledTimes(1);
  });

  it("re-asks a step with a default exit while its required slots are still empty", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "default" } },
      cancelExit("dates"),
    ]);
    const runner = new DefaultRoutineRunner([booking], stayingSelector({ arrival: "2026-11-11" }), renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[dates]");
    expect(result.trace?.steps[0]).toMatchObject({ stepId: "dates", event: "reasked" });
  });

  it("skips a later filled step along its default exit without asking the selector again", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "default" } },
      cancelExit("dates"),
      { from: "contact", to: "done", condition: "", guard: { kind: "default" } },
      cancelExit("contact"),
    ]);
    const selector = stayingSelector(answeredDatesAndName);
    const runner = new DefaultRoutineRunner([booking], selector, renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[done]");
    expect(result.trace?.steps.map(({ stepId, event }) => `${stepId}:${event}`)).toEqual([
      "dates:advanced",
      "contact:fast_forwarded",
      "done:rendered",
    ]);
    expect(selector.select).toHaveBeenCalledTimes(1);
  });

  it("still takes a cancel exit the selector chose on the step the visitor answered", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "default" } },
      cancelExit("dates"),
      { from: "contact", to: "done", condition: "", guard: { kind: "default" } },
    ]);
    const runner = new DefaultRoutineRunner(
      [booking],
      { select: vi.fn(async () => ({ nextStepId: "cancelled", variables: answeredDatesAndName })) },
      renderer(),
    );

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[cancelled]");
  });

  it("asks the selector about a filled step whose exits are all AI-decides", async () => {
    const booking = bookingWith([
      { from: "dates", to: "contact", condition: "", guard: { kind: "slot_filled", slots: ["arrival", "departure"] } },
      { from: "contact", to: "done", condition: "The user provided {{slot.full_name}}." },
      cancelExit("contact"),
    ]);
    const select = vi.fn(async ({ currentStep }: { currentStep: { id: string } }) => ({
      nextStepId: currentStep.id === "contact" ? "done" : "dates",
      variables: currentStep.id === "dates" ? answeredDatesAndName : {},
    }));
    const runner = new DefaultRoutineRunner([booking], { select }, renderer());

    const result = await runner.resume({ turn, state: state(["dates"]) });

    expect(result.response.answer).toBe("[done]");
    // One extraction pass on the answered step, then the AI-decides judgement for `contact`.
    expect(select.mock.calls.map(([input]) => input.currentStep.id)).toEqual(["dates", "contact"]);
  });
});

describe("DefaultRoutineRunner slot values checked against their declared type (#1374)", () => {
  const emailSlot = { id: "slot_email", key: "email", type: "email" as const, required: true };
  const adultsSlot = { id: "slot_adults", key: "adults", type: "number" as const, required: true };
  const arrivalSlot = { id: "slot_arrival", key: "arrival", type: "date" as const, required: false };
  const booking: Routine = {
    id: "contact",
    rootStepId: "ask_email",
    slots: [emailSlot, adultsSlot, arrivalSlot],
    steps: [
      { id: "ask_email", kind: "chat", action: "Ask for {{slot.email}}.", metadata: { collectsSlots: ["email"] } },
      { id: "ask_adults", kind: "chat", action: "Ask for {{slot.adults}} and {{slot.arrival}}.", metadata: { collectsSlots: ["adults", "arrival"] } },
      { id: "done", kind: "terminal", action: "Confirm the request was sent." },
    ],
    transitions: [
      { from: "ask_email", to: "ask_adults", condition: "The user provided {{slot.email}}." },
      { from: "ask_adults", to: "done", condition: "The user provided {{slot.adults}}." },
    ],
  };
  const renderer = (): ConversationRoutineStepRenderer => ({
    render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]` })),
  });
  const choosing = (nextStepId: string, variables: Record<string, unknown>) =>
    ({ select: vi.fn(async () => ({ nextStepId, variables })) }) satisfies ConversationRoutineNextStepSelector;

  it("does not store a value that does not fit its slot type, and asks the step that collects it again", async () => {
    const render = renderer();
    const runner = new DefaultRoutineRunner([booking], choosing("ask_adults", { email: "<script>alert(1)</script>" }), render);

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.nextState?.path).toEqual(["ask_email"]);
    expect(result.nextState?.variables).toEqual({});
    expect(render.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_email" }),
      reask: { missingSlots: [emailSlot] },
    }));
    expect(result.trace?.steps[0]).toMatchObject({
      stepId: "ask_email",
      event: "reasked",
      rejectedSlots: [{ key: "email", reason: "type_mismatch" }],
    });
    expect(result.trace?.steps[0]).not.toHaveProperty("capturedSlotKeys");
    expect(JSON.stringify(result.trace)).not.toContain("script");
  });

  it("asks again for a slot the step already holds when this turn's new value for it is rejected", async () => {
    const render = renderer();
    const runner = new DefaultRoutineRunner([booking], choosing("ask_adults", { email: "not an email" }), render);

    const result = await runner.resume({ turn, state: state(["ask_email"], { email: "giulia@example.com" }) });

    expect(result.nextState?.path).toEqual(["ask_email"]);
    expect(result.nextState?.variables).toEqual({ email: "giulia@example.com" });
    expect(render.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_email" }),
      reask: { missingSlots: [emailSlot] },
    }));
  });

  it("stores a value coerced to its declared type", async () => {
    const runner = new DefaultRoutineRunner([booking], choosing("done", { adults: " 2 " }), renderer());

    const result = await runner.resume({ turn, state: state(["ask_email", "ask_adults"], { email: "giulia@example.com" }) });

    expect(result.terminal).toEqual({ kind: "complete", stepId: "done", collected: { email: "giulia@example.com", adults: 2 } });
  });

  it("drops a rejected value for another step's slot without holding the step the visitor answered", async () => {
    const runner = new DefaultRoutineRunner(
      [booking],
      choosing("ask_adults", { email: "giulia@example.com", arrival: "mid-November" }),
      renderer(),
    );

    const result = await runner.resume({ turn, state: state(["ask_email"]) });

    expect(result.nextState?.path).toEqual(["ask_email", "ask_adults"]);
    expect(result.nextState?.variables).toEqual({ email: "giulia@example.com" });
    expect(result.trace?.steps[0]).toMatchObject({
      stepId: "ask_email",
      event: "advanced",
      capturedSlotKeys: ["email"],
      rejectedSlots: [{ key: "arrival", reason: "type_mismatch" }],
    });
  });

  it("rejects an object for a number slot", async () => {
    const runner = new DefaultRoutineRunner([booking], choosing("done", { adults: { count: 2 } }), renderer());

    const result = await runner.resume({ turn, state: state(["ask_email", "ask_adults"], { email: "giulia@example.com" }) });

    expect(result.nextState?.path).toEqual(["ask_email", "ask_adults"]);
    expect(result.nextState?.variables).toEqual({ email: "giulia@example.com" });
    expect(result.trace?.steps[0]).toMatchObject({ rejectedSlots: [{ key: "adults", reason: "not_scalar" }] });
  });

  it("lets a step's rule exits decide from the checked value", async () => {
    const branching: Routine = {
      ...booking,
      steps: [...booking.steps, { id: "group", kind: "terminal", action: "Say a group booking needs a call." }],
      transitions: [
        { from: "ask_email", to: "ask_adults", condition: "The user provided {{slot.email}}." },
        { from: "ask_adults", to: "group", condition: "", guard: { kind: "field", ref: "adults", op: "gt", value: 3 } },
        { from: "ask_adults", to: "done", condition: "", guard: { kind: "default" } },
      ],
    };
    const branchOn = async (adults: unknown) =>
      new DefaultRoutineRunner([branching], choosing("ask_adults", { adults }), renderer())
        .resume({ turn, state: state(["ask_email", "ask_adults"], { email: "giulia@example.com" }) });

    expect((await branchOn("5")).terminal?.stepId).toBe("group");
    expect((await branchOn("five")).trace?.steps[0]).toMatchObject({ rejectedSlots: [{ key: "adults", reason: "type_mismatch" }] });
  });

  it("checks the values the activator extracted on the activation turn", async () => {
    const render = renderer();
    const runner = new DefaultRoutineRunner([booking], choosing("ask_email", {}), render);

    const result = await runner.resume({
      turn,
      state: state([], { email: "giulia at example", adults: "2" }),
      activationTurn: true,
    });

    expect(result.nextState?.variables).toEqual({ adults: 2 });
    expect(result.trace?.steps[0]).toMatchObject({
      stepId: "ask_email",
      rejectedSlots: [{ key: "email", reason: "type_mismatch" }],
    });
    expect(vi.mocked(render.render).mock.calls[0][0]).not.toHaveProperty("reask");
  });

  it("holds the first step on the activator's rejected value when the selector gives no replacement", async () => {
    const withDefault: Routine = {
      ...booking,
      transitions: [
        { from: "ask_email", to: "ask_adults", condition: "", guard: { kind: "default" } },
        { from: "ask_adults", to: "done", condition: "The user provided {{slot.adults}}." },
      ],
    };
    for (const routineUnderTest of [withDefault, booking]) {
      const render = renderer();
      const runner = new DefaultRoutineRunner([routineUnderTest], choosing("ask_adults", {}), render);

      const result = await runner.resume({
        turn,
        state: state([], { email: "giulia at example" }),
        activationTurn: true,
      });

      expect(result.response.answer).toBe("[ask_email]");
      expect(result.trace?.landedStepId).toBe("ask_email");
      expect(result.nextState?.variables).toEqual({});
      expect(result.trace?.steps[0]).toMatchObject({ rejectedSlots: [{ key: "email", reason: "type_mismatch" }] });
    }
  });

  it("moves on when the selector reads a valid value where the activator's was rejected", async () => {
    const withCancel: Routine = {
      ...booking,
      steps: [...booking.steps, { id: "cancelled", kind: "terminal", action: "Say the request was cancelled." }],
      transitions: [...booking.transitions, { from: "ask_email", to: "cancelled", condition: "The user wants to stop." }],
    };
    // Every exit is AI-decides, so the satisfied step is judged again on the way on.
    const select = vi.fn<ConversationRoutineNextStepSelector["select"]>()
      .mockResolvedValueOnce({ nextStepId: "ask_email", variables: { email: "giulia@example.com" } })
      .mockResolvedValueOnce({ nextStepId: "ask_adults", variables: {} });
    const runner = new DefaultRoutineRunner([withCancel], { select }, renderer());

    const result = await runner.resume({
      turn,
      state: state([], { email: "giulia at example" }),
      activationTurn: true,
    });

    expect(result.nextState?.path.at(-1)).toBe("ask_adults");
    expect(result.nextState?.variables).toEqual({ email: "giulia@example.com" });
    expect(result.trace?.steps[0]).toMatchObject({ rejectedSlots: [{ key: "email", reason: "type_mismatch" }] });
  });

  describe("holds the answered step whatever kind of exit would fire", () => {
    const withEmailExits = (transitions: Routine["transitions"]): Routine => ({
      ...booking,
      slots: [...booking.slots!, { id: "slot_name", key: "full_name", type: "text", required: false }],
      steps: booking.steps.map((step) =>
        step.id === "ask_email" ? { ...step, metadata: { collectsSlots: ["email", "full_name"] } } : step,
      ),
      transitions: [...transitions, { from: "ask_adults", to: "done", condition: "The user provided {{slot.adults}}." }],
    });
    const answer = async (routineUnderTest: Routine, variables: Record<string, unknown>) => {
      const select = vi.fn(async () => ({ nextStepId: "ask_email", variables }));
      const render = renderer();
      const result = await new DefaultRoutineRunner([routineUnderTest], { select }, render)
        .resume({ turn, state: state(["ask_email"]) });
      return { result, select, render };
    };
    const expectHeld = (result: Awaited<ReturnType<typeof answer>>["result"], render: ConversationRoutineStepRenderer) => {
      expect(result.nextState?.path).toEqual(["ask_email"]);
      expect(result.trace?.steps[0]).toMatchObject({
        stepId: "ask_email",
        event: "reasked",
        rejectedSlots: [{ key: "email", reason: "type_mismatch" }],
      });
      expect(render.render).toHaveBeenCalledWith(expect.objectContaining({
        step: expect.objectContaining({ id: "ask_email" }),
        reask: { missingSlots: [emailSlot] },
      }));
    };

    it("with a bare default exit", async () => {
      const { result, select, render } = await answer(
        withEmailExits([{ from: "ask_email", to: "ask_adults", condition: "", guard: { kind: "default" } }]),
        { email: "not an email" },
      );

      // The extraction-only pass read the message; its rejected value still holds the step.
      expect(select).toHaveBeenCalledTimes(1);
      expectHeld(result, render);
      expect(result.nextState?.reaskCount).toBe(1);
    });

    it("with a slot_filled exit and a default fallback", async () => {
      const { result, render } = await answer(
        withEmailExits([
          { from: "ask_email", to: "done", condition: "", guard: { kind: "slot_filled", slots: ["email"] } },
          { from: "ask_email", to: "ask_adults", condition: "", guard: { kind: "default" } },
        ]),
        { email: "not an email" },
      );

      expectHeld(result, render);
    });

    it("with a field exit and a default fallback, still storing the values that fit", async () => {
      const { result, render } = await answer(
        withEmailExits([
          { from: "ask_email", to: "done", condition: "", guard: { kind: "field", ref: "email", op: "is_present" } },
          { from: "ask_email", to: "ask_adults", condition: "", guard: { kind: "default" } },
        ]),
        { email: "not an email", full_name: "Giulia Verdi" },
      );

      expectHeld(result, render);
      expect(result.nextState?.variables).toEqual({ full_name: "Giulia Verdi" });
      // A newly filled collected slot is progress, so the re-ask count starts over.
      expect(result.nextState?.reaskCount ?? 0).toBe(0);
    });

    it("with a counter exit", async () => {
      const { result, render } = await answer(
        withEmailExits([
          { from: "ask_email", to: "ask_adults", condition: "", guard: { kind: "counter", limit: 5 } },
          { from: "ask_email", to: "done", condition: "", guard: { kind: "default" } },
        ]),
        { email: "not an email" },
      );

      expectHeld(result, render);
    });
  });

  it("leaves values the routine already holds alone on a later turn", async () => {
    const runner = new DefaultRoutineRunner([booking], choosing("ask_email", {}), renderer());

    const result = await runner.resume({ turn, state: state(["ask_email"], { adults: "two" }) });

    expect(result.nextState?.variables).toEqual({ adults: "two" });
  });
});

describe("DefaultRoutineRunner bounded re-asks (#1376)", () => {
  const nameSlot = { id: "slot_name", key: "full_name", type: "text" as const, required: true };
  const emailSlot = { id: "slot_email", key: "email", type: "email" as const, required: true };
  const steps: Routine["steps"] = [
    { id: "ask_contact", kind: "chat", action: "Ask for {{slot.full_name}} and {{slot.email}}.", metadata: { collectsSlots: ["full_name", "email"] } },
    { id: "ask_message", kind: "chat", action: "Ask what they need." },
    { id: "done", kind: "terminal", action: "Confirm the request was sent." },
    { id: "handoff", kind: "terminal", action: "Hand the visitor to a person.", metadata: { terminalKind: "handoff" } },
  ];
  const contactWith = (transitions: Routine["transitions"]): Routine => ({
    id: "contact",
    rootStepId: "ask_contact",
    slots: [nameSlot, emailSlot],
    steps,
    transitions,
  });
  const forward = { from: "ask_contact", to: "ask_message", condition: "The user provided {{slot.full_name}} and {{slot.email}}." };
  const toPerson = { from: "ask_contact", to: "handoff", condition: "The user asks to talk to a person." };
  const messageDone = { from: "ask_message", to: "done", condition: "The user said what they need." };
  const withHandoff = contactWith([forward, toPerson, messageDone]);
  const withoutHandoff = contactWith([forward, messageDone]);
  const renderer = (): ConversationRoutineStepRenderer => ({
    render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]` })),
  });
  const staying = (variables: Record<string, unknown> = {}) =>
    ({ select: vi.fn(async () => ({ nextStepId: "ask_contact", variables })) }) satisfies ConversationRoutineNextStepSelector;
  const onContactStep = (reaskCount?: number, variables: Record<string, unknown> = {}): RoutineState => ({
    ...state(["ask_contact"], variables),
    ...(reaskCount === undefined ? {} : { reaskCount }),
  });

  it("counts each re-ask of the same step that captures nothing new", async () => {
    const runner = new DefaultRoutineRunner([withHandoff], staying(), renderer());

    const first = await runner.resume({ turn, state: onContactStep() });
    const second = await runner.resume({ turn, state: first.nextState! });

    expect(first.nextState?.reaskCount).toBe(1);
    expect(second.nextState?.reaskCount).toBe(2);
  });

  it("starts the count again when the turn fills a slot the step collects", async () => {
    const runner = new DefaultRoutineRunner([withHandoff], staying({ full_name: "Giulia Verdi" }), renderer());

    const result = await runner.resume({ turn, state: onContactStep(3) });

    expect(result.nextState?.path).toEqual(["ask_contact"]);
    expect(result.nextState?.reaskCount ?? 0).toBe(0);
    expect(result.response.answer).toBe("[ask_contact]");
  });

  it("keeps counting when the turn only replaces a value the step already held", async () => {
    const optionalName = { ...contactWith([forward, toPerson, messageDone]), slots: [{ ...nameSlot, required: false }, emailSlot] };
    const runner = new DefaultRoutineRunner(
      [optionalName],
      staying({ email: "not an email", full_name: "Giulia Verdi" }),
      renderer(),
    );

    const result = await runner.resume({ turn, state: onContactStep(1, { full_name: "Giulia" }) });

    expect(result.nextState?.variables).toEqual({ full_name: "Giulia Verdi" });
    expect(result.nextState?.reaskCount).toBe(2);
  });

  it("starts the count again when the routine moves to another step", async () => {
    const runner = new DefaultRoutineRunner(
      [withHandoff],
      { select: vi.fn(async () => ({ nextStepId: "ask_message", variables: { full_name: "Giulia", email: "g@example.com" } })) },
      renderer(),
    );

    const result = await runner.resume({ turn, state: onContactStep(2) });

    expect(result.nextState?.path).toEqual(["ask_contact", "ask_message"]);
    expect(result.nextState?.reaskCount ?? 0).toBe(0);
  });

  it("does not count the activation turn, where the step is asked for the first time", async () => {
    const runner = new DefaultRoutineRunner([withHandoff], staying(), renderer());

    const result = await runner.resume({ turn, state: state([]), activationTurn: true });

    expect(result.nextState?.reaskCount ?? 0).toBe(0);
  });

  it("counts a re-ask whose value was rejected for not fitting its slot type", async () => {
    const runner = new DefaultRoutineRunner([withHandoff], staying({ email: "<script>alert(1)</script>" }), renderer());

    const result = await runner.resume({ turn, state: onContactStep(1) });

    expect(result.nextState?.reaskCount).toBe(2);
  });

  it("asks again as usual up to the limit", async () => {
    const render = renderer();
    const runner = new DefaultRoutineRunner([withHandoff], staying(), render);

    const result = await runner.resume({ turn, state: onContactStep(2) });

    expect(result.nextState?.reaskCount).toBe(3);
    expect(render.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_contact" }),
      reask: { missingSlots: [nameSlot, emailSlot] },
    }));
    expect(result.trace?.steps.map((entry) => entry.event)).not.toContain("reask_limit_reached");
  });

  it("asks differently past the limit, and keeps counting", async () => {
    const render = renderer();
    const runner = new DefaultRoutineRunner([withoutHandoff], staying(), render);

    const first = await runner.resume({ turn, state: onContactStep(3) });
    const second = await runner.resume({ turn, state: first.nextState! });

    expect(first.nextState?.reaskCount).toBe(4);
    expect(second.nextState?.reaskCount).toBe(5);
    for (const [call] of vi.mocked(render.render).mock.calls) {
      expect(call).toMatchObject({
        step: expect.objectContaining({ id: "ask_contact" }),
        reask: { missingSlots: [nameSlot, emailSlot], exhausted: true },
      });
    }
    expect(first.trace?.steps).toEqual([
      expect.objectContaining({ stepId: "ask_contact", event: "reasked" }),
      { stepId: "ask_contact", kind: "chat", event: "reask_limit_reached", reaskCount: 4 },
    ]);
  });

  it("never takes the step's own exit to a hand-off end: past the limit it only asks differently", async () => {
    // A direct exit to a hand-off end is often the step's confirmation edge ("the visitor
    // confirmed" → hand off the booking request); the limit must never fire it.
    const render = renderer();
    const select = vi.fn(async () => ({ nextStepId: "ask_contact", variables: {} }));
    const runner = new DefaultRoutineRunner([withHandoff], { select }, render);

    const result = await runner.resume({ turn, state: onContactStep(3) });

    expect(result.terminal).toBeUndefined();
    expect(result.nextState?.path).toEqual(["ask_contact"]);
    expect(result.nextState?.reaskCount).toBe(4);
    expect(result.response.answer).toBe("[ask_contact]");
    expect(render.render).toHaveBeenCalledTimes(1);
    expect(render.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "ask_contact" }),
      reask: { missingSlots: [nameSlot, emailSlot], exhausted: true },
    }));
    expect(result.trace).toMatchObject({ landedStepId: "ask_contact" });
    expect(result.trace?.steps).toContainEqual({ stepId: "ask_contact", kind: "chat", event: "reask_limit_reached", reaskCount: 4 });
  });

  it("never jumps to a hand-off end the step has no exit to", async () => {
    const viaSkill = contactWith([
      forward,
      { from: "ask_contact", to: "notify", condition: "The user asks to talk to a person." },
      { from: "notify", to: "handoff", condition: "" },
      messageDone,
    ]);
    const withSkill: Routine = { ...viaSkill, steps: [...steps, { id: "notify", kind: "skill", skillName: "notify_team" }] };
    const dispatch = vi.fn(async () => ({ status: "success" as const }));
    const render = renderer();
    const runner = new DefaultRoutineRunner([withSkill], staying(), render, { dispatch });

    const result = await runner.resume({ turn, state: onContactStep(3) });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.nextState?.path).toEqual(["ask_contact"]);
    expect(render.render).toHaveBeenCalledWith(expect.objectContaining({ reask: expect.objectContaining({ exhausted: true }) }));
  });

  it("takes its limit from the runner options", async () => {
    const render = renderer();
    const runner = new DefaultRoutineRunner([withoutHandoff], staying(), render, undefined, { reaskLimit: 1 });

    const result = await runner.resume({ turn, state: onContactStep(1) });

    expect(render.render).toHaveBeenCalledWith(expect.objectContaining({ reask: expect.objectContaining({ exhausted: true }) }));
    expect(result.nextState?.reaskCount).toBe(2);
  });

  it("drops the count when the routine suspends for a decision", async () => {
    const withApproval: Routine = {
      ...withoutHandoff,
      steps: [...steps, {
        id: "approve",
        kind: "await",
        action: "Ask a teammate to approve the request.",
        decision: { captureKey: "approval", options: [{ id: "approve", label: "Approve" }] },
      }],
      transitions: [{ ...forward, to: "approve" }, messageDone],
    };
    const runner = new DefaultRoutineRunner(
      [withApproval],
      { select: vi.fn(async () => ({ nextStepId: "approve", variables: { full_name: "Giulia", email: "g@example.com" } })) },
      renderer(),
    );

    const result = await runner.resume({ turn, state: onContactStep(3) });

    expect(result.nextState).toMatchObject({ status: "suspended", path: ["ask_contact", "approve"] });
    expect(result.nextState).not.toHaveProperty("reaskCount");
  });

  it("leaves the count where it was on a turn yielded to normal answering", async () => {
    const yielding = { select: vi.fn(async () => ({ nextStepId: "ask_contact", yieldTurn: true })) };
    const stored = onContactStep(2);
    const render = renderer();

    const yielded = await new DefaultRoutineRunner([withoutHandoff], yielding, render).resume({ turn, state: stored });

    expect(yielded).toMatchObject({ yielded: true, nextState: null });
    expect(render.render).not.toHaveBeenCalled();
    expect(stored.reaskCount).toBe(2);
    // The engine keeps the stored state on a yield, so the next unanswered turn counts on from it.
    const next = await new DefaultRoutineRunner([withoutHandoff], staying(), renderer()).resume({ turn, state: stored });
    expect(next.nextState?.reaskCount).toBe(3);
  });
});
