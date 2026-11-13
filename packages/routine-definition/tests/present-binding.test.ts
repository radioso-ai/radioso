import { describe, expect, it } from "vitest";

import {
  collectedSlotsByStep,
  presentBindingOf,
  presentSourceCandidates,
  routineSlotSchema,
  routineStepMetadataSchema,
  routineStepSchema,
  type SlotCollectionStep,
} from "../src/index.js";

const chatStep = (stableStepId: string, ordinal: number, instruction: string, metadata?: unknown): SlotCollectionStep => ({
  stableStepId,
  ordinal,
  instruction,
  kind: "chat",
  ...(metadata ? { metadata } : {}),
});

describe("a step's present binding (#1763)", () => {
  it("parses the source, the selection and the slot", () => {
    const parsed = routineStepMetadataSchema.parse({ present: { from: "search", selection: "single", slot: "chosen_home" } });
    expect(parsed.present).toEqual({ from: "search", selection: "single", slot: "chosen_home" });
  });

  it("refuses an unknown selection, an unknown key or a dotted slot", () => {
    expect(routineStepMetadataSchema.safeParse({ present: { from: "search", selection: "many" } }).success).toBe(false);
    expect(routineStepMetadataSchema.safeParse({ present: { from: "search", selection: "none", fields: {} } }).success).toBe(false);
    expect(routineStepMetadataSchema.safeParse({ present: { from: "search", selection: "single", slot: "a.b" } }).success).toBe(false);
  });

  it("keeps a half-made binding saveable: the relations are validation's", () => {
    const step = routineStepSchema.parse({
      stableStepId: "choose",
      kind: "chat",
      instruction: "Show the matches.",
      ordinal: 2,
      metadata: { present: { from: "nowhere", selection: "single" } },
    });
    expect(presentBindingOf(step)).toEqual({ from: "nowhere", selection: "single" });
  });

  it("reads no binding from metadata without one or with a malformed one", () => {
    expect(presentBindingOf({ metadata: {} })).toBeNull();
    expect(presentBindingOf({ metadata: { present: "search" } })).toBeNull();
    expect(presentBindingOf({})).toBeNull();
  });

  it("declares item as a slot type", () => {
    expect(routineSlotSchema.safeParse({
      stableSlotId: "s1",
      key: "chosen_home",
      type: "item",
      required: true,
      description: null,
      ordinal: 0,
    }).success).toBe(true);
  });
});

describe("presentSourceCandidates", () => {
  const steps = [
    { stableStepId: "brief", kind: "chat" },
    { stableStepId: "lookup", kind: "tool" },
    { stableStepId: "log", kind: "action" },
    { stableStepId: "search", kind: "tool" },
    { stableStepId: "confirm", kind: "chat" },
    { stableStepId: "choose", kind: "chat" },
  ];
  const edge = (fromStep: string, toRef: string) => ({ fromStep, toRef });

  it("offers the tool steps that reach the step through tool and action steps only", () => {
    expect(presentSourceCandidates(steps, [edge("brief", "lookup"), edge("lookup", "log"), edge("log", "search"), edge("search", "choose")], "choose"))
      .toEqual(["lookup", "search"]);
  });

  it("stops at a waiting step: its turn ends, and the staged result with it", () => {
    expect(presentSourceCandidates(steps, [edge("lookup", "confirm"), edge("confirm", "search"), edge("search", "choose")], "choose"))
      .toEqual(["search"]);
    expect(presentSourceCandidates(steps, [edge("search", "confirm"), edge("confirm", "choose")], "choose")).toEqual([]);
  });
});

describe("collectedSlotsByStep with a presenting step", () => {
  it("gives the bound slot to the presenting step, even when an earlier step references it", () => {
    const collected = collectedSlotsByStep([
      chatStep("brief", 0, "Where and for how much? {{slot.area}} {{slot.chosen_home}}"),
      chatStep("choose", 1, "Show the matches.", { present: { from: "search", selection: "single", slot: "chosen_home" } }),
      chatStep("confirm", 2, "You picked {{slot.chosen_home}}."),
    ]);
    expect(collected.get("brief")).toEqual(["area"]);
    expect(collected.get("choose")).toEqual(["chosen_home"]);
    expect(collected.has("confirm")).toBe(false);
  });

  it("collects nothing for a presenting step that only shows cards", () => {
    const collected = collectedSlotsByStep([
      chatStep("show", 0, "Show the matches.", { present: { from: "search", selection: "none" } }),
    ]);
    expect(collected.size).toBe(0);
  });
});
