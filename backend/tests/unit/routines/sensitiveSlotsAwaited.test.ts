import { describe, expect, it } from "vitest";

import { sensitiveSlotsAwaited, type RoutineDefinition } from "../../../src/modules/routines/public.js";

// A booking routine whose second step asks about an injury, a sensitive field.
const booking: RoutineDefinition = {
  id: "def_booking",
  agentId: "agent_1",
  lineageId: "def_booking",
  name: "booking",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "A visitor wants to book a class.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_class", key: "class_name", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "slot_injury", key: "injury", type: "text", required: true, description: null, ordinal: 1, sensitivity: "sensitive" },
  ],
  steps: [
    { stableStepId: "ask_class", kind: "chat", instruction: "Ask for {{slot.class_name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_injury", kind: "chat", instruction: "Ask about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} },
    { stableStepId: "confirm", kind: "chat", instruction: "Confirm {{slot.class_name}} and {{slot.injury}}.", toolRef: null, ordinal: 2, metadata: {} },
  ],
  transitions: [],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
  createdAt: new Date("2026-10-25T00:00:00.000Z"),
  updatedAt: new Date("2026-10-25T00:00:00.000Z"),
};

describe("sensitiveSlotsAwaited (#1543)", () => {
  it("names the sensitive slots the step a routine waits on collects, before any value is stored", () => {
    expect(sensitiveSlotsAwaited([booking], { routineId: "def_booking", path: ["ask_class", "ask_injury"] })).toEqual(["injury"]);
  });

  it("names none for a step that collects only normal slots, or only uses a sensitive one", () => {
    // The root step is current on an empty path.
    expect(sensitiveSlotsAwaited([booking], { routineId: "def_booking", path: [] })).toEqual([]);
    expect(sensitiveSlotsAwaited([booking], { routineId: "def_booking", path: ["ask_class", "ask_injury", "confirm"] })).toEqual([]);
  });

  it("names none for a routine the definitions do not hold", () => {
    expect(sensitiveSlotsAwaited([booking], { routineId: "def_other", path: ["ask_injury"] })).toEqual([]);
  });
});
