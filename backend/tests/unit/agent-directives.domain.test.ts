import { describe, expect, it } from "vitest";

import {
  authoredDirectiveInputSchema,
  validateAuthoredDirectiveCapabilities,
} from "../../src/modules/agents/authoredDirectives.js";

describe("authored directive domain validation", () => {
  it("rejects contextual directives without a condition description", () => {
    const result = authoredDirectiveInputSchema.safeParse({
      name: "procurement-tone",
      condition: { kind: "contextual" },
      action: "Use the procurement team's preferred tone.",
      routes: ["retrieval"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects over-length authored directive fields", () => {
    const result = authoredDirectiveInputSchema.safeParse({
      name: "x".repeat(201),
      condition: { kind: "always" },
      action: "Use the procurement team's preferred tone.",
      routes: ["retrieval"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects names reserved by built-in directives", () => {
    const result = authoredDirectiveInputSchema.safeParse({
      name: "concise-readable-formatting",
      condition: { kind: "always" },
      action: "Change the built-in behavior.",
      routes: ["retrieval"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid criticality and route values", () => {
    expect(authoredDirectiveInputSchema.safeParse({
      name: "bad-criticality",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      criticality: "urgent",
      routes: ["retrieval"],
    }).success).toBe(false);

    expect(authoredDirectiveInputSchema.safeParse({
      name: "bad-route",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      routes: ["marketing"],
    }).success).toBe(false);
  });

  it("rejects unknown capability references against a registered capability set", () => {
    const result = validateAuthoredDirectiveCapabilities(
      ["retrieval.answer", "missing.capability"],
      new Set(["retrieval.answer"]),
    );

    expect(result).toEqual({
      ok: false,
      unknown: ["missing.capability"],
    });
  });
});
