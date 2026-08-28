import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLARIFICATION_STEERING_PROMPT,
  appendSteeringRules,
  renderSteeringRules,
} from "../src/steeringPrompt.js";
import type { SteeringRule } from "../src/domain.js";

const rule = (action: string, priority: number, extra: Partial<SteeringRule> = {}): SteeringRule => ({
  id: `d${priority}`,
  action,
  priority,
  source: "directive",
  lifespan: "response",
  ...extra,
});

describe("renderSteeringRules", () => {
  it("returns an empty string when there are no rules", () => {
    expect(renderSteeringRules([])).toBe("");
    expect(renderSteeringRules()).toBe("");
  });

  it("orders rules by priority regardless of the template", () => {
    const block = renderSteeringRules([rule("Lower.", 10), rule("Higher.", 90)]);

    expect(block.indexOf("Higher.")).toBeLessThan(block.indexOf("Lower."));
  });

  it("renders bracketed ids only when the caller opts in", () => {
    expect(renderSteeringRules([rule("Behave.", 90)])).not.toContain("[d90]");
    expect(renderSteeringRules([rule("Behave.", 90)], { includeRuleIds: true })).toContain("[d90]");
  });

  it("suffixes a rule's condition when it has one", () => {
    const block = renderSteeringRules([rule("Keep it short.", 10, { condition: "the user seems rushed" })]);

    expect(block).toContain("Keep it short. (when: the user seems rushed)");
  });

  it("renders the caller's template so each surface can frame its own guidance", () => {
    const block = renderSteeringRules([rule("Be warm.", 10)], {
      template: DEFAULT_CLARIFICATION_STEERING_PROMPT,
      templateName: "chat/steering-clarification.md",
    });

    expect(block).toContain("when phrasing the question");
    expect(block).toContain("- Be warm.");
    expect(block).not.toContain("priority order");
  });
});

describe("appendSteeringRules", () => {
  it("leaves the prompt untouched when no rules apply", () => {
    expect(appendSteeringRules("Base prompt.", [])).toBe("Base prompt.");
  });

  it("appends the rendered block after a blank line", () => {
    const prompt = appendSteeringRules("Base prompt.", [rule("Be warm.", 10)]);

    expect(prompt.startsWith("Base prompt.\n\n")).toBe(true);
    expect(prompt).toContain("- Be warm.");
  });
});
