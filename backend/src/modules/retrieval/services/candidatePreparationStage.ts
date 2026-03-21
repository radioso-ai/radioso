import { CandidatePreparationService } from "./candidatePreparationService.js";
import { AttributeMatchScoringService } from "./attributeMatchScoringService.js";
import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";
import type { CandidatePreparationStage as CandidatePreparationStageContract, CandidateRetrievalStageResult } from "./retrievalPipelineStages.js";

export class CandidatePreparationStageService implements CandidatePreparationStageContract {
  constructor(
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly attributeMatchScoringService: AttributeMatchScoringService,
  ) {}

  async execute(input: CandidateRetrievalStageResult) {
    const normalizedCandidates = this.candidatePreparationService.prepare({
      original: input.originalContexts,
      rewritten: input.rewrittenContexts,
      lexical: input.lexicalContexts,
    });
    const mergedCandidates = normalizedCandidates.slice(0, HYBRID_RETRIEVAL_DEFAULTS.mergedCandidateCap);
    const scoredCandidates = this.attributeMatchScoringService.apply({
      candidates: mergedCandidates,
      parsedQuery: input.activeParsedQuery,
      attributeControls: input.settings.attributeControls,
    });

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: scoredCandidates.candidates,
      appliedConstraints: scoredCandidates.appliedConstraints,
      candidateFallbackApplied: input.vectorFallbackApplied || scoredCandidates.fallbackApplied,
    };
  }
}
