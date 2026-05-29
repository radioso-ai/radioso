import { describe, expect, it } from "vitest";

import { orderSteeringRules, type SteeringRule } from "../../src/shared/domain/steeringRule.js";
import type { SkillTransientGuidance } from "../../src/modules/skills/public.js";

describe("SteeringRule", () => {
  it("unifies the skill-emitted guidance shape (no field drift)", () => {
    // A SkillTransientGuidance is exactly a SteeringRule without the
    // loop-assigned provenance fields (source/lifespan). These assignments
    // fail to compile if the shapes ever diverge — the runtime guard mirrors
    // the type-level assertion in skillExecutorRegistry.ts.
    const guidance: SkillTransientGuidance = {
      action: "confirm before acting",
      condition: "the request is irreversible",
      priority: 2,
      criticality: "high",
      description: "irreversible actions need a confirm step",
    };

    const promoted: SteeringRule = { ...guidance, source: "skill", lifespan: "response" };
    expect(promoted.action).toBe("confirm before acting");
    expect(promoted.source).toBe("skill");

    const stripped: Omit<SteeringRule, "source" | "lifespan"> = guidance;
    expect(stripped.action).toBe("confirm before acting");
  });

  it("orders rules by priority desc, then criticality high→low", () => {
    const rules: SteeringRule[] = [
      { action: "a", priority: 1, criticality: "low", source: "directive", lifespan: "response" },
      { action: "b", priority: 5, criticality: "low", source: "directive", lifespan: "response" },
      { action: "c", priority: 1, criticality: "high", source: "directive", lifespan: "response" },
      { action: "d", source: "skill", lifespan: "response" },
    ];

    expect(orderSteeringRules(rules).map((r) => r.action)).toEqual(["b", "c", "a", "d"]);
  });

  it("does not mutate the input array", () => {
    const rules: SteeringRule[] = [
      { action: "a", priority: 1, source: "directive", lifespan: "response" },
      { action: "b", priority: 9, source: "directive", lifespan: "response" },
    ];
    const snapshot = [...rules];
    orderSteeringRules(rules);
    expect(rules).toEqual(snapshot);
  });
});
