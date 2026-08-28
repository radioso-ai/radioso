import { describe, expect, it } from "vitest";

import {
  authoredDirectiveInputSchema,
  validateAuthoredDirectiveCapabilities,
} from "../../src/modules/agents/authoredDirectives.js";
import { authoredDirectiveToDirective } from "../../src/modules/agents/authoredDirectiveMapper.js";

describe("authored directive domain validation", () => {
  it("rejects contextual directives without a condition description", () => {
    const result = authoredDirectiveInputSchema.safeParse({
      name: "procurement-tone",
      condition: { kind: "contextual" },
      action: "Use the procurement team's preferred tone.",
      routes: ["retrieval"],
      surfaces: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects over-length authored directive fields", () => {
    const result = authoredDirectiveInputSchema.safeParse({
      name: "x".repeat(201),
      condition: { kind: "always" },
      action: "Use the procurement team's preferred tone.",
      routes: ["retrieval"],
      surfaces: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects names reserved by built-in directives", () => {
    const result = authoredDirectiveInputSchema.safeParse({
      name: "concise-readable-formatting",
      condition: { kind: "always" },
      action: "Change the built-in behavior.",
      routes: ["retrieval"],
      surfaces: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects the removed criticality precedence field on authored input", () => {
    expect(authoredDirectiveInputSchema.safeParse({
      name: "criticality-dial",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      criticality: "high",
      routes: ["retrieval"],
      surfaces: [],
    }).success).toBe(false);
  });

  it("rejects invalid route values", () => {
    expect(authoredDirectiveInputSchema.safeParse({
      name: "bad-route",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      routes: ["marketing"],
      surfaces: [],
    }).success).toBe(false);
  });

  it("accepts an explicit priority, defaults to null, and bounds the range", () => {
    const ranked = authoredDirectiveInputSchema.parse({
      name: "ranked",
      condition: { kind: "always" },
      action: "Outrank the default formatting on conflict.",
      priority: 95,
    });
    expect(ranked.priority).toBe(95);

    const defaulted = authoredDirectiveInputSchema.parse({
      name: "unranked",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
    });
    expect(defaulted.priority).toBeNull();

    expect(authoredDirectiveInputSchema.safeParse({
      name: "too-high",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      priority: 101,
    }).success).toBe(false);

    expect(authoredDirectiveInputSchema.safeParse({
      name: "not-integer",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      priority: 12.5,
    }).success).toBe(false);
  });

  it("normalizes directive tags without requiring scope prefixes", () => {
    const result = authoredDirectiveInputSchema.parse({
      name: "scoped-step",
      condition: { kind: "always" },
      action: "Only while this step is active.",
      tags: ["step:contact:ask_email", "step:contact:ask_email", "custom-tag"],
    });

    expect(result.tags).toEqual(["step:contact:ask_email", "custom-tag"]);
  });

  it("materializes authored directive tags into runtime directives", () => {
    const directive = authoredDirectiveToDirective({
      name: "scoped-step",
      condition: { kind: "always" },
      action: "Only while this step is active.",
      priority: null,
      binding: null,
      lifecycle: null,
      requiredCapabilities: [],
      dependsOn: [],
      excludes: [],
      routes: [],
      surfaces: [],
      tags: ["step:contact:ask_email"],
      description: null,
      metadata: {},
    });

    expect(directive.tags).toEqual(["step:contact:ask_email"]);
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
