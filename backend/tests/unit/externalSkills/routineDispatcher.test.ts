import { describe, expect, it } from "vitest";

import { ExternalSkillRoutineDispatcher } from "../../../src/modules/externalSkills/externalSkillRoutineDispatcher.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";

type DispatchResult = { disposition: string; outcome?: { status: string; outputs?: unknown; answer?: string } };

const registryWith = (executor: { dispatch: (inv: unknown) => Promise<DispatchResult> }) =>
  ({
    resolve: (execution: { kind: string; adapter?: string }) =>
      execution.kind === "internal" && execution.adapter === EXTERNAL_SKILLS_ADAPTER ? executor : null,
  }) as never;

const turn = { agent: { id: "agent-1" } } as never;
const state = { variables: { message: "hi" } } as never;

describe("ExternalSkillRoutineDispatcher", () => {
  it("copies a settled outcome status verbatim (custom statuses survive for branching)", async () => {
    const executor = {
      dispatch: async (): Promise<DispatchResult> => ({
        disposition: "settled",
        outcome: { status: "slot_conflict", outputs: { x: 1 }, answer: "taken" },
      }),
    };
    const dispatcher = new ExternalSkillRoutineDispatcher(registryWith(executor));

    const result = await dispatcher.dispatch({ skillName: "handoff_slack", state, turn });
    expect(result).toEqual({ status: "slot_conflict", outputs: { x: 1 }, answer: "taken" });
  });

  it("passes the agent id and collected routine variables to the executor", async () => {
    let captured: { skill?: { name?: string }; collected?: unknown; context?: unknown } = {};
    const executor = {
      dispatch: async (inv: unknown): Promise<DispatchResult> => {
        captured = inv as typeof captured;
        return { disposition: "settled", outcome: { status: "completed" } };
      },
    };
    const dispatcher = new ExternalSkillRoutineDispatcher(registryWith(executor));

    await dispatcher.dispatch({ skillName: "handoff_slack", state, turn });
    expect(captured.skill?.name).toBe("handoff_slack");
    expect(captured.collected).toEqual({ message: "hi" });
    expect(captured.context).toEqual({ agentId: "agent-1" });
  });

  it("returns failed when no external-skills executor is registered", async () => {
    const dispatcher = new ExternalSkillRoutineDispatcher({ resolve: () => null } as never);
    const result = await dispatcher.dispatch({ skillName: "x", state, turn });
    expect(result.status).toBe("failed");
  });

  it("returns failed on a deferred disposition", async () => {
    const executor = { dispatch: async (): Promise<DispatchResult> => ({ disposition: "deferred" }) };
    const dispatcher = new ExternalSkillRoutineDispatcher(registryWith(executor));
    const result = await dispatcher.dispatch({ skillName: "handoff_slack", state, turn });
    expect(result.status).toBe("failed");
  });
});
