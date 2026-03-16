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
  continuity?: {
    outcome: string;
    subject?: string;
    normalizedSubject?: string;
    supportCount: number;
    scoreMass: number;
    winnerMargin: number;
    agreementAcrossPaths: boolean;
    disagreementDetected: boolean;
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
      continuity: input.continuity
        ? {
            outcome: input.continuity.subjectReuseOutcome,
            subject: input.continuity.winningSubject?.canonicalLabel,
            normalizedSubject: input.continuity.winningSubject?.normalizedKey,
            supportCount: input.continuity.supportCount,
            scoreMass: input.continuity.scoreMass,
            winnerMargin: input.continuity.winnerMargin,
            agreementAcrossPaths: input.continuity.agreementAcrossPaths,
            disagreementDetected: input.continuity.disagreementDetected,
          }
        : undefined,
    };
  }
}
