import { CandidatePreparationService } from "./candidatePreparationService.js";
import { AttributeMatchScoringService } from "./attributeMatchScoringService.js";
import { MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";
import type { CandidatePreparationStage as CandidatePreparationStageContract, CandidateRetrievalStageResult } from "./retrievalPipelineStages.js";
import { defaultAttributeControls } from "../../settings/domain/retrievalSettings.js";

export class CandidatePreparationStageService implements CandidatePreparationStageContract {
  constructor(
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly attributeMatchScoringService: AttributeMatchScoringService,
    private readonly metadataRuleScoringService: MetadataRuleScoringService,
  ) {}

  async execute(input: CandidateRetrievalStageResult) {
    const normalizedCandidates = this.candidatePreparationService.prepare({
      original: input.originalContexts,
      rewritten: input.rewrittenContexts,
      lexical: input.lexicalContexts,
    });
    const mergedCandidates = normalizedCandidates.slice(0, HYBRID_RETRIEVAL_DEFAULTS.mergedCandidateCap);
    const queryScoredCandidates = this.attributeMatchScoringService.apply({
      candidates: mergedCandidates,
      parsedQuery: input.activeParsedQuery,
      signalPolicies: defaultAttributeControls(),
    });
    const metadataRuleCandidates = this.metadataRuleScoringService.apply({
      candidates: queryScoredCandidates.candidates,
      metadataRules: input.settings.metadataRules,
    });

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: metadataRuleCandidates.candidates,
      appliedConstraints: [...queryScoredCandidates.appliedConstraints, ...metadataRuleCandidates.appliedRules],
      candidateFallbackApplied: input.vectorFallbackApplied || queryScoredCandidates.fallbackApplied,
    };
  }
}
