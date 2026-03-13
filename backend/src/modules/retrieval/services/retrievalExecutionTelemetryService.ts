import type { RetrievalExecutionDiagnostics, RewriteStatus, RerankStatus } from "../domain/retrievalPipelineTypes.js";

export class RetrievalExecutionTelemetryService {
  create(input: {
    rewriteStatus: RewriteStatus;
    rerankStatus: RerankStatus;
    originalCandidateCount: number;
    rewrittenCandidateCount: number;
    normalizedCandidateCount: number;
    finalContextCount: number;
  }): RetrievalExecutionDiagnostics {
    return {
      ...input,
      fallbackApplied: input.rewriteStatus === "fallback" || input.rerankStatus === "fallback",
    };
  }
}
