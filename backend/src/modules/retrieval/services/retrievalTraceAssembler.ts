import { randomUUID } from "node:crypto";

import type {
  RetrievalExecutionDiagnostics,
  RetrievalTrace,
  RetrievalTraceLink,
  RetrievalTraceStage,
  RetrievalTraceStageStatus,
} from "../domain/retrievalPipelineTypes.js";
import type { PromptAssemblyStageResult } from "./retrievalPipelineStages.js";

interface StageTiming {
  startedAt: string;
  durationMs: number;
}

export interface RetrievalTraceAssemblerInput {
  prompt: PromptAssemblyStageResult;
  diagnostics: RetrievalExecutionDiagnostics;
  timings: {
    traceStartedAt: string;
    traceCompletedAt: string;
    totalDurationMs: number;
    retrievalContext: StageTiming;
    queryInterpretation: StageTiming;
    semanticRetrieval: StageTiming;
    lexicalRetrieval: StageTiming;
    candidatePreparation: StageTiming;
    contextSelection: StageTiming;
    promptAssembly: StageTiming;
    diagnostics: StageTiming;
  };
}

const toStatus = (value: string | undefined, fallback: RetrievalTraceStageStatus = "applied"): RetrievalTraceStageStatus => {
  if (value === "skipped" || value === "fallback" || value === "rejected") {
    return value;
  }

  return fallback;
};

const buildStage = (
  stageId: string,
  kind: string,
  label: string,
  status: RetrievalTraceStageStatus,
  timing: StageTiming,
  fields: Omit<RetrievalTraceStage, "stageId" | "kind" | "label" | "status" | "startedAt" | "durationMs"> = {},
): RetrievalTraceStage => ({
  stageId,
  kind,
  label,
  status,
  startedAt: timing.startedAt,
  durationMs: timing.durationMs,
  ...fields,
});

const toChunkRefs = (
  contexts: Array<{ chunkId: string; documentId: string; title: string }>,
) => contexts.map((context) => ({
  chunkId: context.chunkId,
  documentId: context.documentId,
  title: context.title,
}));

