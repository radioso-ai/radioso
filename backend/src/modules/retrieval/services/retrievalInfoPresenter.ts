import type { RerankStatus, RetrievalExecutionDiagnostics } from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint } from "../domain/structuredAttributes.js";

export interface RetrievalInfo {
  parsedQuery?: {
    semanticQuery: string;
    lexicalQuery: string;
    constraintSummary: string[];
  };
  candidateCounts: {
    semantic: number;
    lexical: number;
    merged: number;
    final: number;
  };
  appliedConstraints?: AppliedConstraint[];
  fallbackApplied: boolean;
  rerankStatus: RerankStatus;
  rewrite?: {
    status: RetrievalExecutionDiagnostics["rewriteStatus"];
    eligible: boolean;
    ran: boolean;
    materialDisagreement: boolean;
    continuityDecision?: RetrievalExecutionDiagnostics["continuityDecision"];
    rejectionReason?: string;
  };
}

export class RetrievalInfoPresenter {
  present(input: RetrievalExecutionDiagnostics): RetrievalInfo {
    return {
      parsedQuery: input.parsedQuery
        ? {
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
      },
    };
  }
}
