import type { RoutineStep } from "@radioso/conversation-contract";
import { describe, expect, it } from "vitest";

import { stagedContextForSkillResult } from "../src/routineStepContext.js";

describe("stagedContextForSkillResult", () => {
  const step: RoutineStep = { id: "lookup_order", kind: "skill", skillName: "order_lookup" };

  it("stages the output contract beside the outputs when the skill declares one", () => {
    const outputContract = { status: { type: "text" as const, description: "Order status" } };

    expect(stagedContextForSkillResult(step, { status: "completed", outputs: { status: "shipped" }, outputContract })).toEqual({
      kind: "skill_result",
      source: "order_lookup",
      data: { status: "shipped" },
      metadata: { stepId: "lookup_order", status: "completed", outputContract },
    });
  });

  it("stages no contract for a result without one", () => {
    expect(stagedContextForSkillResult(step, { status: "completed", outputs: { a: 1 } })?.metadata).toEqual({
      stepId: "lookup_order",
      status: "completed",
    });
  });
});
