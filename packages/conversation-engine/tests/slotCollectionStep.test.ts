import { describe, expect, it } from "vitest";

import type { Routine } from "@radioso/conversation-contract";

import { isSlotCollectionStepSatisfied } from "../src/slotCollectionStep.js";

const routine: Routine = {
  id: "booking",
  rootStepId: "dates",
  slots: [
    { id: "slot_arrival", key: "arrival", type: "date", required: true },
    { id: "slot_departure", key: "departure", type: "date", required: true },
    { id: "slot_full_name", key: "full_name", type: "text", required: true },
    { id: "slot_phone", key: "phone", type: "text", required: false },
  ],
  steps: [
    { id: "dates", kind: "chat", action: "Ask for {{slot.arrival}} and {{slot.departure}}.", metadata: { collectsSlots: ["arrival", "departure"] } },
    { id: "contact", kind: "chat", action: "Ask for {{slot.full_name}} and {{slot.phone}}.", metadata: { collectsSlots: ["full_name", "phone"] } },
    { id: "done", kind: "terminal", action: "Done." },
  ],
  transitions: [
    { from: "dates", to: "contact", condition: "", guard: { kind: "default" } },
    { from: "contact", to: "done", condition: "", guard: { kind: "slot_filled", slots: ["full_name"] } },
  ],
};
const step = (id: string) => routine.steps.find((candidate) => candidate.id === id)!;

describe("isSlotCollectionStepSatisfied", () => {
  it("holds a step until its required slots are filled, ignoring its empty optional slot", () => {
    expect(isSlotCollectionStepSatisfied(routine, step("contact"), {})).toBe(false);
    expect(isSlotCollectionStepSatisfied(routine, step("contact"), { full_name: "Ada" })).toBe(true);
  });

  it("reads only the step's own slot_filled exits", () => {
    // `contact`'s exit passes, but it is not an exit of `dates`, whose dates are still empty.
    expect(isSlotCollectionStepSatisfied(routine, step("dates"), { full_name: "Ada" })).toBe(false);
  });

  it("treats a step that collects nothing as never satisfied", () => {
    expect(isSlotCollectionStepSatisfied(routine, step("done"), { full_name: "Ada" })).toBe(false);
  });
});
