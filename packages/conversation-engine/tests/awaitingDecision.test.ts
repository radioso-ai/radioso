import { describe, expect, it, vi } from "vitest";

import { resumeAwaitingDecision } from "../src/awaitingDecision.js";
import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";

const refundRoutine: Routine = {
  id: "refund_flow",
  rootStepId: "ask_reason",
  steps: [
    { id: "ask_reason", kind: "chat", action: "Ask the customer why they want a refund." },
    {
      id: "gate",
      kind: "await",
      action: "Tell the customer their request is awaiting review.",
      decision: {
        captureKey: "approval_decision",
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
      },
      metadata: { reason: "refund_review" },
    },
    { id: "issue_refund", kind: "skill", skillName: "refund.issue" },
    { id: "confirmed", kind: "terminal", action: "Confirm the refund was issued.", metadata: { terminalKind: "complete" } },
    { id: "declined", kind: "terminal", action: "Explain the refund was declined.", metadata: { terminalKind: "complete" } },
  ],
  transitions: [
    { from: "ask_reason", to: "gate", condition: "a reason was provided", guard: { kind: "default" } },
    { from: "gate", to: "issue_refund", condition: "the request was approved", guard: { kind: "field", ref: "approval_decision.id", op: "equals", value: "approve" } },
    { from: "gate", to: "declined", condition: "the request was rejected", guard: { kind: "field", ref: "approval_decision.id", op: "equals", value: "reject" } },
    { from: "issue_refund", to: "confirmed", condition: "the refund was issued" },
  ],
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "resume_decision", kind: "message", content: "" },
  history: [],
  stagedContext: [],
  steering: [],
};

const suspendedAtGate: RoutineState = {
  sessionId: "session_1",
  routineId: "refund_flow",
  path: ["ask_reason", "gate"],
  variables: { reason: "item arrived damaged" },
  status: "suspended",
};

const renderer: ConversationRoutineStepRenderer = {
  render: vi.fn(async ({ step, steering }) => ({ answer: `[${step.id}] ${steering[0]?.action ?? ""}`, metadata: {} })),
};

const throwingSelector = (): ConversationRoutineNextStepSelector => ({
  select: vi.fn(async () => {
    throw new Error("SELECTOR_CALLED");
  }),
});

const readerFor = (state: RoutineState | null) => ({
  loadSuspended: vi.fn(async () => state),
});

describe("resumeAwaitingDecision", () => {
  it("APPROVE branches via the field guard, dispatches the gated skill exactly once, and never calls the selector", async () => {
    const selector = throwingSelector();
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const skillDispatcher: ConversationRoutineSkillDispatcher = { dispatch };
    const runner = new DefaultRoutineRunner([refundRoutine], selector, { render: vi.fn(renderer.render) }, skillDispatcher);

    const result = await resumeAwaitingDecision({
      suspendedReader: readerFor(suspendedAtGate),
      routineRunner: runner,
      turn,
      decision: { handle: "decision_1", optionId: "approve", payload: { reviewedBy: "operator_1" } },
    });

    expect(result.resumed).toBe(true);
    expect(selector.select).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ skillName: "refund.issue" }));
    expect(result.trace?.startStepId).toBe("gate");
    expect(result.trace?.steps.map((step) => step.stepId)).not.toContain("ask_reason");
    expect(result.terminal).toEqual({ kind: "complete", stepId: "confirmed" });
    expect(result.nextState).toBeNull();
    expect(result.response.answer).toContain("confirmed");
  });

  it("REJECT takes the rejection edge, never dispatches the gated skill, and never calls the selector", async () => {
    const selector = throwingSelector();
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner([refundRoutine], selector, { render: vi.fn(renderer.render) }, { dispatch });

    const result = await resumeAwaitingDecision({
      suspendedReader: readerFor(suspendedAtGate),
      routineRunner: runner,
      turn,
      decision: { handle: "decision_1", optionId: "reject" },
    });

    expect(result.resumed).toBe(true);
    expect(selector.select).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.terminal).toEqual({ kind: "complete", stepId: "declined" });
    expect(result.nextState).toBeNull();
    expect(result.response.answer).toContain("declined");
  });

  it("CONTROL calls the selector when the same gate uses llm decision edges", async () => {
    const llmGateRoutine: Routine = {
      ...refundRoutine,
      transitions: [
        { from: "ask_reason", to: "gate", condition: "a reason was provided", guard: { kind: "default" } },
        { from: "gate", to: "issue_refund", condition: "the operator approved", guard: { kind: "llm" } },
        { from: "gate", to: "declined", condition: "the operator rejected", guard: { kind: "llm" } },
        { from: "issue_refund", to: "confirmed", condition: "the refund was issued" },
      ],
    };
    const select = vi.fn(async () => ({ nextStepId: "declined" }));
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const runner = new DefaultRoutineRunner([llmGateRoutine], { select }, { render: vi.fn(renderer.render) }, { dispatch });

    const result = await resumeAwaitingDecision({
      suspendedReader: readerFor(suspendedAtGate),
      routineRunner: runner,
      turn,
      decision: { handle: "decision_1", optionId: "reject" },
    });

    expect(result.resumed).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("DefaultRoutineRunner await suspension", () => {
  it("returns awaitingDecision, renders the await reply, parks at the gate, and does not dispatch the gated skill", async () => {
    const selector = throwingSelector();
    const dispatch = vi.fn(async () => ({ status: "completed" as const }));
    const render = vi.fn(renderer.render);
    const runner = new DefaultRoutineRunner([refundRoutine], selector, { render }, { dispatch });

    const result = await runner.resume({
      turn,
      state: {
        sessionId: "session_1",
        routineId: "refund_flow",
        path: ["ask_reason"],
        variables: { reason: "item arrived damaged" },
        status: "active",
      },
    });

    expect(result.awaitingDecision).toEqual({
      stepId: "gate",
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
      captureKey: "approval_decision",
      reason: "refund_review",
    });
    expect(result.response.answer).toContain("awaiting review");
    expect(result.nextState).toEqual(expect.objectContaining({
      status: "suspended",
      path: ["ask_reason", "gate"],
    }));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "gate" }),
      steering: [expect.objectContaining({ action: "Tell the customer their request is awaiting review." })],
    }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(selector.select).not.toHaveBeenCalled();
  });
});
