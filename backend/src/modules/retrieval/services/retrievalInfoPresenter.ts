import type { RerankStatus, RetrievalExecutionDiagnostics, RetrievalTraceSummary } from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint } from "../domain/queryConstraintTypes.js";

export interface RetrievalInfo extends RetrievalTraceSummary {
  rerankStatus: RerankStatus;
  appliedConstraints?: AppliedConstraint[];
}

export class RetrievalInfoPresenter {
  present(input: RetrievalExecutionDiagnostics): RetrievalInfo {
    return {
      parsedQuery: input.parsedQuery
        ? {
            originalQuery: input.parsedQuery.originalQuery ?? input.parsedQuery.semanticQuery,
            semanticQuery: input.parsedQuery.semanticQuery,
            lexicalQuery: input.parsedQuery.lexicalQuery,
            constraintSummary: input.parsedQuery.constraints.map((constraint) => constraint.summary),
          }
        : undefined,
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
      responseIntent: input.responseIntent,
      retrievalSkipped: input.retrievalSkipped,
      intentConfidence: input.intentConfidence,
      intentFallbackApplied: input.intentFallbackApplied,
      responseLanguagePolicy: input.responseLanguagePolicy,
      candidateCounts: {
        semantic: input.originalCandidateCount + input.rewrittenCandidateCount,
        lexical: input.lexicalCandidateCount ?? 0,
        merged: input.normalizedCandidateCount,
        final: input.finalContextCount,
      },
      appliedConstraints: input.appliedConstraints?.length ? input.appliedConstraints : undefined,
      fallbackApplied: input.fallbackApplied,
      rerankStatus: input.rerankStatus,
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
    };
  }
}
