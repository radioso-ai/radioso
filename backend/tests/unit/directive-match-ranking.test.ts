import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIRECTIVE_PRIORITY,
  directiveMatchConfidence,
  directiveMatchPriority,
  type DirectiveMatch,
} from "../../src/modules/directives/public.js";

const match = (overrides: {
  deterministic?: boolean;
  confidence?: number;
  priority?: number;
}): DirectiveMatch => ({
  directive: {
    name: "d",
    condition: { kind: "always" },
    action: "act",
    ...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
  },
  selectionMode: overrides.deterministic ? "deterministic" : "probabilistic",
  selectionReason: "test",
  ...(overrides.confidence === undefined ? {} : { selectionConfidence: overrides.confidence }),
});

describe("directiveMatchConfidence", () => {
  it("treats a deterministic match as fully confident", () => {
    expect(directiveMatchConfidence(match({ deterministic: true }))).toBe(1);
  });

  it("ignores a deterministic match's recorded confidence", () => {
    expect(directiveMatchConfidence(match({ deterministic: true, confidence: 0.2 }))).toBe(1);
  });

  it("uses a probabilistic match's confidence", () => {
    expect(directiveMatchConfidence(match({ confidence: 0.7 }))).toBe(0.7);
  });

  it("reads a probabilistic match with no recorded confidence as zero", () => {
    expect(directiveMatchConfidence(match({}))).toBe(0);
  });
});

describe("directiveMatchPriority", () => {
  it("returns the authored priority when set", () => {
    expect(directiveMatchPriority(match({ priority: 90 }))).toBe(90);
  });

  it("defaults an unset priority to the neutral middle of the range", () => {
    expect(directiveMatchPriority(match({}))).toBe(DEFAULT_DIRECTIVE_PRIORITY);
    expect(DEFAULT_DIRECTIVE_PRIORITY).toBe(50);
  });
});
