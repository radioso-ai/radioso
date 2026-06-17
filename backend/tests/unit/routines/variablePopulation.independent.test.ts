import { describe, expect, it } from "vitest";

import { analyzeGuaranteedVariablesOnEntry } from "../../../src/modules/routines/variablePopulation.js";

// Independent reviewer tests (not Codex's) — focus on the cases a naive
// "any-path / union" implementation would get wrong.
const def = (steps: unknown[], transitions: unknown[], slots: unknown[] = []) =>
  ({ steps, transitions, slots }) as never;
const chat = (id: string, ordinal: number, instruction = "") =>
  ({ stableStepId: id, kind: "chat", instruction, ordinal, metadata: {} });
const tool = (id: string, ordinal: number, outputAssignments: Record<string, string> = {}) =>
  ({ stableStepId: id, kind: "tool", instruction: "", ordinal, toolRef: "s", metadata: { outputAssignments } });
const edge = (fromStep: string, toRef: string) => ({ fromStep, toRef });

describe("analyzeGuaranteedVariablesOnEntry — independent", () => {
  it("diamond: a variable produced BEFORE the fork is guaranteed after the merge", () => {
    const r = analyzeGuaranteedVariablesOnEntry(def(
      [chat("s0", 0, "ask {{slot.x}}"), chat("a", 1), chat("b", 2), chat("m", 3)],
      [edge("s0", "a"), edge("s0", "b"), edge("a", "m"), edge("b", "m")],
      [{ key: "x" }],
    ));
    expect(r.get("m")?.has("x")).toBe(true);
  });

  it("a variable produced on only ONE branch is NOT guaranteed after the merge", () => {
    const r = analyzeGuaranteedVariablesOnEntry(def(
      [chat("s0", 0), chat("a", 1, "ask {{slot.x}}"), chat("b", 2), chat("m", 3)],
      [edge("s0", "a"), edge("s0", "b"), edge("a", "m"), edge("b", "m")],
      [{ key: "x" }],
    ));
    expect(r.get("m")?.has("x")).toBe(false);
  });

  it("a loop-body variable is NOT guaranteed at the loop head", () => {
    const r = analyzeGuaranteedVariablesOnEntry(def(
      [chat("head", 0), chat("body", 1, "ask {{slot.x}}")],
      [edge("head", "body"), edge("body", "head")],
      [{ key: "x" }],
    ));
    expect(r.get("head")?.has("x")).toBe(false);
  });

  it("a skill output assignment is guaranteed at a downstream step in a chain", () => {
    const r = analyzeGuaranteedVariablesOnEntry(def(
      [tool("t", 0, { result: "answer" }), chat("c", 1)],
      [edge("t", "c")],
      [],
    ));
    expect(r.get("c")?.has("answer")).toBe(true);
  });
});
