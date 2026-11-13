import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace, RoutineState, RoutineTraceRejectedSlot } from "@radioso/conversation-contract";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { ChatRoutineTurnReporter } from "../../src/modules/chat/contracts/routineTurnState.js";
import { sensitiveMessageMarks, sensitiveSlotKeysForTurn } from "../../src/modules/chat/services/routines/sensitiveTurnMarker.js";

const parked: RoutineState = {
  sessionId: "conv_1",
  routineId: "booking",
  path: ["ask_name", "consent:health:ask_pregnancy"],
  variables: { name: "Ada" },
  status: "active",
};

// The routine holds no sensitive value and waits on a step that asks for none.
const reporter = (): ChatRoutineTurnReporter => ({
  describe: vi.fn(() => null),
  describeDeclined: vi.fn(() => null),
  describeInvocation: vi.fn(() => null),
  describeRoutineName: vi.fn(() => null),
  sensitiveSlotKeysHeld: vi.fn(() => []),
  sensitiveSlotKeysAwaited: vi.fn(() => []),
});

const routineTrace = (rejectedSlots: RoutineTraceRejectedSlot[]): ConversationTrace => ({
  traceId: "conversation-turn-1",
  startedAt: "2026-11-11T00:00:00.000Z",
  stages: [
    { id: "message", kind: "message", status: "applied" },
    {
      id: "routine:booking",
      kind: "routine_activate",
      status: "applied",
      outputs: { routineId: "booking" },
      subTrace: {
        namespace: "routine",
        version: 1,
        payload: {
          routineId: "booking",
          startStepId: "ask_name",
          landedStepId: "consent:health:ask_pregnancy",
          capturedSlotKeys: ["name"],
          filledSlotKeys: ["name"],
          steps: [{ stepId: "ask_name", kind: "chat", event: "advanced", capturedSlotKeys: ["name"], rejectedSlots }],
        },
      },
    },
  ],
});

describe("sensitiveSlotKeysForTurn", () => {
  it("marks a value the routine kept out for want of consent, as capturing it would have (#1544)", () => {
    const keys = sensitiveSlotKeysForTurn({
      routineStateTransition: { kind: "save", state: parked, startedFrom: { ...parked, path: [], variables: {} } },
      routineReporter: reporter(),
      engineTrace: routineTrace([{ key: "pregnancy", reason: "consent" }]),
    });

    expect(keys).toEqual(["pregnancy"]);
  });

  it("marks it when the routine ended on the same turn", () => {
    const keys = sensitiveSlotKeysForTurn({
      routineStateTransition: { kind: "clear", sessionId: "conv_1" },
      routineReporter: reporter(),
      engineTrace: routineTrace([{ key: "pregnancy", reason: "consent" }]),
    });

    expect(keys).toEqual(["pregnancy"]);
  });

  it("marks nothing for a value rejected for any other reason", () => {
    const keys = sensitiveSlotKeysForTurn({
      routineStateTransition: { kind: "save", state: parked },
      routineReporter: reporter(),
      engineTrace: routineTrace([{ key: "email", reason: "type_mismatch" }, { key: "nickname", reason: "undeclared" }]),
    });

    expect(keys).toEqual([]);
  });
});

describe("sensitiveMessageMarks", () => {
  const message = (id: string, role: "user" | "assistant", content: string): MessageRecord =>
    ({ id, conversationId: "conv_1", workspaceId: "ws_1", role, content, createdAt: new Date("2026-11-11T00:00:00.000Z") });
  // Asked before any routine ran, then the routine's own turns, which marked what they read.
  const history = [
    message("before-1", "user", "Can I join while PREGNANT  with twins?"),
    message("before-reply", "assistant", "Yes, we adapt the classes for pregnant with twins."),
    message("before-2", "user", "And the price?"),
    message("start", "user", "I want to book a class"),
    message("name", "user", "I'm Ada"),
    message("grant", "user", "Yes, I agree"),
  ];
  // The step filled `pregnancy` while it could read it from earlier messages.
  const filledFromEarlier = (variables: Record<string, unknown>): ConversationTrace => {
    const trace = routineTrace([]);
    return {
      ...trace,
      stages: trace.stages.map((stage) => (stage.subTrace
        ? { ...stage, subTrace: { ...stage.subTrace, payload: { ...stage.subTrace.payload as object, earlierMessageSlotKeys: Object.keys(variables) } } }
        : stage)),
    };
  };
  const marks = (input: { variables: Record<string, unknown>; visitorMessage?: string; startedMessageId?: string; earlier?: boolean }) =>
    sensitiveMessageMarks({
      session: { userMessage: { id: "current", content: input.visitorMessage ?? "Yes, that one" }, history },
      sensitiveSlotKeys: ["pregnancy"],
      routineStateTransition: {
        kind: "save",
        state: { ...parked, variables: { name: "Ada", ...input.variables }, startedMessageId: input.startedMessageId ?? "start" },
      },
      engineTrace: input.earlier === false ? routineTrace([]) : filledFromEarlier(input.variables),
    });

  it("marks the visitor's earlier messages that state the value the step took from them, never a reply", () => {
    expect(marks({ variables: { pregnancy: "pregnant with twins" } })).toEqual({
      visitorMessageId: "current",
      sensitiveVisitorMessage: { id: "current", sensitiveSlotKeys: ["pregnancy"] },
      sensitiveEarlierMessages: [{ id: "before-1", sensitiveSlotKeys: ["pregnancy"] }],
    });
  });

  it("marks no earlier message when the turn's own message states the value", () => {
    expect(marks({ variables: { pregnancy: "expecting a baby" }, visitorMessage: "I'm expecting a baby" })).not.toHaveProperty("sensitiveEarlierMessages");
  });

  it("marks every message read from before the routine started for a value it cannot search for", () => {
    expect(marks({ variables: { pregnancy: true } }).sensitiveEarlierMessages).toEqual([
      { id: "before-1", sensitiveSlotKeys: ["pregnancy"] },
      { id: "before-2", sensitiveSlotKeys: ["pregnancy"] },
    ]);
    // A run that started before what the turn read: its own turns marked every source.
    expect(marks({ variables: { pregnancy: true }, startedMessageId: "older" })).not.toHaveProperty("sensitiveEarlierMessages");
  });

  it("marks nothing earlier when the step filled the slot without the earlier-message rule", () => {
    expect(marks({ variables: { pregnancy: "pregnant with twins" }, earlier: false })).not.toHaveProperty("sensitiveEarlierMessages");
  });
});
