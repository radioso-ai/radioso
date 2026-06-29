import { describe, expect, it } from "vitest";

import { renderSteeringBlock } from "../../src/shared/infra/prompts/steeringPromptRenderer.js";
import type { SteeringRule } from "../../src/shared/domain/steeringRule.js";

const rule = (action: string, priority: number): SteeringRule => ({
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
  });
});
