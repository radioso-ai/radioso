import { describe, expect, it } from "vitest";

import { appendSteeringBlock, renderSteeringBlock } from "../../src/shared/infra/prompts/steeringPromptRenderer.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { renderSteeringRules, type SteeringRule } from "../../src/shared/domain/steeringRule.js";

const rule = (action: string, priority: number): SteeringRule => ({
  id: `d${priority}`,
  directiveName: `Directive ${priority}`,
  action,
  priority,
  source: "directive",
  lifespan: "response",
});

describe("renderSteeringBlock", () => {
  it("returns an empty string when there are no rules", () => {
    expect(renderSteeringBlock([])).toBe("");
  });

  it("orders rules by priority and states the conflict tiebreak", () => {
    const block = renderSteeringBlock([
      rule("Lower priority behavior.", 10),
      rule("Higher priority behavior.", 90),
    ]);

    expect(block).toContain("priority order");
    expect(block).toContain("follow the one listed earlier");
    expect(block.indexOf("Higher priority behavior.")).toBeLessThan(
      block.indexOf("Lower priority behavior."),
    );
    expect(block).not.toContain("[d90]");
    expect(block).not.toContain("output envelope");
  });

  it("renders bracketed ids only when an envelope caller opts in", () => {
    const block = renderSteeringBlock([rule("Higher priority behavior.", 90)], {
      includeRuleIds: true,
    });

    expect(block).toContain("[d90]");
  });
});

// A routine chat step fed by a retrieval step composes its reply through the answer
// generators, so the host adapter renders the step's rule as the controlling
// instruction and directives through the routine step guidance (#1351).
describe("renderSteeringBlock on a routine step's reply", () => {
  const stepRule: SteeringRule = {
    action: "Answer from the retrieved policy, then ask what email address we can reach them at.",
    source: "routine",
    lifespan: "response",
  };
  const redirect = rule("Send anyone who needs a follow-up to the contact form at https://acme.example/contact.", 50);
  const tone = rule("Use the formal register.", 60);
  const genericBlock = (rules: SteeringRule[], includeRuleIds = false) =>
    renderSteeringRules(rules, {
      includeRuleIds,
      template: loadPromptTemplate("chat/steering.md"),
      templateName: "chat/steering.md",
    });

  it("opens with the controlling step instruction and frames directives as subordinate guidance", () => {
    const block = renderSteeringBlock([redirect, stepRule, tone], { includeRuleIds: true });

    const guidance = renderSteeringRules([redirect, tone], {
      includeRuleIds: true,
      template: loadPromptTemplate("chat/routine-step-steering.md"),
      templateName: "chat/routine-step-steering.md",
    });
    expect(block).toBe(renderPromptTemplate("chat/routine-step-answer-steering.md", {
      instructions: `- ${stepRule.action}`,
      subordinate_guidance: `${guidance}\n\n`,
    }));
    expect(block).toContain("[d50]");
    expect(block).toContain("subordinate to the step");
    expect(block.indexOf("Step instruction(s) — the controlling instruction")).toBeLessThan(block.indexOf(redirect.action));
    expect(block.indexOf(stepRule.action)).toBeLessThan(block.indexOf(redirect.action));
    expect(block).not.toContain("govern the visible answer");
  });

  it("renders the controlling step instruction without guidance when no directive steers the step", () => {
    const block = renderSteeringBlock([stepRule]);

    expect(block).toBe(
      renderPromptTemplate("chat/routine-step-answer-steering.md", { instructions: `- ${stepRule.action}`, subordinate_guidance: "" }),
    );
    expect(block).not.toContain("Standing rules");
  });

  it("appends the same routine-aware block for the answer composers that append steering", () => {
    expect(appendSteeringBlock("Base prompt.", [redirect, stepRule])).toBe(
      `Base prompt.\n\n${renderSteeringBlock([redirect, stepRule])}`,
    );
  });

  it("renders a steering set with no routine rule exactly as the generic block", () => {
    expect(renderSteeringBlock([redirect, tone], { includeRuleIds: true })).toBe(genericBlock([redirect, tone], true));
    expect(appendSteeringBlock("Base prompt.", [redirect, tone])).toBe(`Base prompt.\n\n${genericBlock([redirect, tone])}`);
    expect(appendSteeringBlock("Base prompt.", [])).toBe("Base prompt.");
  });

  it("leaves the follow-up question generator's block to its own framing on a routine step", () => {
    const suggestionRule: SteeringRule = { ...tone, surfaces: ["suggested_questions"] };

    expect(renderSteeringBlock([stepRule, suggestionRule], { surface: "suggested_questions" })).toBe(
      renderSteeringRules([suggestionRule], {
        template: loadPromptTemplate("chat/steering-suggested-questions.md"),
        templateName: "chat/steering-suggested-questions.md",
      }),
    );
  });
});
