import type {
  ActivityTrace,
  ActivityStage,
  ActivityStageStatus,
  ActivitySummary,
} from "../domain/retrievalPipelineTypes.js";

export interface AnswerOutcomeInput {
  answer: string;
  stream: boolean;
  hadContexts: boolean;
  retrievalSkipped?: boolean;
  durationMs: number;
  answerOutcome?: string;
}

const ALLOWED_STATUSES = new Set<ActivityStageStatus>([
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

const sanitizeStage = (stage: ActivityStage): ActivityStage => ({
  ...stage,
  status: ALLOWED_STATUSES.has(stage.status) ? stage.status : "applied",
  settings: stage.settings ? (summarizeValue(stage.settings) as Record<string, unknown>) : undefined,
  inputs: stage.inputs ? (summarizeValue(stage.inputs) as Record<string, unknown>) : undefined,
  outputs: stage.outputs ? (summarizeValue(stage.outputs) as Record<string, unknown>) : undefined,
});

export class ActivityTracePresenter {
  present(input: ActivityTrace, summary: ActivitySummary): ActivityTrace {
    const sanitizedStages = input.stages.map((stage) => sanitizeStage(stage));
    return {
      ...input,
      stages: sanitizedStages,
      summary: {
        traceId: input.traceId,
        ...summary,
      },
    };
  }

  appendAnswerOutcome(input: {
    trace?: ActivityTrace;
    summary: ActivitySummary;
    outcome: AnswerOutcomeInput;
  }): ActivityTrace {
    const baseTrace: ActivityTrace = input.trace ?? {
      traceId: "unavailable-trace",
      startedAt: new Date().toISOString(),
      stages: [],
      links: [],
    };
    const retrievalSkipped = Boolean(input.outcome.retrievalSkipped);
    const generationStage: ActivityStage = {
      stageId: "generation",
      kind: "generation",
      label: "Generation",
      status: "applied",
      durationMs: input.outcome.durationMs,
      outputs: {
        stream: input.outcome.stream,
        answerPreview: summarizeValue(input.outcome.answer),
      },
      metrics: {
        answerLength: input.outcome.answer.length,
      },
    };
    const answerStage: ActivityStage = {
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
        retrievalSkipped,
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
    const hasGenerationStage = baseTrace.stages.some((stage) => stage.stageId === generationStage.stageId);
    const previousStageId = baseTrace.stages.some((stage) => stage.stageId === "diagnostics")
      ? "diagnostics"
      : baseTrace.stages.at(-1)?.stageId;
    const generationLink = previousStageId && !hasGenerationStage
      ? [{ fromStageId: previousStageId, toStageId: generationStage.stageId, kind: "sequence" as const }]
      : [];

    return this.present(
      {
        ...baseTrace,
        stages: hasGenerationStage ? [...baseTrace.stages, answerStage] : [...baseTrace.stages, generationStage, answerStage],
        links: [
          ...baseTrace.links,
          ...generationLink,
          { fromStageId: generationStage.stageId, toStageId: "answer", kind: "sequence" },
        ],
      },
      input.summary,
    );
  }
}
