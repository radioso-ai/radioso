import type {
  RetrievalExecutionDiagnostics,
  RetrievalSubquery,
  RewriteStatus,
  RerankStatus,
} from "../domain/retrievalPipelineTypes.js";

export class RetrievalExecutionTelemetryService {
  create(input: {
    rewriteStatus: RewriteStatus;
    rerankStatus: RerankStatus;
    originalCandidateCount: number;
    rewrittenCandidateCount: number;
    lexicalCandidateCount?: number;
    normalizedCandidateCount: number;
    finalContextCount: number;
    queryEmbeddingDurationMs?: number;
    parsedQuery?: import("../domain/structuredAttributes.js").ParsedQueryInterpretation;
    appliedConstraints?: import("../domain/structuredAttributes.js").AppliedConstraint[];
    candidateFallbackApplied: boolean;
    rewriteEligible?: boolean;
    rewriteRan?: boolean;
    materialDisagreement?: boolean;
    continuityDecision?: import("../domain/retrievalPipelineTypes.js").ContinuityDecision;
    rewriteProposal?: import("../domain/retrievalPipelineTypes.js").StructuredRewriteResult;
    retrievalSubqueries?: RetrievalSubquery[];
    rejectionReason?: string;
    fallbackReason?: string;
  }): RetrievalExecutionDiagnostics {
    return {
      ...input,
      fallbackApplied:
        input.candidateFallbackApplied || input.rewriteStatus === "fallback" || input.rerankStatus === "fallback",
    };
  }
}
