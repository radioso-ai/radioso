import { describe, expect, it } from "vitest";

import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import { analyzeGuaranteedVariablesOnEntry } from "../../../src/modules/routines/variablePopulation.js";

const now = new Date("2026-06-16T00:00:00.000Z");

const definition = (
  steps: RoutineDefinition["steps"],
  transitions: RoutineDefinition["transitions"],
  slots: RoutineDefinition["slots"] = [],
): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "population",
  version: 1,
  status: "published",
  activation: {
    triggerDescription: "Run the population test.",
    gateRef: null,
    priority: 10,
  },
  slots,
  steps,
  transitions,
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 },
  ],
  createdAt: now,
  updatedAt: now,
});

const chat = (stableStepId: string, ordinal: number, instruction: string): RoutineDefinition["steps"][number] => ({
  stableStepId,
  kind: "chat",
  instruction,
  toolRef: null,
  actionType: null,
  ordinal,
  metadata: {},
});

const tool = (
  stableStepId: string,
  ordinal: number,
  outputAssignments: Record<string, string> = {},
): RoutineDefinition["steps"][number] => ({
  stableStepId,
  kind: "tool",
  instruction: `Run ${stableStepId}.`,
  toolRef: stableStepId,
  actionType: null,
  ordinal,
  metadata: { outputAssignments },
});

const transition = (fromStep: string, toRef: string, ordinal: number): RoutineDefinition["transitions"][number] => ({
  fromStep,
  toRef,
  guardKind: "default",
  guardText: null,
  outcomeStatus: null,
  counterLimit: null,
  ordinal,
});

const asRecord = (result: ReadonlyMap<string, ReadonlySet<string>>): Record<string, string[]> =>
  Object.fromEntries([...result.entries()].map(([stepId, variables]) => [stepId, [...variables].sort()]));

describe("analyzeGuaranteedVariablesOnEntry", () => {
  it("does not guarantee a variable produced on only one branch at the other branch or after the merge", () => {
    const result = analyzeGuaranteedVariablesOnEntry(definition([
      chat("start", 0, "Start."),
      tool("produce_on_left", 1, { value: "left_only" }),
      chat("right", 2, "Right branch."),
      tool("merge", 3),
    ], [
      transition("start", "produce_on_left", 0),
      transition("start", "right", 1),
      transition("produce_on_left", "merge", 2),
      transition("right", "merge", 3),
      transition("merge", "done", 4),
    ]));

    expect(asRecord(result)).toMatchObject({
      start: [],
      produce_on_left: [],
      right: [],
      merge: [],
    });
  });

  it("guarantees a variable produced before a fork on both branches and after the merge", () => {
    const result = analyzeGuaranteedVariablesOnEntry(definition([
      tool("start", 0, { value: "before_fork" }),
      chat("left", 1, "Left branch."),
      chat("right", 2, "Right branch."),
      tool("merge", 3),
    ], [
      transition("start", "left", 0),
      transition("start", "right", 1),
      transition("left", "merge", 2),
      transition("right", "merge", 3),
      transition("merge", "done", 4),
    ]));

    expect(asRecord(result)).toMatchObject({
      start: [],
      left: ["before_fork"],
      right: ["before_fork"],
      merge: ["before_fork"],
    });
  });

  it("does not guarantee a variable produced inside a loop body at the loop head on first entry", () => {
    const result = analyzeGuaranteedVariablesOnEntry(definition([
      chat("loop_head", 0, "Check loop."),
      tool("loop_body", 1, { value: "body_value" }),
      tool("after_loop", 2),
    ], [
      transition("loop_head", "loop_body", 0),
      transition("loop_body", "loop_head", 1),
      transition("loop_head", "after_loop", 2),
      transition("after_loop", "done", 3),
    ]));

    expect(asRecord(result)).toMatchObject({
      loop_head: [],
      loop_body: [],
      after_loop: [],
    });
  });

  it("does not guarantee a slot whose collecting step is on only one branch, even when another branch re-references it", () => {
    // The slot is *collected* by the first-ordinal chat step that references it (`left`).
    // `right` merely interpolates `{{slot.x}}` (a use), so on the start→right→merge path
    // the slot is never collected. The analysis must agree with the compiler's
    // first-referencer rule and NOT treat `right` as a producer — otherwise validation
    // would let a required input bound to `x` reach `merge` with `x` unpopulated.
    const result = analyzeGuaranteedVariablesOnEntry(definition([
      chat("start", 0, "Start."),
      chat("left", 1, "Ask for {{slot.x}}."),
      chat("right", 2, "We will follow up about {{slot.x}}."),
      tool("merge", 3),
    ], [
      transition("start", "left", 0),
      transition("start", "right", 1),
      transition("left", "merge", 2),
      transition("right", "merge", 3),
      transition("merge", "done", 4),
    ], [
      { stableSlotId: "slot_x", key: "x", type: "text", required: true, description: null, ordinal: 0 },
    ]));

    expect(asRecord(result)).toMatchObject({
      left: [],
      right: [],
      merge: [],
    });
  });

  it("guarantees a variable produced at step 1 by step 3 in a linear chain", () => {
    const result = analyzeGuaranteedVariablesOnEntry(definition([
      chat("collect", 0, "Ask for {{slot.email}}."),
      chat("middle", 1, "Confirm."),
      tool("use_email", 2),
    ], [
      transition("collect", "middle", 0),
      transition("middle", "use_email", 1),
      transition("use_email", "done", 2),
    ], [
      { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 0 },
    ]));

    expect(asRecord(result)).toMatchObject({
      collect: [],
      middle: ["email"],
      use_email: ["email"],
    });
  });
});
