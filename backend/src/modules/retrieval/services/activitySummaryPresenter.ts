import type {
  RetrievalExecutionDiagnostics,
  RetrievalExecutionMetadata,
  ActivitySummary,
} from "../domain/retrievalPipelineTypes.js";
import { summarizeResolvedSteps } from "./retrievalShapeResolver.js";

export interface ActivitySummaryPresenterOptions {
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
      retrievalSkipped: input.retrievalSkipped,
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
      shapeName: input.shapeSelection?.shapeName,
      queryShape: input.shapeSelection?.queryShape,
      resolvedSteps: summarizeResolvedSteps(input.shapeSelection?.resolvedRun),
      skillDiagnostic: input.skillDiagnostic,
    };
  }
}
