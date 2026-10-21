import type {
  ActivityTrace,
  ActivityStage,
  ActivityStageStatus,
  ActivitySummary,
} from "../domain/retrievalPipelineTypes.js";
import { maxAnswerContextPassages } from "../domain/answerCandidatePool.js";

interface AnswerOutcomeInput {
  answer: string;
  stream: boolean;
  hadContexts: boolean;
  retrievalSkipped?: boolean;
  /** Generation-only duration. When absent, the answer duration also describes generation. */
  generationDurationMs?: number;
  durationMs: number;
  answerOutcome?: string;
  skillName?: string;
  skillOutcome?: string;
  skillStatus?: string;
}

const ALLOWED_STATUSES = new Set<ActivityStageStatus>([
  "applied",
  "skipped",
  "fallback",
  "rejected",
  "unavailable",
  "failed",
]);

// Lists in a stage summary are kept to twelve items. The lists of passages an answer read are
// kept to the most passages an answer can hold, so they are always listed in full; stage
// metrics keep full counts for longer lists, such as a 40-passage range lookup.
const TRACE_LIST_LIMIT = 12;
const ANSWER_PASSAGE_LISTS: ReadonlySet<string> = new Set(["finalContexts", "finalContextTitles"]);

const summarizeValue = (value: unknown, listLimit = TRACE_LIST_LIMIT): unknown => {
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, listLimit).map((item) => summarizeValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return Object.fromEntries(entries.map(([key, item]) => [
      key,
      summarizeValue(item, ANSWER_PASSAGE_LISTS.has(key) ? maxAnswerContextPassages : TRACE_LIST_LIMIT),
    ]));
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
      durationMs: input.outcome.generationDurationMs ?? input.outcome.durationMs,
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
        skillName: input.outcome.skillName,
        skillOutcome: input.outcome.skillOutcome,
        skillStatus: input.outcome.skillStatus,
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
    // Prefer the dispatch wrapper when it has already been appended (post-pipeline)
    // so the flow reads diagnostics → skill_dispatch → generation → answer instead
    // of branching diagnostics → generation in parallel with a dangling
    // diagnostics → skill_dispatch that the debug graph would render as a dead end.
    const previousStageId = baseTrace.stages.some((stage) => stage.stageId === "skill_dispatch")
      ? "skill_dispatch"
      : baseTrace.stages.some((stage) => stage.stageId === "diagnostics")
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
