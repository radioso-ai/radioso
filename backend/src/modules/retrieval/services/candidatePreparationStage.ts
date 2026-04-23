import { CandidatePreparationService } from "./candidatePreparationService.js";
import { buildAppliedConstraintForRule, MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type {
  CandidatePreparationStage as CandidatePreparationStageContract,
  CandidatePreparationStageResult,
  CandidateRetrievalStageResult,
} from "./retrievalPipelineStages.js";
import type { TriggerBackoffDecision } from "../domain/retrievalPipelineTypes.js";

export class CandidatePreparationStageService implements CandidatePreparationStageContract {
  constructor(
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly metadataRuleScoringService: MetadataRuleScoringService,
  ) {}

  async execute(input: CandidateRetrievalStageResult): Promise<CandidatePreparationStageResult> {
    const normalizedCandidates = this.candidatePreparationService.prepare({
      original: input.originalContexts,
      rewritten: input.rewrittenContexts,
      lexical: input.lexicalContexts,
    });
    const alwaysOnRules = (input.settings.metadataRules ?? []).filter(
      (rule) => rule.enabled && rule.triggerMode !== "match_turn",
    );
    const matchedTriggeredRules = (input.settings.metadataRules ?? []).filter(
      (rule) => rule.enabled && rule.triggerMode === "match_turn" && input.triggerAnalysis.matchedRuleIds.includes(rule.id),
    );
    const activeRules = [...alwaysOnRules, ...matchedTriggeredRules];

    const metadataRuleCandidates = this.metadataRuleScoringService.apply({
      candidates: normalizedCandidates,
      metadataRules: activeRules,
    });
    const matchedHardFilterIds = matchedTriggeredRules.filter((rule) => rule.effect === "filter").map((rule) => rule.id);
    const emptyFilteredCandidates = matchedHardFilterIds.length > 0 && metadataRuleCandidates.candidates.length === 0;
    const weakFilteredSupport =
      matchedHardFilterIds.length > 0 &&
      metadataRuleCandidates.candidates.length > 0 &&
      metadataRuleCandidates.candidates.length < RETRIEVAL_BEHAVIOR.hybrid.minimumUsefulCandidateCount &&
      normalizedCandidates.length >= RETRIEVAL_BEHAVIOR.hybrid.minimumUsefulCandidateCount;
    const shouldBackOff = emptyFilteredCandidates || weakFilteredSupport;
    const relaxedRuleSet = shouldBackOff
      ? [...alwaysOnRules, ...matchedTriggeredRules.filter((rule) => rule.effect !== "filter")]
      : activeRules;
    const relaxedCandidates = shouldBackOff
      ? this.metadataRuleScoringService.apply({
          candidates: normalizedCandidates,
          metadataRules: relaxedRuleSet,
        })
      : metadataRuleCandidates;
    const relaxedRuleIds = new Set(matchedHardFilterIds);
    const relaxedConstraints = matchedTriggeredRules
      .filter((rule) => relaxedRuleIds.has(rule.id))
      .map((rule) => buildAppliedConstraintForRule(rule, "relaxed"));
    const mergedCandidates = relaxedCandidates.candidates.slice(0, RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap);
    const triggerBackoffReason: TriggerBackoffDecision["reason"] = emptyFilteredCandidates
      ? "empty_filtered_candidates"
      : weakFilteredSupport
        ? "weak_filtered_support"
        : undefined;

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: mergedCandidates,
      appliedConstraints: shouldBackOff
        ? [...relaxedCandidates.appliedRules, ...relaxedConstraints]
        : relaxedCandidates.appliedRules,
      candidateFallbackApplied: input.vectorFallbackApplied || shouldBackOff,
      triggerBackoff: {
        applied: shouldBackOff,
        reason: triggerBackoffReason,
        relaxedRuleIds: shouldBackOff ? matchedHardFilterIds : [],
        restoredCandidateCount: shouldBackOff ? relaxedCandidates.candidates.length : undefined,
      },
    };
  }
}
