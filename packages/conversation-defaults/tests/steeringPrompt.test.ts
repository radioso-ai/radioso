import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLARIFICATION_STEERING_PROMPT,
  DEFAULT_ROUTINE_STEP_STEERING_PROMPT,
  appendSteeringRules,
  renderRoutineStepInstructions,
  renderSteeringRules,
  routineStepSteeringOptions,
} from "../src/steeringPrompt.js";
import { partitionRoutineStepSteering, type SteeringRule } from "../src/domain.js";

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

  it("renders a coverage-conditional rule against the exact classifications the model can emit (#1260)", () => {
    const conditional: SteeringRule = {
      ...rule("Offer the contact form.", 10),
      coverageCriteria: { coverage: ["partial", "unanswered"] },
    };

    const block = renderSteeringRules([conditional]);

    expect(block).toContain(
      "Only when your coverage verdict is one of "
        + "[partial_insufficient_evidence, partial_conflicting_evidence, partial_intentional_scope_boundary, "
        + "unanswered_insufficient_evidence, unanswered_conflicting_evidence, unanswered_intentional_scope_boundary]"
        + ": Offer the contact form.",
    );
  });

  it("narrows the rendered classifications to the criteria's reasons when given", () => {
    const conditional: SteeringRule = {
      ...rule("Offer the contact form.", 10),
      coverageCriteria: { coverage: ["partial"], reasons: ["conflicting_evidence"] },
    };

    const block = renderSteeringRules([conditional]);

    expect(block).toContain(
      "Only when your coverage verdict is one of [partial_conflicting_evidence]: Offer the contact form.",
    );
  });

  it("layers a coverage condition with an authored condition clause", () => {
    const conditional: SteeringRule = {
      ...rule("Offer the contact form.", 10, { condition: "the visitor seems frustrated" }),
      coverageCriteria: { coverage: ["unanswered"], reasons: ["insufficient_evidence"] },
    };

    const block = renderSteeringRules([conditional]);

    expect(block).toContain(
      "Only when your coverage verdict is one of [unanswered_insufficient_evidence]: "
        + "Offer the contact form. (when: the visitor seems frustrated)",
    );
  });

  it("renders an ordinary rule unchanged when it carries no coverageCriteria", () => {
    const block = renderSteeringRules([rule("Be warm.", 10)]);
    expect(block).toContain("- Be warm.");
    expect(block).not.toContain("coverage verdict");
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

describe("routine step steering (#1351)", () => {
  const stepRule: SteeringRule = { action: "Ask what email address we can reach them at.", source: "routine", lifespan: "response" };

  it("partitions a step's steering into the controlling instruction and subordinate guidance by source", () => {
    const tone = rule("Be warm.", 60);
    const redirect = rule("Send follow-ups to the contact form.", 50);

    expect(partitionRoutineStepSteering([tone, stepRule, redirect])).toEqual({
      instructions: [stepRule],
      guidance: [tone, redirect],
    });
  });

  it("frames guidance as subordinate to the step instruction through the routine step template", () => {
    const block = renderSteeringRules([rule("Be warm.", 10)], routineStepSteeringOptions());

    expect(block.startsWith(DEFAULT_ROUTINE_STEP_STEERING_PROMPT.split("\n")[0] ?? "")).toBe(true);
    expect(block).toContain("subordinate to the step instruction");
    expect(block).toContain("- Be warm.");
    expect(block).not.toContain("follow the one listed earlier");
  });

  it("renders a host-supplied routine step template in place of the default", () => {
    expect(renderSteeringRules([rule("Be warm.", 10)], routineStepSteeringOptions("RULES\n{{steering_rules}}")))
      .toBe("RULES\n- Be warm.");
  });

  it("lists the step instructions one per line", () => {
    expect(renderRoutineStepInstructions(["Ask for the name.", "Ask for the email."]))
      .toBe("- Ask for the name.\n- Ask for the email.");
  });
});
