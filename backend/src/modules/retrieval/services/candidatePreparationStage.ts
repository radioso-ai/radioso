import { CandidatePreparationService } from "./candidatePreparationService.js";
import { MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";
import type { CandidatePreparationStage as CandidatePreparationStageContract, CandidateRetrievalStageResult } from "./retrievalPipelineStages.js";

export class CandidatePreparationStageService implements CandidatePreparationStageContract {
  constructor(
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly metadataRuleScoringService: MetadataRuleScoringService,
  ) {}

  async execute(input: CandidateRetrievalStageResult) {
    const normalizedCandidates = this.candidatePreparationService.prepare({
      original: input.originalContexts,
      rewritten: input.rewrittenContexts,
      lexical: input.lexicalContexts,
    });
    const mergedCandidates = normalizedCandidates.slice(0, HYBRID_RETRIEVAL_DEFAULTS.mergedCandidateCap);
    const metadataRuleCandidates = this.metadataRuleScoringService.apply({
      candidates: mergedCandidates,
      metadataRules: input.settings.metadataRules ?? [],
    });

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: metadataRuleCandidates.candidates,
      appliedConstraints: metadataRuleCandidates.appliedRules,
      candidateFallbackApplied: input.vectorFallbackApplied,
    };
  }
}
