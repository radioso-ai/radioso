import { describe, expect, it } from "vitest";

import type { ConversationTrace, RoutineTurnEffects } from "@radioso/conversation-contract";

import {
  landedRoutineStep,
  routineReplyDelivery,
  withRoutineReplyDelivery,
} from "../../src/modules/chat/services/routines/routineReplyDelivery.js";

const routineExecution = { routineId: "contact.request", executionId: "exec-1" };
const notifyAction = { type: "handoff.notify", payload: { reason: "routine_handoff" } };
const noEnding = { ownershipHandoff: null, actions: undefined };

describe("routineReplyDelivery", () => {
  it("streams a reply when the turn reports nothing but the next step", () => {
    expect(routineReplyDelivery({
      effects: { routineExecution },
      ending: noEnding,
      replyStreams: true,
    })).toBe("stream");
  });

  it("streams a reply when the turn's action and skill lists are empty", () => {
    expect(routineReplyDelivery({
      effects: { routineExecution, actions: [], skillsWithExternalEffects: [] },
      ending: { ownershipHandoff: null, actions: [] },
      replyStreams: true,
    })).toBe("stream");
  });

  it("delivers whole a reply that can only be generated whole", () => {
    expect(routineReplyDelivery({
      effects: {},
      ending: noEnding,
      replyStreams: false,
    })).toBe("whole");
  });

  const durableTurns: Array<{ name: string; effects: RoutineTurnEffects; ending?: Parameters<typeof routineReplyDelivery>[0]["ending"] }> = [
    {
      name: "an action this turn",
      effects: { routineExecution, actions: [{ type: "contact.send", payload: {} }] },
      ending: { ownershipHandoff: null, actions: [{ type: "contact.send", payload: {} }] },
    },
    { name: "a completion with no notice", effects: { routineExecution, terminalKind: "complete" } },
    {
      name: "a completion with an operator notice",
      effects: {
        routineExecution,
        terminalKind: "complete",
        operatorNotice: { routineId: "contact.request", stepId: "done", terminalKind: "complete" },
      },
      ending: { ownershipHandoff: null, actions: [notifyAction] },
    },
    {
      name: "a hand-off",
      effects: {
        routineExecution,
        terminalKind: "handoff",
        handoff: { routineId: "contact.request", stepId: "escalate", terminalKind: "handoff" },
      },
      ending: { ownershipHandoff: { reason: "routine_handoff", routineId: "contact.request", stepId: "escalate" }, actions: [notifyAction] },
    },
    {
      name: "a visitor stuck past the re-ask limit",
      effects: {
        routineExecution,
        terminalKind: "stuck",
        handoff: { routineId: "contact.request", stepId: "ask_email", terminalKind: "stuck" },
      },
      ending: { ownershipHandoff: { reason: "routine_stuck", routineId: "contact.request", stepId: "ask_email" }, actions: [notifyAction] },
    },
    {
      name: "an approval gate",
      effects: {
        routineExecution,
        awaitingDecision: {
          stepId: "approve",
          options: [{ id: "approve", label: "Approve" }],
          captureKey: "decision",
        },
      },
    },
    { name: "an operator notice the ending effects queue", effects: { routineExecution }, ending: { ownershipHandoff: null, actions: [notifyAction] } },
    // A skill acts the moment it runs (an email sent, a webhook called), before the turn is saved.
    { name: "a skill a skill step ran, landing on a next step", effects: { routineExecution, skillsWithExternalEffects: ["customer_email.send"] } },
  ];

  for (const { name, effects, ending } of durableTurns) {
    it(`delivers whole a reply on a turn that reports ${name}`, () => {
      expect(routineReplyDelivery({ effects, ending: ending ?? noEnding, replyStreams: true })).toBe("whole");
    });
  }
});

const routineTrace = (kind: "routine_activate" | "routine_resume"): ConversationTrace => ({
  traceId: "trace-1",
  startedAt: "2026-10-07T00:00:00.000Z",
  stages: [
    { id: "message", kind: "message", status: "applied", outputs: { contentLength: 5 } },
    {
      id: "routine:contact.request",
      kind,
      status: "applied",
      outputs: { routineId: "contact.request", completed: false, answerLength: 12 },
      subTrace: {
        namespace: "routine",
        version: 1,
        payload: {
          routineId: "contact.request",
          startStepId: "ask_email",
          landedStepId: "ask_message",
          capturedSlotKeys: ["email"],
          filledSlotKeys: ["email"],
        },
      },
    },
  ],
});

describe("withRoutineReplyDelivery", () => {
  it.each(["routine_activate", "routine_resume"] as const)("records how the reply was delivered on the %s stage only", (kind) => {
    const trace = withRoutineReplyDelivery(routineTrace(kind), "stream");

    expect(trace?.stages[1]?.outputs).toEqual({
      routineId: "contact.request",
      completed: false,
      answerLength: 12,
      replyDelivery: "stream",
    });
    expect(trace?.stages[0]?.outputs).toEqual({ contentLength: 5 });
  });

  it("leaves an absent trace absent", () => {
    expect(withRoutineReplyDelivery(undefined, "whole")).toBeUndefined();
  });
});

describe("landedRoutineStep", () => {
  it("names the routine and the step its reply was written for", () => {
    expect(landedRoutineStep(routineTrace("routine_resume"))).toEqual({
      routineId: "contact.request",
      stepId: "ask_message",
    });
  });

  it("names nothing when the trace has no routine stage", () => {
    expect(landedRoutineStep({ traceId: "t", startedAt: "2026-10-07T00:00:00.000Z", stages: [] })).toEqual({});
    expect(landedRoutineStep(undefined)).toEqual({});
  });
});
