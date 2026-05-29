import { describe, expect, it, vi } from "vitest";

import {
  DirectRetrievalTurnDispatch,
  SkillRetrievalTurnDispatch,
} from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { RetrievalAnswerSkillExecutor, type RetrievalPipelinePort } from "../../src/modules/retrieval/public.js";
import { SkillExecutorRegistry, type SkillDefinition } from "../../src/modules/skills/public.js";

const result = (tag: string) => ({ rewrittenQuery: tag } as unknown as Awaited<ReturnType<RetrievalPipelinePort["run"]>>);

const controller = (): RetrievalPipelinePort => ({
  run: vi.fn(),
  interpret: vi.fn(),
  runInterpreted: vi.fn().mockResolvedValue(result("interpreted")),
  runWithoutRetrieval: vi.fn().mockResolvedValue(result("without")),
});

const interpreted = { request: {} } as Parameters<RetrievalPipelinePort["runInterpreted"]>[0];

const retrievalAnswerSkill = {
  name: "retrieval.answer",
  execution: { kind: "internal", adapter: "retrieval_answer" },
} as SkillDefinition;

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

  it("dispatches retrieval.answer through the registry and returns the same result the controller produced", async () => {
    const ctrl = controller();
    const dispatch = new SkillRetrievalTurnDispatch(buildRegistry(ctrl), retrievalAnswerSkill);

    const retrieval = await dispatch.dispatch({ interpreted, withRetrieval: true });
    expect(retrieval.rewrittenQuery).toBe("interpreted");
    expect(ctrl.runInterpreted).toHaveBeenCalledWith(interpreted);
  });

  it("routes a non-retrieval turn through runWithoutRetrieval", async () => {
    const ctrl = controller();
    const dispatch = new SkillRetrievalTurnDispatch(buildRegistry(ctrl), retrievalAnswerSkill);

    await dispatch.dispatch({ interpreted, withRetrieval: false });
    expect(ctrl.runWithoutRetrieval).toHaveBeenCalledWith(interpreted);
    expect(ctrl.runInterpreted).not.toHaveBeenCalled();
  });

  it("throws when no executor is registered for the skill", async () => {
    const dispatch = new SkillRetrievalTurnDispatch(new SkillExecutorRegistry([]), retrievalAnswerSkill);
    await expect(dispatch.dispatch({ interpreted, withRetrieval: true })).rejects.toThrow(/no skill executor/i);
  });
});
