import type {
  RetrievalExecutionDiagnostics,
  RetrievalExecutionMetadata,
  ActivitySummary,
} from "../domain/retrievalPipelineTypes.js";
import type { ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import { summarizeResolvedSteps } from "./retrievalShapeResolver.js";

export const presentParsedQuery = (parsedQuery: ParsedQueryInterpretation): NonNullable<ActivitySummary["parsedQuery"]> => ({
  originalQuery: parsedQuery.originalQuery ?? parsedQuery.semanticQuery,
  semanticQuery: parsedQuery.semanticQuery,
  lexicalQuery: parsedQuery.lexicalQuery,
  // Required by the public ParsedQuery contract; retrieval no longer parses query constraints.
  constraintSummary: [],
});

interface ActivitySummaryPresenterOptions {
  execution?: RetrievalExecutionMetadata;
}

export class ActivitySummaryPresenter {
  present(input: RetrievalExecutionDiagnostics, options: ActivitySummaryPresenterOptions = {}): ActivitySummary {
    const execution = options.execution ?? input.execution;
    return {
      skillName: input.skillDiagnostic?.skillName,
      surface: execution?.surface,
      path: execution?.path,
      status: input.fallbackApplied ? "fallback" : input.retrievalSkipped ? "skipped" : "success",
      outcome: input.retrievalSkipped ? "retrieval_skipped" : "retrieval_completed",
      execution,
      parsedQuery: input.parsedQuery ? presentParsedQuery(input.parsedQuery) : undefined,
      retrievalSubqueries:
        input.retrievalSubqueries && input.retrievalSubqueries.length > 1
          ? input.retrievalSubqueries.map((subquery) => ({
              id: subquery.id,
              label: subquery.label,
              semanticQuery: subquery.semanticQuery,
              lexicalQuery: subquery.lexicalQuery,
              reason: subquery.reason,
              responseLanguagePolicy: subquery.responseLanguagePolicy,
            }))
          : undefined,
      retrievalSkipped: input.retrievalSkipped,
      responseLanguagePolicy: input.responseLanguagePolicy,
      candidateCounts: {
        semantic: input.originalCandidateCount + input.rewrittenCandidateCount,
        lexical: input.lexicalCandidateCount ?? 0,
        temporal: input.temporalCandidateCount ?? 0,
        merged: input.normalizedCandidateCount,
        final: input.finalContextCount,
      },
      appliedConstraints: input.appliedConstraints?.length ? input.appliedConstraints : undefined,
      fallbackApplied: input.fallbackApplied,
      rerankStatus: input.rerankStatus,
      temporalDeterministicSort: {
        enabled: input.temporalDeterministicSortEnabled ?? true,
        applied: input.temporalDeterministicSortApplied ?? false,
        today: input.temporalDeterministicSortToday,
        datedContextCount: input.temporalDeterministicSortDatedContextCount ?? 0,
      },
      rewrite: {
        status: input.rewriteStatus,
        eligible: input.rewriteEligible ?? false,
        ran: input.rewriteRan ?? false,
        materialDisagreement: input.materialDisagreement ?? false,
        continuityDecision: input.continuityDecision,
        rejectionReason: input.rejectionReason,
        fallbackReason: input.fallbackReason,
      },
      triggerAnalysis: input.triggerAnalysis,
      triggerBackoff: input.triggerBackoff,
      shapeName: input.shapeSelection?.shapeName,
      queryShape: input.shapeSelection?.queryShape,
      resolvedSteps: summarizeResolvedSteps(input.shapeSelection?.resolvedRun),
      skillDiagnostic: input.skillDiagnostic,
    };
  }
}
