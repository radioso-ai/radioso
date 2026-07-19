import { randomUUID } from "node:crypto";

import type {
  RetrievalExecutionDiagnostics,
  ActivityTrace,
  ActivityLink,
  ActivityStage,
  ActivityStageStatus,
} from "../domain/retrievalPipelineTypes.js";
import type { PromptAssemblyStageResult } from "./retrievalPipelineStages.js";
import { getContextSelectionClauses, summarizeResolvedSteps } from "./retrievalShapeResolver.js";
import { getCandidateFusedScore, hasUsefulCandidateEvidence } from "./candidateScoring.js";

interface StageTiming {
  startedAt: string;
  durationMs: number;
}

export interface ActivityTraceAssemblerInput {
  prompt: PromptAssemblyStageResult;
  diagnostics: RetrievalExecutionDiagnostics;
  timings: {
    traceStartedAt: string;
    traceCompletedAt: string;
    totalDurationMs: number;
    retrievalContext: StageTiming;
    queryInterpretation: StageTiming;
    triggerAnalysis?: StageTiming;
    shapeSelection?: StageTiming;
    semanticRetrieval: StageTiming;
    lexicalRetrieval: StageTiming;
    candidatePreparation: StageTiming;
    contextSelection: StageTiming;
    promptAssembly: StageTiming;
    diagnostics: StageTiming;
  };
}

const toStatus = (value: string | undefined, fallback: ActivityStageStatus = "applied"): ActivityStageStatus => {
  if (value === "skipped" || value === "fallback" || value === "rejected") {
    return value;
  }

  return fallback;
};

const toTriggerStatus = (value: string | undefined): ActivityStageStatus => {
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
  status: ActivityStageStatus,
  timing: StageTiming,
  fields: Omit<ActivityStage, "stageId" | "kind" | "label" | "status" | "startedAt" | "durationMs"> = {},
): ActivityStage => ({
  stageId,
  kind,
  label,
  status,
  startedAt: timing.startedAt,
  durationMs: timing.durationMs,
  ...fields,
});

const toChunkRef = (context: { chunkId: string; documentId: string; title: string }) => ({
  chunkId: context.chunkId,
  documentId: context.documentId,
  title: context.title,
});

const toChunkRefs = (
  contexts: Array<{ chunkId: string; documentId: string; title: string }>,
) => contexts.map(toChunkRef);

const toSemanticChunkRefs = (
  contexts: Array<{ chunkId: string; documentId: string; title: string; similarity: number }>,
) => contexts.map((context) => ({
  ...toChunkRef(context),
  semanticScore: context.similarity,
}));

const toLexicalChunkRefs = (
  contexts: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    similarity: number;
    lexicalRankScore?: number;
  }>,
) => contexts.map((context) => ({
  ...toChunkRef(context),
  lexicalScore: context.similarity,
  lexicalRankScore: context.lexicalRankScore ?? 0,
}));

const toCandidateChunkRefs = (
  contexts: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    similarity: number;
    fusedScore?: number;
    semanticScore: number;
    lexicalScore: number;
    lexicalRankScore?: number;
    semanticRank?: number;
    lexicalRank?: number;
  }>,
) => contexts.map((context) => {
  const fusedScore = getCandidateFusedScore(context);
  return {
    ...toChunkRef(context),
    similarity: fusedScore,
    fusedScore,
    semanticScore: context.semanticScore,
    lexicalScore: context.lexicalScore,
    lexicalRankScore: context.lexicalRankScore ?? 0,
    semanticRank: context.semanticRank,
    lexicalRank: context.lexicalRank,
  };
});

const toSafeStageId = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

