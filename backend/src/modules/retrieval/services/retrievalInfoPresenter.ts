import type { RerankStatus, RetrievalExecutionDiagnostics, RetrievalTraceSummary } from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint } from "../domain/structuredAttributes.js";

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
    };
  }
}
