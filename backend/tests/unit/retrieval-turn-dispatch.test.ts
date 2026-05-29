import { describe, expect, it, vi } from "vitest";

import {
  DirectRetrievalTurnDispatch,
  SkillRetrievalTurnDispatch,
} from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { RetrievalAnswerSkillExecutor, type RetrievalPipelinePort } from "../../src/modules/retrieval/public.js";
import { SkillExecutorRegistry, type SkillDefinition } from "../../src/modules/skills/public.js";
import type { CapabilityCheckInput, CapabilityDecision, CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";

const result = (tag: string) =>
  ({
    rewrittenQuery: tag,
    trace: { traceId: "t", startedAt: "now", stages: [{ stageId: "answer" }], links: [] },
  } as unknown as Awaited<ReturnType<RetrievalPipelinePort["run"]>>);

const controller = (): RetrievalPipelinePort => ({
  run: vi.fn(),
  interpret: vi.fn(),
  runInterpreted: vi.fn().mockResolvedValue(result("interpreted")),
  runWithoutRetrieval: vi.fn().mockResolvedValue(result("without")),
});

const interpreted = { request: { workspaceId: "w1" } } as Parameters<RetrievalPipelinePort["runInterpreted"]>[0];

const skill = (requiredCapabilities: string[] = []) =>
  ({
    name: "retrieval.answer",
    execution: { kind: "internal", adapter: "retrieval_answer" },
    requiredCapabilities,
  } as SkillDefinition);

class StubCapabilityPolicy implements CapabilityPolicy {
  constructor(private readonly denied: Set<string> = new Set()) {}
  async can(input: CapabilityCheckInput): Promise<CapabilityDecision> {
    return this.denied.has(String(input.capability))
      ? { allowed: false, reason: "capability_denied" }
      : { allowed: true };
  }
}

describe("DirectRetrievalTurnDispatch", () => {
  it("calls runInterpreted for a retrieval turn and runWithoutRetrieval otherwise", async () => {
    const ctrl = controller();
    const dispatch = new DirectRetrievalTurnDispatch(ctrl);

    expect((await dispatch.dispatch({ interpreted, withRetrieval: true })).rewrittenQuery).toBe("interpreted");
    expect((await dispatch.dispatch({ interpreted, withRetrieval: false })).rewrittenQuery).toBe("without");
  });
});

describe("SkillRetrievalTurnDispatch", () => {
  const buildRegistry = (ctrl: RetrievalPipelinePort) =>
    new SkillExecutorRegistry([
      { kind: "internal", adapter: "retrieval_answer", executor: new RetrievalAnswerSkillExecutor(ctrl) },
    ]);

  const build = (ctrl: RetrievalPipelinePort, requiredCapabilities: string[] = [], denied = new Set<string>()) =>
    new SkillRetrievalTurnDispatch(buildRegistry(ctrl), skill(requiredCapabilities), new StubCapabilityPolicy(denied));

  it("dispatches retrieval.answer through the registry and returns the controller result", async () => {
    const ctrl = controller();
    const retrieval = await build(ctrl).dispatch({ interpreted, withRetrieval: true });
    expect(retrieval.rewrittenQuery).toBe("interpreted");
    expect(ctrl.runInterpreted).toHaveBeenCalledWith(interpreted);
  });

  it("routes a non-retrieval turn through runWithoutRetrieval", async () => {
    const ctrl = controller();
    await build(ctrl).dispatch({ interpreted, withRetrieval: false });
    expect(ctrl.runWithoutRetrieval).toHaveBeenCalledWith(interpreted);
    expect(ctrl.runInterpreted).not.toHaveBeenCalled();
  });

  it("records the dispatch as a skill_dispatch stage in the turn trace", async () => {
    const retrieval = await build(controller()).dispatch({ interpreted, withRetrieval: true });
    const stage = retrieval.trace.stages.at(-1)!;
    expect(stage.stageId).toBe("skill_dispatch");
    expect(stage.outputs).toMatchObject({
      skillName: "retrieval.answer",
      disposition: "settled",
      outcomeStatus: "completed",
      withRetrieval: true,
    });
    expect(retrieval.trace.links).toContainEqual({ fromStageId: "answer", toStageId: "skill_dispatch", kind: "sequence" });
  });

  it("degrades to a non-grounded answer when the agent lacks the required capability (066 FR-008)", async () => {
    const ctrl = controller();
    const dispatch = build(ctrl, ["retrieval.answer"], new Set(["retrieval.answer"]));

    await dispatch.dispatch({ interpreted, withRetrieval: true });
    // Capability denied → do not retrieve; run the non-grounded path instead.
    expect(ctrl.runWithoutRetrieval).toHaveBeenCalledWith(interpreted);
    expect(ctrl.runInterpreted).not.toHaveBeenCalled();
  });

  it("marks the trace stage as a fallback and records the denial reason when forbidden", async () => {
    const dispatch = build(controller(), ["retrieval.answer"], new Set(["retrieval.answer"]));
    const retrieval = await dispatch.dispatch({ interpreted, withRetrieval: true });
    const stage = retrieval.trace.stages.at(-1)!;
    expect(stage.status).toBe("fallback");
    expect(stage.outputs).toMatchObject({ withRetrieval: false, capabilityDenied: "capability_denied" });
  });

  it("does not check capabilities for a non-retrieval turn", async () => {
    const ctrl = controller();
    const policy = new StubCapabilityPolicy(new Set(["retrieval.answer"]));
    const can = vi.spyOn(policy, "can");
    const dispatch = new SkillRetrievalTurnDispatch(buildRegistry(ctrl), skill(["retrieval.answer"]), policy);

    await dispatch.dispatch({ interpreted, withRetrieval: false });
    expect(can).not.toHaveBeenCalled();
  });

  it("throws when no executor is registered for the skill", async () => {
    const dispatch = new SkillRetrievalTurnDispatch(new SkillExecutorRegistry([]), skill(), new StubCapabilityPolicy());
    await expect(dispatch.dispatch({ interpreted, withRetrieval: true })).rejects.toThrow(/no skill executor/i);
  });
});
