import { randomUUID } from "node:crypto";

import type {
  RetrievalExecutionDiagnostics,
  RetrievalAnswerShapeSelection,
  ActivityTrace,
  ActivityStageStatus,
} from "../domain/retrievalPipelineTypes.js";
import { ActivityTraceAssembler } from "./retrievalActivityTraceAssembler.js";
import type {
  PromptAssemblyStageResult,
  QueryInterpretationStageResult,
  RetrievalContextStageResult,
  RetrievalPipelineRequest,
} from "./retrievalPipelineStages.js";

interface MeasuredStage<T> {
  result: T;
  startedAt: number;
  durationMs: number;
}

export interface ActivityTraceSourceStages {
  traceStartedAtMs: number;
  context: MeasuredStage<RetrievalContextStageResult>;
  interpretation: MeasuredStage<QueryInterpretationStageResult>;
  triggerAnalysis?: MeasuredStage<unknown>;
  shapeSelection?: MeasuredStage<RetrievalAnswerShapeSelection>;
  retrieval: MeasuredStage<unknown>;
  prepared: MeasuredStage<unknown>;
  selection: MeasuredStage<unknown>;
  prompt: MeasuredStage<PromptAssemblyStageResult>;
  diagnostics: MeasuredStage<RetrievalExecutionDiagnostics>;
}

export interface NonActivityTraceSourceStages {
  request: RetrievalPipelineRequest;
  traceStartedAtMs: number;
  context: MeasuredStage<RetrievalContextStageResult>;
  interpretation: MeasuredStage<QueryInterpretationStageResult>;
}

const toIso = (value: number): string => new Date(value).toISOString();

const toInterpretationStatus = (value: string): ActivityStageStatus => {
  if (value === "fallback" || value === "rejected" || value === "skipped") {
    return value;
  }

  return "applied";
};

export class RetrievalPipelineActivityTraceBuilder {
  private readonly activityTraceAssembler = new ActivityTraceAssembler();

  buildActivityTrace(stages: ActivityTraceSourceStages): ActivityTrace {
    const traceCompletedAtMs = Date.now();
    const lexicalDurationMs = Math.max(0, Math.round(stages.retrieval.durationMs * 0.35));
    const semanticDurationMs = Math.max(0, stages.retrieval.durationMs - lexicalDurationMs);

    return this.activityTraceAssembler.assemble({
      prompt: stages.prompt.result,
      diagnostics: stages.diagnostics.result,
      timings: {
        traceStartedAt: toIso(stages.traceStartedAtMs),
        traceCompletedAt: toIso(traceCompletedAtMs),
        totalDurationMs: traceCompletedAtMs - stages.traceStartedAtMs,
        retrievalContext: {
          startedAt: toIso(stages.context.startedAt),
          durationMs: stages.context.durationMs,
        },
        queryInterpretation: {
          startedAt: toIso(stages.interpretation.startedAt),
          durationMs: stages.interpretation.durationMs,
        },
        triggerAnalysis: stages.triggerAnalysis
          ? {
              startedAt: toIso(stages.triggerAnalysis.startedAt),
              durationMs: stages.triggerAnalysis.durationMs,
            }
          : undefined,
        shapeSelection: stages.shapeSelection
          ? {
              startedAt: toIso(stages.shapeSelection.startedAt),
              durationMs: stages.shapeSelection.durationMs,
            }
          : undefined,
        semanticRetrieval: {
          startedAt: toIso(stages.retrieval.startedAt),
          durationMs: semanticDurationMs,
        },
        lexicalRetrieval: {
          startedAt: toIso(stages.retrieval.startedAt + semanticDurationMs),
          durationMs: lexicalDurationMs,
        },
        candidatePreparation: {
          startedAt: toIso(stages.prepared.startedAt),
          durationMs: stages.prepared.durationMs,
        },
        contextSelection: {
          startedAt: toIso(stages.selection.startedAt),
          durationMs: stages.selection.durationMs,
        },
        promptAssembly: {
          startedAt: toIso(stages.prompt.startedAt),
          durationMs: stages.prompt.durationMs,
        },
        diagnostics: {
          startedAt: toIso(stages.diagnostics.startedAt),
          durationMs: stages.diagnostics.durationMs,
        },
      },
    });
  }

  buildNonActivityTrace(
    stages: NonActivityTraceSourceStages,
    diagnostics: RetrievalExecutionDiagnostics,
  ): ActivityTrace {
    const traceCompletedAtMs = Date.now();

    return {
      traceId: randomUUID(),
      startedAt: toIso(stages.traceStartedAtMs),
      completedAt: toIso(traceCompletedAtMs),
      totalDurationMs: traceCompletedAtMs - stages.traceStartedAtMs,
      stages: [
        {
          stageId: "context",
          kind: "context",
          label: "Context",
          status: "applied",
          startedAt: toIso(stages.context.startedAt),
          durationMs: stages.context.durationMs,
          inputs: {
            query: stages.request.query,
            historyMessageCount: stages.request.history.length,
            metadataFilterKeys: Object.keys(stages.request.metadataFilter ?? {}),
          },
          outputs: {
            selectedHistoryCount: stages.context.result.contextWindow.selectedMessages.length,
            historyTruncated: stages.context.result.contextWindow.truncated,
            selectionReason: stages.context.result.contextWindow.selectionReason,
          },
        },
        {
          stageId: "routing",
          kind: "routing",
          label: "Routing",
          status: toInterpretationStatus(stages.interpretation.result.rewrittenQuery.status),
          startedAt: toIso(stages.interpretation.startedAt),
          durationMs: stages.interpretation.durationMs,
          inputs: {
            originalQuery: stages.request.query,
          },
          outputs: {
            retrievalSkipped: true,
            interpretationSource: stages.interpretation.result.interpretationSource,
            promptHistoryCount: stages.interpretation.result.promptHistory.length,
            responseLanguagePolicy: stages.interpretation.result.rewrittenQuery.responseLanguagePolicy,
            continuityDecision: stages.interpretation.result.continuityDecision,
          },
          metrics: {
            rewriteConfidence: Number(stages.interpretation.result.rewrittenQuery.confidence.toFixed(3)),
          },
          reason: "Retrieval was intentionally skipped for a direct chat turn.",
        },
      ],
      links: [
        { fromStageId: "context", toStageId: "routing", kind: "sequence" },
      ],
    };
  }
}
