import { describe, expect, it } from "vitest";

import {
  BoundedGroundingStreamGate,
  type GroundingStreamGateDecision,
} from "../../src/modules/chat/services/boundedGroundingStreamGate.js";

const decisionText = (decision: GroundingStreamGateDecision): string =>
  decision.kind === "release" ? decision.text : "";

describe("BoundedGroundingStreamGate", () => {
  it("holds an unsupported prefix, then releases it when an in-range assertion completes", () => {
    let nowMs = 10;
    const gate = new BoundedGroundingStreamGate({
      contextCount: 2,
      maxRetainedCodePoints: 64,
      now: () => nowMs,
    });

    expect(gate.push("Held prefix ")).toEqual({ kind: "hold" });
    nowMs = 35;
    const opened = gate.push("claim[[2]].");

    expect(opened).toEqual({ kind: "release", text: "Held prefix claim[[2]]." });
    expect(gate.waitDurationMs).toBe(25);
    expect(gate.maxObservedRetainedCodePoints).toBe(23);
    expect(decisionText(gate.push(" Later."))).toBe(" Later.");
  });

  it("checks an assertion completed exactly at the code-point boundary before tripping the cap", () => {
    const prefix = "😀claim[[1]]";
    const gate = new BoundedGroundingStreamGate({
      contextCount: 1,
      maxRetainedCodePoints: Array.from(prefix).length,
      now: () => 0,
    });

    expect(gate.push(prefix)).toEqual({ kind: "release", text: prefix });
    expect(gate.maxObservedRetainedCodePoints).toBe(Array.from(prefix).length);
  });

  it("releases the rest of an oversized input chunk when its admitted prefix opens the gate", () => {
    const admitted = "abc[[1]]";
    const gate = new BoundedGroundingStreamGate({
      contextCount: 1,
      maxRetainedCodePoints: Array.from(admitted).length,
      now: () => 0,
    });

    expect(gate.push(`${admitted}TAIL`)).toEqual({ kind: "release", text: `${admitted}TAIL` });
    expect(gate.maxObservedRetainedCodePoints).toBe(Array.from(admitted).length);
  });

  it("trips fail-closed at the cap and never retains more than the configured Unicode code points", () => {
    const gate = new BoundedGroundingStreamGate({
      contextCount: 1,
      maxRetainedCodePoints: 4,
      now: () => 7,
    });

    expect(gate.push("😀😀😀😀😀")).toEqual({ kind: "bound" });
    expect(gate.maxObservedRetainedCodePoints).toBe(4);
    expect(gate.retainedCodePoints).toBe(0);
    expect(gate.waitDurationMs).toBe(0);
  });

  it("does not admit an assertion beyond the exact retained boundary", () => {
    const gate = new BoundedGroundingStreamGate({
      contextCount: 1,
      maxRetainedCodePoints: 8,
      now: () => 0,
    });

    expect(gate.push("12345678claim[[1]]")).toEqual({ kind: "bound" });
    expect(gate.retainedCodePoints).toBe(0);
  });

  it("keeps a slow candidate held without any wall-clock abandonment", () => {
    let nowMs = 0;
    const gate = new BoundedGroundingStreamGate({
      contextCount: 1,
      maxRetainedCodePoints: 64,
      now: () => nowMs,
    });

    expect(gate.push("Slow prefix. ")).toEqual({ kind: "hold" });
    nowMs = 60_000;
    expect(gate.push("Eventually sourced[[1]].")).toEqual({
      kind: "release",
      text: "Slow prefix. Eventually sourced[[1]].",
    });
    expect(gate.waitDurationMs).toBe(60_000);
  });

  it("ends closed for malformed, invalid-index, and anchor-free candidates", () => {
    for (const body of ["Malformed [[", "Invalid [[0]].", "Anchor free."]) {
      const gate = new BoundedGroundingStreamGate({
        contextCount: 2,
        maxRetainedCodePoints: 64,
        now: () => 0,
      });
      expect(gate.push(body)).toEqual({ kind: "hold" });
      expect(gate.finish()).toEqual({ kind: "closed" });
      expect(gate.retainedCodePoints).toBe(0);
    }
  });
});
