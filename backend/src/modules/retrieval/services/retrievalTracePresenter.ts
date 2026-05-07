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
  retrievalSkipped?: boolean;
  durationMs: number;
  answerOutcome?: string;
  validation?: {
    ran: boolean;
    answerModified: boolean;
    unsupportedSegmentCount: number;
    supportedSegmentCount?: number;
    substantiveUnsupportedSegmentCount?: number;
    hiddenSupportUsed?: boolean;
    hiddenSupportKindsUsed?: string[];
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

const toSupportStatus = (
  validation: AnswerOutcomeInput["validation"] | undefined,
): "supported" | "unsupported" | "not_checked" => {
  if (!validation?.ran) {
    return "not_checked";
  }

  return (validation.supportedSegmentCount ?? 0) > 0 && (validation.substantiveUnsupportedSegmentCount ?? 0) === 0
    ? "supported"
    : "unsupported";
};

const withAnswerSupportDiagnostic = (
  summary: RetrievalTraceSummary,
  outcome: AnswerOutcomeInput,
): RetrievalTraceSummary => {
  if (!summary.skillDiagnostic?.evidence) {
    return summary;
  }

  return {
    ...summary,
    skillDiagnostic: {
      ...summary.skillDiagnostic,
      evidence: {
        ...summary.skillDiagnostic.evidence,
        supportStatus: toSupportStatus(outcome.validation),
        groundingOutcome: outcome.answerOutcome,
      },
    },
  };
};

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
    const retrievalSkipped = Boolean(input.outcome.retrievalSkipped);
    const answerStage: RetrievalTraceStage = {
      stageId: "answer",
      kind: "answer_outcome",
      label: "Answer outcome",
      status: input.outcome.hadContexts || retrievalSkipped ? "applied" : "fallback",
      durationMs: input.outcome.durationMs,
      outputs: {
        outcome: input.outcome.answerOutcome
          ?? (
            retrievalSkipped
              ? "non_retrieval_answer"
              : input.outcome.hadContexts
                ? "grounded_answer"
                : "no_context"
          ),
        stream: input.outcome.stream,
        answerPreview: summarizeValue(input.outcome.answer),
        retrievalSkipped,
        validationRan: input.outcome.validation?.ran,
        answerModified: input.outcome.validation?.answerModified,
        unsupportedSegmentCount: input.outcome.validation?.unsupportedSegmentCount,
        supportedSegmentCount: input.outcome.validation?.supportedSegmentCount,
        substantiveUnsupportedSegmentCount: input.outcome.validation?.substantiveUnsupportedSegmentCount,
        hiddenSupportUsed: input.outcome.validation?.hiddenSupportUsed,
        hiddenSupportKindsUsed: input.outcome.validation?.hiddenSupportKindsUsed,
      },
      metrics: {
        answerLength: input.outcome.answer.length,
      },
      reason: retrievalSkipped
        ? "Retrieval was intentionally skipped for a non-retrieval chat turn."
        : input.outcome.hadContexts
          ? undefined
          : "No relevant contexts were available for grounded answer generation.",
    };

    return this.present(
      {
        ...baseTrace,
        stages: [...baseTrace.stages, answerStage],
        links: baseTrace.stages.some((stage) => stage.stageId === "diagnostics")
          ? [...baseTrace.links, { fromStageId: "diagnostics", toStageId: "answer", kind: "sequence" }]
          : baseTrace.links,
      },
      withAnswerSupportDiagnostic(input.summary, input.outcome),
    );
  }
}
