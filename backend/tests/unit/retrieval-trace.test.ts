import { describe, expect, it } from "vitest";

import { RetrievalTracePresenter } from "../../src/modules/retrieval/services/retrievalTracePresenter.js";
import type { RetrievalTrace } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";

describe("retrieval trace presenter", () => {
  it("appends an answer stage and summary to a trace", () => {
    const presenter = new RetrievalTracePresenter();
    const trace: RetrievalTrace = {
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

    expect(result.summary?.candidateCounts.final).toBe(1);
    expect(result.stages.at(-1)).toMatchObject({
      stageId: "answer",
      kind: "answer_outcome",
      status: "applied",
      durationMs: 12,
    });
    expect(result.links.at(-1)).toEqual({
      fromStageId: "diagnostics",
      toStageId: "answer",
      kind: "sequence",
    });
  });

  it("creates a bounded fallback trace when no base trace exists", () => {
    const presenter = new RetrievalTracePresenter();

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
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({
      stageId: "answer",
      status: "fallback",
    });
    expect((result.stages[0].outputs as { answerPreview: string }).answerPreview.length).toBeLessThanOrEqual(240);
  });

  it("records hidden support usage in the answer stage outputs", () => {
    const presenter = new RetrievalTracePresenter();

    const result = presenter.appendAnswerOutcome({
      summary: {
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
        answer: "I'm Vikram. The page explains testing.",
        stream: false,
        hadContexts: true,
        durationMs: 8,
        validation: {
          ran: true,
          answerModified: false,
          supportedSegmentCount: 2,
          unsupportedSegmentCount: 0,
          hiddenSupportUsed: true,
          hiddenSupportKindsUsed: ["assistant_name"],
        },
      },
    });

    expect(result.stages.at(-1)).toMatchObject({
      stageId: "answer",
      outputs: expect.objectContaining({
        hiddenSupportUsed: true,
        hiddenSupportKindsUsed: ["assistant_name"],
        supportedSegmentCount: 2,
      }),
    });
  });

  it("preserves execution metadata in the trace summary", () => {
    const presenter = new RetrievalTracePresenter();

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
});
