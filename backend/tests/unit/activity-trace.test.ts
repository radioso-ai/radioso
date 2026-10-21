import { describe, expect, it } from "vitest";

import { ActivityTracePresenter } from "../../src/modules/retrieval/services/activityTracePresenter.js";
import type { ActivityTrace } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { maxAnswerContextPassages } from "../../src/modules/retrieval/domain/answerCandidatePool.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

describe("activity trace presenter", () => {
  it("appends an answer stage and summary to a trace", () => {
    const presenter = new ActivityTracePresenter();
    const trace: ActivityTrace = {
      traceId: "trace-1",
      startedAt: "2026-03-23T00:00:00.000Z",
      stages: [
        {
          stageId: "diagnostics",
          kind: "diagnostics",
          label: "Diagnostics",
          status: "applied",
        },
      ],
      links: [],
    };

    const result = presenter.appendAnswerOutcome({
      trace,
      summary: {
        candidateCounts: {
          semantic: 2,
          lexical: 1,
          merged: 2,
          final: 1,
        },
        fallbackApplied: false,
        rerankStatus: "applied",
      },
      outcome: {
        answer: "A grounded answer",
        stream: true,
        hadContexts: true,
        durationMs: 12,
      },
    });

    expect(result.summary?.candidateCounts?.final).toBe(1);
    expect(result.stages.at(-1)).toMatchObject({
      stageId: "answer",
      kind: "answer_outcome",
      status: "applied",
      durationMs: 12,
    });
    expect(result.links.at(-1)).toEqual({
      fromStageId: "generation",
      toStageId: "answer",
      kind: "sequence",
    });
  });

  it("creates a bounded fallback trace when no base trace exists", () => {
    const presenter = new ActivityTracePresenter();

    const result = presenter.appendAnswerOutcome({
      summary: {
        candidateCounts: {
          semantic: 0,
          lexical: 0,
          merged: 0,
          final: 0,
        },
        fallbackApplied: true,
        rerankStatus: "skipped",
      },
      outcome: {
        answer: "x".repeat(400),
        stream: false,
        hadContexts: false,
        durationMs: 0,
      },
    });

    expect(result.traceId).toBe("unavailable-trace");
    expect(result.stages).toHaveLength(2);
    expect(result.stages.at(-1)).toMatchObject({
      stageId: "answer",
      status: "fallback",
    });
    expect((result.stages[0]?.outputs as { answerPreview: string }).answerPreview.length).toBeLessThanOrEqual(240);
  });

  it("preserves execution metadata in the trace summary", () => {
    const presenter = new ActivityTracePresenter();

    const result = presenter.appendAnswerOutcome({
      summary: {
        execution: {
          surface: "retrieval",
          path: "retrieval_answer",
          retrievalInvoked: true,
        },
        candidateCounts: {
          semantic: 1,
          lexical: 0,
          merged: 1,
          final: 1,
        },
        fallbackApplied: false,
        rerankStatus: "skipped",
      },
      outcome: {
        answer: "A grounded answer",
        stream: false,
        hadContexts: true,
        durationMs: 4,
      },
    });

    expect(result.summary?.execution).toEqual({
      surface: "retrieval",
      path: "retrieval_answer",
      retrievalInvoked: true,
    });
  });

  it("lists every passage an answer can hold, and keeps other lists to twelve", () => {
    const refs = (count: number) => Array.from({ length: count }, (_value, index) => ({ chunkId: `chunk-${index}` }));
    const trace: ActivityTrace = {
      traceId: "trace-lists",
      startedAt: "2026-10-21T00:00:00.000Z",
      stages: [
        {
          stageId: "selection",
          kind: "context_selection",
          label: "Context selection",
          status: "applied",
          outputs: {
            finalContexts: refs(maxAnswerContextPassages),
            finalContextTitles: refs(maxAnswerContextPassages).map((ref) => ref.chunkId),
            topCandidates: refs(15),
          },
        },
        {
          stageId: "temporal",
          kind: "temporal_retrieval",
          label: "Temporal retrieval",
          status: "applied",
          outputs: { chunks: refs(40) },
        },
      ],
      links: [],
    };

    const presented = new ActivityTracePresenter().present(trace, {});

    expect(presented.stages[0]?.outputs?.finalContexts).toHaveLength(maxAnswerContextPassages);
    expect(presented.stages[0]?.outputs?.finalContextTitles).toHaveLength(maxAnswerContextPassages);
    expect(presented.stages[0]?.outputs?.topCandidates).toHaveLength(12);
    expect(presented.stages[1]?.outputs?.chunks).toHaveLength(12);
    expect(maxAnswerContextPassages).toBe(RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK);
  });
});
