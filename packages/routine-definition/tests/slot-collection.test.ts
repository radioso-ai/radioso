import { describe, expect, it } from "vitest";

import { collectSlotKeys, collectedSlotsByStep, type SlotCollectionStep } from "../src/index.js";

const step = (
  stableStepId: string,
  ordinal: number,
  instruction: string,
  kind: SlotCollectionStep["kind"] = "chat",
): SlotCollectionStep => ({ stableStepId, ordinal, instruction, kind });

describe("collectSlotKeys", () => {
  it("returns the distinct references in first-seen order", () => {
    expect(collectSlotKeys("Hi {{slot.name}}, order {{ slot.order_number }} for {{slot.name}}?"))
      .toEqual(["name", "order_number"]);
  });

  it("ignores text that is not a slot reference", () => {
    expect(collectSlotKeys("Nothing here. {{notaslot.x}} {{slot.}}")).toEqual([]);
  });
});

describe("collectedSlotsByStep", () => {
  it("gives a slot to the first chat step that references it, in ordinal order", () => {
    const collected = collectedSlotsByStep([
      step("ask_email", 1, "What is your email? {{slot.email}}"),
      step("greet", 0, "Hello {{slot.name}}"),
    ]);
    expect(collected.get("greet")).toEqual(["name"]);
    expect(collected.get("ask_email")).toEqual(["email"]);
  });

  it("treats a later reference as a use, not a re-collection", () => {
    const collected = collectedSlotsByStep([
      step("ask_name", 0, "Your name? {{slot.name}}"),
      step("sign_off", 1, "Talk soon, {{slot.name}}"),
    ]);
    expect(collected.get("ask_name")).toEqual(["name"]);
    expect(collected.has("sign_off")).toBe(false);
  });

  it("only chat steps collect — a tool step interpolating a slot does not own it", () => {
    const collected = collectedSlotsByStep([
      step("lookup", 0, "Look up {{slot.order_number}}", "tool"),
      step("ask_order", 1, "Order number? {{slot.order_number}}"),
    ]);
    expect(collected.has("lookup")).toBe(false);
    expect(collected.get("ask_order")).toEqual(["order_number"]);
  });

  it("omits steps that collect nothing", () => {
    const collected = collectedSlotsByStep([step("say_hi", 0, "Hello there")]);
    expect(collected.size).toBe(0);
  });

  it("does not mutate the caller's step order", () => {
    const steps = [step("b", 1, "{{slot.two}}"), step("a", 0, "{{slot.one}}")];
    collectedSlotsByStep(steps);
    expect(steps.map((entry) => entry.stableStepId)).toEqual(["b", "a"]);
  });
});