export class ActivityTraceAssembler {
  assemble(input: ActivityTraceAssemblerInput): ActivityTrace {
    const { prompt, diagnostics, timings } = input;
    const rewriteReason = prompt.rewrittenQuery.rejectionReason ?? prompt.rewrittenQuery.fallbackReason;
    const semanticKind = prompt.rewrittenQuery.retrievalEligible ? "semantic_rewritten" : "semantic_original";
    // Semantic search runs once per distinct semantic query (and is capped per turn),
    // while lexical search runs once per branch. Reflect that asymmetry in the trace:
    // collapse the semantic side to the queries actually searched so a single shared
    // (or capped) semantic search is not reported as several. `semanticSearched` is
    // owned by the retrieval stage; absence is treated as searched for older traces.
    const searchedSemanticBranches: typeof prompt.retrievalBranches = [];
    const seenSemanticQueries = new Set<string>();
    for (const branch of prompt.retrievalBranches) {
      if (branch.semanticSearched === false || seenSemanticQueries.has(branch.semanticQuery)) {
        continue;
      }
      seenSemanticQueries.add(branch.semanticQuery);
      searchedSemanticBranches.push(branch);
    }
    const semanticBranches = searchedSemanticBranches.map((branch, index) => ({
      stageId:
        searchedSemanticBranches.length === 1
          ? semanticKind
          : `${semanticKind}_${index + 1}_${toSafeStageId(branch.label || branch.subqueryId)}`,
      kind: semanticKind,
      label: searchedSemanticBranches.length === 1 ? "Semantic retrieval" : `Semantic retrieval: ${branch.label}`,
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
    const temporalContexts = prompt.temporalContexts ?? [];
    const temporalQueryMode = prompt.temporalQueryMode ?? "none";
    const temporalStructuredLookupEnabled = prompt.temporalStructuredLookupEnabled ?? true;
    const temporalStage = temporalQueryMode !== "none" || temporalContexts.length > 0
      ? buildStage("temporal", "temporal_retrieval", "Temporal retrieval", temporalStructuredLookupEnabled ? "applied" : "skipped", timings.semanticRetrieval, {
          settings: {
            temporalStructuredLookupEnabled,
            temporalQueryMode,
          },
          outputs: {
            candidateCount: temporalContexts.length,
            chunks: toChunkRefs(temporalContexts),
          },
          metrics: {
            candidateCount: temporalContexts.length,
          },
        })
      : undefined;
    const semanticTiming = {
      startedAt: timings.semanticRetrieval.startedAt,
      durationMs: Math.max(0, Math.round(timings.semanticRetrieval.durationMs / Math.max(semanticBranches.length, 1))),
    };
    const lexicalTiming = {
      startedAt: timings.lexicalRetrieval.startedAt,
      durationMs: Math.max(0, Math.round(timings.lexicalRetrieval.durationMs / Math.max(lexicalBranches.length, 1))),
    };

    const contextSelectionClauses = getContextSelectionClauses(prompt.shapeSelection?.resolvedRun);
    const resolvedSteps = summarizeResolvedSteps(diagnostics.shapeSelection?.resolvedRun);

    const stages: ActivityStage[] = [
      buildStage("context", "context", "Context", "applied", timings.retrievalContext, {
        settings: {
          vectorTopK: prompt.settings.vectorTopK,
          similarityThreshold: prompt.settings.similarityThreshold,
          rerankEnabled: prompt.settings.rerankEnabled,
          rerankTopK: prompt.settings.rerankTopK,
          queryRewriteEnabled: prompt.settings.queryRewriteEnabled,
          temporalStructuredLookupEnabled: prompt.settings.temporalStructuredLookupEnabled ?? true,
          temporalBoostUpcomingEnabled: prompt.settings.temporalBoostUpcomingEnabled ?? true,
          temporalDeterministicSortEnabled: prompt.settings.temporalDeterministicSortEnabled ?? true,
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
          interpretationSource: prompt.interpretationSource,
          effectiveQuery: prompt.activeQuery,
          semanticQuery: prompt.activeParsedQuery.semanticQuery,
          lexicalQuery: prompt.activeParsedQuery.lexicalQuery,
          lexicalEffectiveQuery: prompt.rewrittenQuery.lexicalQuery,
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
          promptHistoryReset: prompt.promptHistoryReset,
          turnKind: prompt.rewrittenQuery.structuredResult?.turnKind ?? null,
          temporalQueryMode,
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
        timings.triggerAnalysis ?? timings.queryInterpretation,
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
      ...(diagnostics.shapeSelection
        ? [
            buildStage(
              "shape_selection",
              "shape_selection",
              "Shape selection",
              "applied",
              timings.shapeSelection ?? timings.queryInterpretation,
              {
                outputs: {
                  skillName: diagnostics.skillDiagnostic?.skillName ?? "retrieval.answer",
                  shapeName: diagnostics.shapeSelection.shapeName,
                  queryShape: diagnostics.shapeSelection.queryShape,
                  selectionMode: diagnostics.shapeSelection.selectionMode,
                  resolvedSteps,
                },
                metrics: {
                  selectionConfidence: diagnostics.shapeSelection.selectionConfidence ?? 1,
                },
                reason: diagnostics.shapeSelection.selectionReason,
              },
            ),
          ]
        : []),
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
            chunks: toSemanticChunkRefs(branch.contexts),
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
            chunks: toLexicalChunkRefs(branch.contexts),
          },
          metrics: {
            candidateCount: branch.contexts.length,
          },
          reason: branch.reason,
        }),
      ),
      ...(temporalStage ? [temporalStage] : []),
      buildStage("preparation", "candidate_preparation", "Candidate preparation", diagnostics.fallbackApplied ? "fallback" : "applied", timings.candidatePreparation, {
        outputs: {
          appliedConstraintSummaries: prompt.appliedConstraints.map((constraint) => constraint.summary),
          topCandidates: toCandidateChunkRefs(prompt.scoredCandidates.slice(0, 8)),
        },
        metrics: {
          normalizedCount: prompt.normalizedCandidates.length,
          mergedCount: prompt.mergedCandidates.length,
          scoredCount: prompt.scoredCandidates.length,
          usefulCandidateCount: prompt.scoredCandidates.filter(hasUsefulCandidateEvidence).length,
          temporalCandidateCount: temporalContexts.length,
        },
        reason: prompt.candidateFallbackApplied ? "Candidate fallback relaxed the prepared candidate pool." : undefined,
      }),
      buildStage("selection", "context_selection", "Context selection", toStatus(prompt.rerankStatus), timings.contextSelection, {
        settings: {
          rerankEnabled: prompt.settings.rerankEnabled,
          effectiveRerankEnabled: contextSelectionClauses.ranking.rerankMode === "disabled"
            ? false
            : prompt.settings.rerankEnabled,
          shapeRerankOverride: contextSelectionClauses.ranking.rerankMode === "disabled" ? "disabled_by_shape" : undefined,
          lexicalBias: contextSelectionClauses.ranking.lexicalBias,
          rerankTopK: prompt.settings.rerankTopK,
          temporalDeterministicSortEnabled: prompt.temporalDeterministicSortEnabled ?? true,
        },
        outputs: {
          finalContextTitles: prompt.contexts.map((context) => context.title),
          finalContexts: toCandidateChunkRefs(prompt.contexts),
          temporalDeterministicSortApplied: prompt.temporalDeterministicSortApplied ?? false,
          temporalDeterministicSortToday: prompt.temporalDeterministicSortToday,
        },
        metrics: {
          rerankedCount: prompt.rerankedContexts.length,
          temporalSortedDatedContextCount: prompt.temporalDeterministicSortDatedContextCount ?? 0,
          finalContextCount: prompt.contexts.length,
        },
      }),
      buildStage("prompt", "prompt_assembly", "Prompt assembly", "applied", timings.promptAssembly, {
        settings: {
          citationDisplayEnabled: prompt.responseSettings.citationDisplayEnabled,
          responseLanguagePolicy: prompt.responseSettings.responseLanguagePolicy,
          responseLanguage: prompt.responseSettings.responseLanguage,
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
          retrievalSkipped: diagnostics.retrievalSkipped,
          fallbackApplied: diagnostics.fallbackApplied,
          continuityDecision: diagnostics.continuityDecision,
          temporalDeterministicSortApplied: diagnostics.temporalDeterministicSortApplied,
          finalContexts: toCandidateChunkRefs(prompt.contexts),
        },
        metrics: {
          semanticCandidateCount: diagnostics.originalCandidateCount + diagnostics.rewrittenCandidateCount,
          lexicalCandidateCount: diagnostics.lexicalCandidateCount ?? 0,
          temporalCandidateCount: diagnostics.temporalCandidateCount ?? 0,
          mergedCandidateCount: diagnostics.normalizedCandidateCount,
          finalContextCount: diagnostics.finalContextCount,
          queryEmbeddingDurationMs: diagnostics.queryEmbeddingDurationMs ?? 0,
        },
      }),
    ];

    const links: ActivityLink[] = [
      { fromStageId: "context", toStageId: "interpretation", kind: "sequence" },
      { fromStageId: "interpretation", toStageId: "trigger_analysis", kind: "sequence" },
      ...(diagnostics.shapeSelection
        ? [{ fromStageId: "trigger_analysis", toStageId: "shape_selection", kind: "sequence" as const }]
        : []),
      ...semanticBranches.map((branch) => ({
        fromStageId: diagnostics.shapeSelection ? "shape_selection" : "trigger_analysis",
        toStageId: branch.stageId,
        kind: "branch" as const,
      })),
      ...lexicalBranches.map((branch) => ({
        fromStageId: diagnostics.shapeSelection ? "shape_selection" : "trigger_analysis",
        toStageId: branch.stageId,
        kind: "branch" as const,
      })),
      ...(temporalStage
        ? [{
            fromStageId: diagnostics.shapeSelection ? "shape_selection" : "trigger_analysis",
            toStageId: "temporal",
            kind: "branch" as const,
          }]
        : []),
      ...semanticBranches.map((branch) => ({ fromStageId: branch.stageId, toStageId: "preparation", kind: "converge" as const })),
      ...lexicalBranches.map((branch) => ({ fromStageId: branch.stageId, toStageId: "preparation", kind: "converge" as const })),
      ...(temporalStage ? [{ fromStageId: "temporal", toStageId: "preparation", kind: "converge" as const }] : []),
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
        retrievalSkipped: diagnostics.retrievalSkipped,
        responseLanguagePolicy: diagnostics.responseLanguagePolicy,
        candidateCounts: {
          semantic: diagnostics.originalCandidateCount + diagnostics.rewrittenCandidateCount,
          lexical: diagnostics.lexicalCandidateCount ?? 0,
          temporal: diagnostics.temporalCandidateCount ?? 0,
          merged: diagnostics.normalizedCandidateCount,
          final: diagnostics.finalContextCount,
        },
        appliedConstraints: diagnostics.appliedConstraints,
        fallbackApplied: diagnostics.fallbackApplied,
        rerankStatus: diagnostics.rerankStatus,
        temporalDeterministicSort: {
          enabled: diagnostics.temporalDeterministicSortEnabled ?? true,
          applied: diagnostics.temporalDeterministicSortApplied ?? false,
          today: diagnostics.temporalDeterministicSortToday,
          datedContextCount: diagnostics.temporalDeterministicSortDatedContextCount ?? 0,
        },
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
        shapeName: diagnostics.shapeSelection?.shapeName,
        queryShape: diagnostics.shapeSelection?.queryShape,
        resolvedSteps,
        skillDiagnostic: diagnostics.skillDiagnostic,
      },
    };
  }
}
