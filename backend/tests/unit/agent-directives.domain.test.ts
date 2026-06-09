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

  it("rejects removed precedence fields on authored input", () => {
    expect(authoredDirectiveInputSchema.safeParse({
      name: "criticality-dial",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      criticality: "high",
      routes: ["retrieval"],
    }).success).toBe(false);

    expect(authoredDirectiveInputSchema.safeParse({
      name: "priority-dial",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      priority: 50,
      routes: ["retrieval"],
    }).success).toBe(false);
  });

  it("rejects invalid route values", () => {
    expect(authoredDirectiveInputSchema.safeParse({
      name: "bad-route",
      condition: { kind: "always" },
      action: "Use the configured behavior.",
      routes: ["marketing"],
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
      requiredCapabilities: [],
      dependsOn: [],
      excludes: [],
      routes: [],
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