export class RetrievalTraceAssembler {
  assemble(input: RetrievalTraceAssemblerInput): RetrievalTrace {
    const { prompt, diagnostics, timings } = input;
    const rewriteReason = prompt.rewrittenQuery.rejectionReason ?? prompt.rewrittenQuery.fallbackReason;
    const semanticStageId = prompt.rewrittenQuery.retrievalEligible ? "semantic_rewritten" : "semantic_original";

    const stages: RetrievalTraceStage[] = [
      buildStage("context", "context", "Context", "applied", timings.retrievalContext, {
        settings: {
          vectorTopK: prompt.settings.vectorTopK,
          similarityThreshold: prompt.settings.similarityThreshold,
          rerankEnabled: prompt.settings.rerankEnabled,
          rerankTopK: prompt.settings.rerankTopK,
          queryRewriteEnabled: prompt.settings.queryRewriteEnabled,
        },
        inputs: {
          query: prompt.request.query,
          historyMessageCount: prompt.request.history.length,
          metadataFilterKeys: Object.keys(prompt.request.metadataFilter ?? {}),
        },
        outputs: {
          selectedHistoryCount: prompt.contextWindow.selectedMessages.length,
          historyTruncated: prompt.contextWindow.truncated,
          selectionReason: prompt.contextWindow.selectionReason,
          carryForwardLiterals: prompt.contextWindow.rewriteCarryForwardLiterals ?? [],
        },
        metrics: {
          selectedHistoryCount: prompt.contextWindow.selectedMessages.length,
        },
      }),
      buildStage(
        "interpretation",
        "query_interpretation",
        "Query interpretation",
        toStatus(prompt.rewrittenQuery.status),
        timings.queryInterpretation,
        {
          inputs: {
            originalQuery: prompt.request.query,
          },
          outputs: {
            effectiveQuery: prompt.activeQuery,
            semanticQuery: prompt.activeParsedQuery.semanticQuery,
            lexicalQuery: prompt.activeParsedQuery.lexicalQuery,
            continuityDecision: prompt.continuityDecision,
            rewriteEligible: prompt.rewrittenQuery.retrievalEligible,
            rewriteRan: diagnostics.rewriteRan ?? false,
            parsedConstraints: prompt.activeParsedQuery.constraints.map((constraint) => constraint.summary),
          },
          metrics: {
            rewriteConfidence: Number(prompt.rewrittenQuery.confidence.toFixed(3)),
            parsedConstraintCount: prompt.activeParsedQuery.constraints.length,
          },
          reason: rewriteReason,
        },
      ),
      buildStage(
        semanticStageId,
        semanticStageId,
        prompt.rewrittenQuery.retrievalEligible ? "Semantic retrieval (rewritten)" : "Semantic retrieval",
        prompt.vectorFallbackApplied ? "fallback" : "applied",
        timings.semanticRetrieval,
        {
          settings: {
            topK: prompt.settings.vectorTopK,
            similarityThreshold: prompt.settings.similarityThreshold,
          },
          inputs: {
            query: prompt.activeSemanticQuery,
          },
          outputs: {
            candidateCount: prompt.originalContexts.length + prompt.rewrittenContexts.length,
            chunks: toChunkRefs([...prompt.originalContexts, ...prompt.rewrittenContexts]),
          },
          metrics: {
            candidateCount: prompt.originalContexts.length + prompt.rewrittenContexts.length,
          },
          reason: prompt.vectorFallbackApplied ? "Vector retrieval used fallback behavior." : undefined,
        },
      ),
      buildStage("lexical", "lexical", "Lexical retrieval", "applied", timings.lexicalRetrieval, {
        settings: {
          query: prompt.activeParsedQuery.lexicalQuery || prompt.activeQuery,
        },
        outputs: {
          candidateCount: prompt.lexicalContexts.length,
          chunks: toChunkRefs(prompt.lexicalContexts),
        },
        metrics: {
          candidateCount: prompt.lexicalContexts.length,
        },
      }),
      buildStage("preparation", "candidate_preparation", "Candidate preparation", diagnostics.fallbackApplied ? "fallback" : "applied", timings.candidatePreparation, {
        outputs: {
          appliedConstraintSummaries: prompt.appliedConstraints.map((constraint) => constraint.summary),
          topCandidates: toChunkRefs(prompt.scoredCandidates.slice(0, 8)),
        },
        metrics: {
          normalizedCount: prompt.normalizedCandidates.length,
          mergedCount: prompt.mergedCandidates.length,
          scoredCount: prompt.scoredCandidates.length,
        },
        reason: prompt.candidateFallbackApplied ? "Candidate fallback relaxed the prepared candidate pool." : undefined,
      }),
      buildStage("selection", "context_selection", "Context selection", toStatus(prompt.rerankStatus), timings.contextSelection, {
        settings: {
          rerankEnabled: prompt.settings.rerankEnabled,
          rerankTopK: prompt.settings.rerankTopK,
        },
        outputs: {
          finalContextTitles: prompt.contexts.map((context) => context.title),
          finalContexts: toChunkRefs(prompt.contexts),
        },
        metrics: {
          rerankedCount: prompt.rerankedContexts.length,
          finalContextCount: prompt.contexts.length,
        },
      }),
      buildStage("prompt", "prompt_assembly", "Prompt assembly", "applied", timings.promptAssembly, {
        settings: {
          warmthLevel: prompt.responseSettings.warmthLevel,
          citationDisplayEnabled: prompt.responseSettings.citationDisplayEnabled,
        },
        outputs: {
          citations: prompt.citations.map((citation) => ({
            chunkId: citation.chunkId,
            documentId: citation.documentId,
            title: citation.title,
          })),
        },
        metrics: {
          promptContextCount: prompt.contexts.length,
          citationCount: prompt.citations.length,
        },
      }),
      buildStage("diagnostics", "diagnostics", "Diagnostics", "applied", timings.diagnostics, {
        outputs: {
          fallbackApplied: diagnostics.fallbackApplied,
          continuityDecision: diagnostics.continuityDecision,
        },
        metrics: {
          semanticCandidateCount: diagnostics.originalCandidateCount + diagnostics.rewrittenCandidateCount,
          lexicalCandidateCount: diagnostics.lexicalCandidateCount ?? 0,
          mergedCandidateCount: diagnostics.normalizedCandidateCount,
          finalContextCount: diagnostics.finalContextCount,
        },
      }),
    ];

    const links: RetrievalTraceLink[] = [
      { fromStageId: "context", toStageId: "interpretation", kind: "sequence" },
      { fromStageId: "interpretation", toStageId: semanticStageId, kind: "branch" },
      { fromStageId: "interpretation", toStageId: "lexical", kind: "branch" },
      { fromStageId: semanticStageId, toStageId: "preparation", kind: "converge" },
      { fromStageId: "lexical", toStageId: "preparation", kind: "converge" },
      { fromStageId: "preparation", toStageId: "selection", kind: "sequence" },
      { fromStageId: "selection", toStageId: "prompt", kind: "sequence" },
      { fromStageId: "prompt", toStageId: "diagnostics", kind: "sequence" },
    ];

    return {
      traceId: randomUUID(),
      startedAt: timings.traceStartedAt,
      completedAt: timings.traceCompletedAt,
      totalDurationMs: timings.totalDurationMs,
      stages,
      links,
    };
  }
}
