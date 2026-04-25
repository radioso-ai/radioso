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

const toTriggerStatus = (value: string | undefined): RetrievalTraceStageStatus => {
  if (value === "fallback") {
    return "fallback";
  }
  if (value?.startsWith("skipped")) {
    return "skipped";
  }

  return "applied";
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

const toSafeStageId = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

export class RetrievalTraceAssembler {
  assemble(input: RetrievalTraceAssemblerInput): RetrievalTrace {
    const { prompt, diagnostics, timings } = input;
    const rewriteReason = prompt.rewrittenQuery.rejectionReason ?? prompt.rewrittenQuery.fallbackReason;
    const semanticKind = prompt.rewrittenQuery.retrievalEligible ? "semantic_rewritten" : "semantic_original";
    const semanticBranches = prompt.retrievalBranches.map((branch, index) => ({
      stageId:
        prompt.retrievalBranches.length === 1
          ? semanticKind
          : `${semanticKind}_${index + 1}_${toSafeStageId(branch.label || branch.subqueryId)}`,
      kind: semanticKind,
      label: prompt.retrievalBranches.length === 1 ? "Semantic retrieval" : `Semantic retrieval: ${branch.label}`,
      query: branch.semanticQuery,
      reason: branch.reason,
      responseLanguagePolicy: branch.responseLanguagePolicy,
      contexts: branch.semanticContexts,
    }));
    const lexicalBranches = prompt.retrievalBranches.map((branch, index) => ({
      stageId:
        prompt.retrievalBranches.length === 1
          ? "lexical"
          : `lexical_${index + 1}_${toSafeStageId(branch.label || branch.subqueryId)}`,
      kind: "lexical",
      label: prompt.retrievalBranches.length === 1 ? "Lexical retrieval" : `Lexical retrieval: ${branch.label}`,
      query: branch.lexicalQuery,
      reason: branch.reason,
      responseLanguagePolicy: branch.responseLanguagePolicy,
      contexts: branch.lexicalContexts,
    }));
    const semanticTiming = {
      startedAt: timings.semanticRetrieval.startedAt,
      durationMs: Math.max(0, Math.round(timings.semanticRetrieval.durationMs / Math.max(semanticBranches.length, 1))),
    };
    const lexicalTiming = {
      startedAt: timings.lexicalRetrieval.startedAt,
      durationMs: Math.max(0, Math.round(timings.lexicalRetrieval.durationMs / Math.max(lexicalBranches.length, 1))),
    };

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
          lexicalEffectiveQuery: prompt.rewrittenQuery.lexicalQuery,
          responseIntent: diagnostics.responseIntent,
          responseLanguagePolicy: prompt.rewrittenQuery.responseLanguagePolicy,
          retrievalSubqueries: (diagnostics.retrievalSubqueries ?? []).map((subquery) => ({
            id: subquery.id,
            label: subquery.label,
            semanticQuery: subquery.semanticQuery,
            lexicalQuery: subquery.lexicalQuery,
            reason: subquery.reason,
            responseLanguagePolicy: subquery.responseLanguagePolicy,
          })),
          continuityDecision: prompt.continuityDecision,
          promptHistoryCount: prompt.promptHistory.length,
          rewriteEligible: prompt.rewrittenQuery.retrievalEligible,
          rewriteRan: diagnostics.rewriteRan ?? false,
          parsedConstraints: prompt.activeParsedQuery.constraints.map((constraint) => constraint.summary),
        },
        metrics: {
          rewriteConfidence: Number(prompt.rewrittenQuery.confidence.toFixed(3)),
          parsedConstraintCount: prompt.activeParsedQuery.constraints.length,
          promptHistoryCount: prompt.promptHistory.length,
        },
          reason: rewriteReason,
        },
      ),
      buildStage(
        "trigger_analysis",
        "trigger_analysis",
        "Trigger analysis",
        toTriggerStatus(prompt.triggerAnalysis.status),
        timings.queryInterpretation,
        {
          inputs: {
            query: prompt.request.query,
          },
          outputs: {
            consideredRules: prompt.triggerAnalysis.consideredRules,
            matchedRuleIds: prompt.triggerAnalysis.matchedRuleIds,
            unmatchedRuleIds: prompt.triggerAnalysis.unmatchedRuleIds,
            backoffDecision: prompt.triggerBackoff,
          },
          metrics: {
            consideredRuleCount: prompt.triggerAnalysis.consideredRules.length,
            matchCount: prompt.triggerAnalysis.matchCount,
          },
          reason: prompt.triggerAnalysis.failureReason,
        },
      ),
      ...semanticBranches.map((branch) =>
        buildStage(branch.stageId, branch.kind, branch.label, prompt.vectorFallbackApplied ? "fallback" : "applied", semanticTiming, {
          settings: {
            topK: prompt.settings.vectorTopK,
            similarityThreshold: prompt.settings.similarityThreshold,
            subqueryLabel: branch.label.replace(/^Semantic retrieval:\s*/, ""),
            responseLanguagePolicy: branch.responseLanguagePolicy,
          },
          inputs: {
            query: branch.query,
          },
          outputs: {
            candidateCount: branch.contexts.length,
            chunks: toChunkRefs(branch.contexts),
          },
          metrics: {
            candidateCount: branch.contexts.length,
            queryEmbeddingDurationMs: diagnostics.queryEmbeddingDurationMs ?? 0,
          },
          reason: branch.reason ?? (prompt.vectorFallbackApplied ? "Vector retrieval used fallback behavior." : undefined),
        }),
      ),
      ...lexicalBranches.map((branch) =>
        buildStage(branch.stageId, branch.kind, branch.label, "applied", lexicalTiming, {
          settings: {
            query: branch.query,
            subqueryLabel: branch.label.replace(/^Lexical retrieval:\s*/, ""),
            responseLanguagePolicy: branch.responseLanguagePolicy,
          },
          outputs: {
            candidateCount: branch.contexts.length,
            chunks: toChunkRefs(branch.contexts),
          },
          metrics: {
            candidateCount: branch.contexts.length,
          },
          reason: branch.reason,
        }),
      ),
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
          citationDisplayEnabled: prompt.responseSettings.citationDisplayEnabled,
          responseLanguagePolicy: prompt.responseSettings.responseLanguagePolicy,
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
          responseIntent: diagnostics.responseIntent,
          retrievalSkipped: diagnostics.retrievalSkipped,
          fallbackApplied: diagnostics.fallbackApplied,
          continuityDecision: diagnostics.continuityDecision,
        },
        metrics: {
          semanticCandidateCount: diagnostics.originalCandidateCount + diagnostics.rewrittenCandidateCount,
          lexicalCandidateCount: diagnostics.lexicalCandidateCount ?? 0,
          mergedCandidateCount: diagnostics.normalizedCandidateCount,
          finalContextCount: diagnostics.finalContextCount,
          queryEmbeddingDurationMs: diagnostics.queryEmbeddingDurationMs ?? 0,
        },
      }),
    ];

    const links: RetrievalTraceLink[] = [
      { fromStageId: "context", toStageId: "interpretation", kind: "sequence" },
      { fromStageId: "interpretation", toStageId: "trigger_analysis", kind: "sequence" },
      ...semanticBranches.map((branch) => ({ fromStageId: "trigger_analysis", toStageId: branch.stageId, kind: "branch" as const })),
      ...lexicalBranches.map((branch) => ({ fromStageId: "trigger_analysis", toStageId: branch.stageId, kind: "branch" as const })),
      ...semanticBranches.map((branch) => ({ fromStageId: branch.stageId, toStageId: "preparation", kind: "converge" as const })),
      ...lexicalBranches.map((branch) => ({ fromStageId: branch.stageId, toStageId: "preparation", kind: "converge" as const })),
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
      summary: {
        parsedQuery: diagnostics.parsedQuery
          ? {
              originalQuery: diagnostics.parsedQuery.originalQuery ?? diagnostics.parsedQuery.semanticQuery,
              semanticQuery: diagnostics.parsedQuery.semanticQuery,
              lexicalQuery: diagnostics.parsedQuery.lexicalQuery,
              constraintSummary: diagnostics.parsedQuery.constraints.map((constraint) => constraint.summary),
            }
          : undefined,
        retrievalSubqueries: (diagnostics.retrievalSubqueries ?? []).map((subquery) => ({
          id: subquery.id,
          label: subquery.label,
          semanticQuery: subquery.semanticQuery,
          lexicalQuery: subquery.lexicalQuery,
          reason: subquery.reason,
          responseLanguagePolicy: subquery.responseLanguagePolicy,
        })),
        responseIntent: diagnostics.responseIntent,
        retrievalSkipped: diagnostics.retrievalSkipped,
        intentConfidence: diagnostics.intentConfidence,
        intentFallbackApplied: diagnostics.intentFallbackApplied,
        responseLanguagePolicy: diagnostics.responseLanguagePolicy,
        candidateCounts: {
          semantic: diagnostics.originalCandidateCount + diagnostics.rewrittenCandidateCount,
          lexical: diagnostics.lexicalCandidateCount ?? 0,
          merged: diagnostics.normalizedCandidateCount,
          final: diagnostics.finalContextCount,
        },
        appliedConstraints: diagnostics.appliedConstraints,
        fallbackApplied: diagnostics.fallbackApplied,
        rerankStatus: diagnostics.rerankStatus,
        rewrite: {
          status: diagnostics.rewriteStatus,
          eligible: Boolean(diagnostics.rewriteEligible),
          ran: Boolean(diagnostics.rewriteRan),
          materialDisagreement: Boolean(diagnostics.materialDisagreement),
          continuityDecision: diagnostics.continuityDecision,
          rejectionReason: diagnostics.rejectionReason,
          fallbackReason: diagnostics.fallbackReason,
        },
        triggerAnalysis: diagnostics.triggerAnalysis,
        triggerBackoff: diagnostics.triggerBackoff,
      },
    };
  }
}
