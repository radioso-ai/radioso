import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace, RoutineState, RoutineTraceRejectedSlot } from "@radioso/conversation-contract";

import type { ChatRoutineTurnReporter } from "../../src/modules/chat/contracts/routineTurnState.js";
import { sensitiveSlotKeysForTurn } from "../../src/modules/chat/services/routines/sensitiveTurnMarker.js";

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
