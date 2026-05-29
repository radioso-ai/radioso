import { describe, expect, it, vi } from "vitest";

import {
  RETRIEVAL_ANSWER_ADAPTER,
  RetrievalAnswerSkillExecutor,
  readRetrievalResult,
} from "../../src/modules/retrieval/public.js";
import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelinePort,
  RetrievalPipelineResult,
} from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { noopSkillEmitPort, type SkillDefinition } from "../../src/modules/skills/public.js";

const sampleResult = (): RetrievalPipelineResult =>
  ({
    rewrittenQuery: "rewritten",
    contexts: [],
    systemPrompt: "system",
    prompt: "prompt",
    citations: [],
    responseIdentity: null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
    },
    diagnostics: {} as RetrievalPipelineResult["diagnostics"],
    trace: { traceId: "t", startedAt: "now", stages: [], links: [] } as RetrievalPipelineResult["trace"],
  });

const stubController = (result: RetrievalPipelineResult): RetrievalPipelinePort => ({
  run: vi.fn().mockResolvedValue(result),
  interpret: vi.fn(),
  runInterpreted: vi.fn().mockResolvedValue(result),
  runWithoutRetrieval: vi.fn().mockResolvedValue(result),
});

const request = { workspaceId: "w1", query: "hello", history: [] };

const invocation = (context: Record<string, unknown>) => ({
  skill: { name: "retrieval.answer" } as SkillDefinition,
  collected: {},
  context,
  emit: noopSkillEmitPort,
});

describe("RetrievalAnswerSkillExecutor", () => {
  it("declares the retrieval_answer internal adapter key", () => {
    expect(RETRIEVAL_ANSWER_ADAPTER).toBe("retrieval_answer");
  });

  it("runs the controller and settles with the rich result on the non-model channel", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);

    const dispatch = await executor.dispatch(invocation({ request }));

    expect(dispatch.disposition).toBe("settled");
    if (dispatch.disposition !== "settled") return;
    expect(dispatch.outcome.status).toBe("completed");
    // The rich pipeline result rides on metadata (not model-visible outputs).
    expect(readRetrievalResult(dispatch.outcome)).toBe(result);
    expect(dispatch.outcome.outputs).toBeUndefined();
    expect(controller.run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", query: "hello" }));
  });

  it("dispatches an interpreted result through runInterpreted when provided", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);
    const interpreted = { request } as unknown as RetrievalPipelineInterpretationResult;

    await executor.dispatch(invocation({ interpreted, withRetrieval: true }));
    expect(controller.runInterpreted).toHaveBeenCalledWith(interpreted);
    expect(controller.run).not.toHaveBeenCalled();
  });

  it("uses runWithoutRetrieval for an interpreted, non-retrieval turn", async () => {
    const controller = stubController(sampleResult());
    const executor = new RetrievalAnswerSkillExecutor(controller);
    const interpreted = { request } as unknown as RetrievalPipelineInterpretationResult;

    await executor.dispatch(invocation({ interpreted, withRetrieval: false }));
    expect(controller.runWithoutRetrieval).toHaveBeenCalledWith(interpreted);
    expect(controller.runInterpreted).not.toHaveBeenCalled();
  });

  it("rejects an invocation that carries neither a request nor an interpreted result", async () => {
    const executor = new RetrievalAnswerSkillExecutor(stubController(sampleResult()));
    await expect(executor.dispatch(invocation({}))).rejects.toThrow(/request|interpreted/i);
  });
});
