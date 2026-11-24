import type { Routine, RoutineState } from "@radioso/conversation-contract";
import { describe, expect, it } from "vitest";

import { routineRunEventFields } from "../../src/modules/chat/services/routines/routineRunEvents.js";

const routine = {
  id: "booking",
  rootStepId: "ask_guests",
  slots: [{ key: "guests", type: "number" }],
  steps: [
    { id: "ask_guests", kind: "chat" },
    { id: "booked", kind: "terminal", metadata: { terminalKind: "complete" } },
    { id: "to_desk", kind: "terminal", metadata: { terminalKind: "handoff" } },
  ],
  transitions: [],
} as unknown as Routine;

const endedOn = (stepId: string, metadata?: Record<string, unknown>): RoutineState => ({
  sessionId: "conversation-1",
  routineId: "booking",
  executionId: "run-1",
  path: ["ask_guests", stepId],
  variables: { guests: 4 },
  status: "completed",
  ...(metadata ? { metadata } : {}),
});

describe("the routine.completed outcome of a saved run", () => {
  it("names the hand-off a run ended on when the stored run no longer carries the kind its ending recorded", () => {
    // The Postgres routine-state store keeps no metadata, so a correction to an ended run reads it back without one.
    expect(routineRunEventFields([routine], endedOn("to_desk")).ending?.outcome).toBe("handoff");
  });

  it("keeps the kind the ending recorded", () => {
    expect(routineRunEventFields([routine], endedOn("booked", { terminalKind: "handoff" })).ending?.outcome).toBe("handoff");
    expect(routineRunEventFields([routine], endedOn("booked")).ending?.outcome).toBe("complete");
  });
});
