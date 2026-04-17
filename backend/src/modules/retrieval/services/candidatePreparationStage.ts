import { CandidatePreparationService } from "./candidatePreparationService.js";
import { MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
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
    const metadataRuleCandidates = this.metadataRuleScoringService.apply({
      candidates: normalizedCandidates,
      metadataRules: input.settings.metadataRules ?? [],
    });
    const mergedCandidates = metadataRuleCandidates.candidates.slice(0, RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap);

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: mergedCandidates,
      appliedConstraints: metadataRuleCandidates.appliedRules,
      candidateFallbackApplied: input.vectorFallbackApplied,
    };
  }
}
