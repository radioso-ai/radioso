import { describe, expect, it, vi } from "vitest";

import {
  RetrievalAnswerExecutor,
  type RetrievalStrategyPipeline,
} from "../../src/modules/retrieval/services/retrievalAnswerExecutor.js";
import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelineResult,
} from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import type { RetrievalStrategySelection } from "../../src/modules/retrieval/domain/retrievalStrategySelection.js";

const sentinel = (tag: string) => ({ tag }) as unknown as RetrievalPipelineResult;

const makePipeline = (tag: string): RetrievalStrategyPipeline => ({
  run: vi.fn(async () => sentinel(`${tag}:run`)),
  interpret: vi.fn(async () => ({}) as RetrievalPipelineInterpretationResult),
  runInterpreted: vi.fn(async () => sentinel(`${tag}:runInterpreted`)),
  runWithoutRetrieval: vi.fn(async () => sentinel(`${tag}:runWithoutRetrieval`)),
});

const interpretationWith = (
  retrievalStrategy?: string,
): RetrievalPipelineInterpretationResult =>
  ({
    request: { workspaceId: "ws-1" },
    context: { result: { settings: { retrievalStrategy } } },
  }) as unknown as RetrievalPipelineInterpretationResult;

describe("RetrievalAnswerExecutor", () => {
  it("delegates interpret and runWithoutRetrieval to the fixed strategy (shared paths)", async () => {
    const fixed = makePipeline("fixed");
    const reasoning = makePipeline("reasoning");
    const executor = new RetrievalAnswerExecutor({ fixed, reasoning });

    await executor.interpret({ workspaceId: "ws-1" } as never);
    await executor.runWithoutRetrieval(interpretationWith("reasoning"));

    expect(fixed.interpret).toHaveBeenCalledOnce();
    expect(fixed.runWithoutRetrieval).toHaveBeenCalledOnce();
    expect(reasoning.interpret).not.toHaveBeenCalled();
    expect(reasoning.runWithoutRetrieval).not.toHaveBeenCalled();
  });

  it("routes runInterpreted to reasoning when the workspace prefers reasoning", async () => {
    const fixed = makePipeline("fixed");
    const reasoning = makePipeline("reasoning");
    const executor = new RetrievalAnswerExecutor({ fixed, reasoning });

    await executor.runInterpreted(interpretationWith("reasoning"));

    expect(reasoning.runInterpreted).toHaveBeenCalledOnce();
    expect(fixed.runInterpreted).not.toHaveBeenCalled();
  });

  it("routes runInterpreted to fixed by default", async () => {
    const fixed = makePipeline("fixed");
    const reasoning = makePipeline("reasoning");
    const executor = new RetrievalAnswerExecutor({ fixed, reasoning });

    await executor.runInterpreted(interpretationWith(undefined));

    expect(fixed.runInterpreted).toHaveBeenCalledOnce();
    expect(reasoning.runInterpreted).not.toHaveBeenCalled();
  });

  it("lazily constructs the reasoning strategy only when first needed", async () => {
    const fixed = makePipeline("fixed");
    const reasoning = makePipeline("reasoning");
    const factory = vi.fn(() => reasoning);
    const executor = new RetrievalAnswerExecutor({ fixed, reasoning: factory });

    await executor.runInterpreted(interpretationWith("fixed"));
    expect(factory).not.toHaveBeenCalled();

    await executor.runInterpreted(interpretationWith("reasoning"));
    await executor.runInterpreted(interpretationWith("reasoning"));
    expect(factory).toHaveBeenCalledOnce();
  });

  it("reports the strategy selection to the observer", async () => {
    const selections: RetrievalStrategySelection[] = [];
    const executor = new RetrievalAnswerExecutor({
      fixed: makePipeline("fixed"),
      reasoning: makePipeline("reasoning"),
      onStrategySelected: (selection) => selections.push(selection),
    });

    await executor.runInterpreted(interpretationWith("reasoning"));

    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ strategy: "reasoning", selectionMode: "deterministic" });
    expect(selections[0]?.selectionReason.length).toBeGreaterThan(0);
  });
});
