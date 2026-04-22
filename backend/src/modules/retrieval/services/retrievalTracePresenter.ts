import type {
  RetrievalTrace,
  RetrievalTraceStage,
  RetrievalTraceStageStatus,
  RetrievalTraceSummary,
} from "../domain/retrievalPipelineTypes.js";

export interface AnswerOutcomeInput {
  answer: string;
  stream: boolean;
  hadContexts: boolean;
  durationMs: number;
  answerOutcome?: string;
  validation?: {
    ran: boolean;
    answerModified: boolean;
    unsupportedSegmentCount: number;
    substantiveUnsupportedSegmentCount?: number;
  };
}

const ALLOWED_STATUSES = new Set<RetrievalTraceStageStatus>([
  "applied",
  "skipped",
  "fallback",
  "rejected",
  "unavailable",
  "failed",
]);

const summarizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => summarizeValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return Object.fromEntries(entries.map(([key, item]) => [key, summarizeValue(item)]));
  }

  return value;
};

const sanitizeStage = (stage: RetrievalTraceStage): RetrievalTraceStage => ({
  ...stage,
  status: ALLOWED_STATUSES.has(stage.status) ? stage.status : "applied",
  settings: stage.settings ? (summarizeValue(stage.settings) as Record<string, unknown>) : undefined,
  inputs: stage.inputs ? (summarizeValue(stage.inputs) as Record<string, unknown>) : undefined,
  outputs: stage.outputs ? (summarizeValue(stage.outputs) as Record<string, unknown>) : undefined,
});

export class RetrievalTracePresenter {
  present(input: RetrievalTrace, summary: RetrievalTraceSummary): RetrievalTrace {
    return {
      ...input,
      stages: input.stages.map((stage) => sanitizeStage(stage)),
      summary,
    };
  }

  appendAnswerOutcome(input: {
    trace?: RetrievalTrace;
    summary: RetrievalTraceSummary;
    outcome: AnswerOutcomeInput;
  }): RetrievalTrace {
    const baseTrace: RetrievalTrace = input.trace ?? {
      traceId: "unavailable-trace",
      startedAt: new Date().toISOString(),
      stages: [],
      links: [],
    };
    const answerStage: RetrievalTraceStage = {
      stageId: "answer",
      kind: "answer_outcome",
      label: "Answer outcome",
      status: input.outcome.hadContexts ? "applied" : "fallback",
      durationMs: input.outcome.durationMs,
      outputs: {
        outcome: input.outcome.answerOutcome ?? (input.outcome.hadContexts ? "grounded_answer" : "no_context"),
        stream: input.outcome.stream,
        answerPreview: summarizeValue(input.outcome.answer),
        validationRan: input.outcome.validation?.ran,
        answerModified: input.outcome.validation?.answerModified,
        unsupportedSegmentCount: input.outcome.validation?.unsupportedSegmentCount,
        substantiveUnsupportedSegmentCount: input.outcome.validation?.substantiveUnsupportedSegmentCount,
      },
      metrics: {
        answerLength: input.outcome.answer.length,
      },
      reason: input.outcome.hadContexts ? undefined : "No relevant contexts were available for grounded answer generation.",
    };

    return this.present(
      {
        ...baseTrace,
        stages: [...baseTrace.stages, answerStage],
        links: baseTrace.stages.some((stage) => stage.stageId === "diagnostics")
          ? [...baseTrace.links, { fromStageId: "diagnostics", toStageId: "answer", kind: "sequence" }]
          : baseTrace.links,
      },
      input.summary,
    );
  }
}
