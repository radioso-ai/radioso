import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { buildAppliedConstraintForRule, MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { mergeTemporalCandidates } from "./temporal/temporalCandidateMergeService.js";
import { applyUpcomingEventBoost } from "./temporal/upcomingBoostService.js";
import type {
  CandidatePreparationStage as CandidatePreparationStageContract,
  CandidatePreparationStageResult,
  CandidateRetrievalStageResult,
} from "./retrievalPipelineStages.js";
import type { RetrievedCandidate, TriggerBackoffDecision } from "../domain/retrievalPipelineTypes.js";
import { getContextSelectionClauses } from "./retrievalShapeResolver.js";
import { getCandidateFusedScore, hasUsefulCandidateEvidence } from "./candidateScoring.js";

export class CandidatePreparationStageService implements CandidatePreparationStageContract {
  constructor(
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly metadataRuleScoringService: MetadataRuleScoringService,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: CandidateRetrievalStageResult): Promise<CandidatePreparationStageResult> {
    const preparedCandidates = this.candidatePreparationService.prepare({
      original: input.originalContexts,
      rewritten: input.rewrittenContexts,
      lexical: input.lexicalContexts,
    });
    const documentScope = input.request.documentScope;
    const normalizedCandidates = documentScope && documentScope.length > 0
      ? preparedCandidates.filter((candidate) => new Set(documentScope).has(candidate.documentId))
      : preparedCandidates;
    const minimumUsefulCandidateCount = RETRIEVAL_BEHAVIOR.hybrid.minimumUsefulCandidateCount;
    const alwaysOnRules = (input.settings.metadataRules ?? []).filter(
      (rule) => rule.enabled && rule.triggerMode !== "match_turn",
    );
    const matchedTriggeredRules = (input.settings.metadataRules ?? []).filter(
      (rule) => rule.enabled && rule.triggerMode === "match_turn" && input.triggerAnalysis.matchedRuleIds.includes(rule.id),
    );
    const matchedTriggerBoostRules = matchedTriggeredRules.filter((rule) => rule.effect !== "filter");
    const matchedHardFilterRules = matchedTriggeredRules.filter((rule) => rule.effect === "filter");
    const triggerStrengthByRuleId = new Map(
      input.triggerAnalysis.consideredRules.map((rule) => [rule.ruleId, rule.matchStrength]),
    );
    const evaluateRules = (activeHardFilterRules: typeof matchedHardFilterRules) =>
      this.metadataRuleScoringService.apply({
        candidates: normalizedCandidates,
        metadataRules: [...alwaysOnRules, ...matchedTriggerBoostRules, ...activeHardFilterRules],
      });
    const normalizedUsefulCandidateCount = normalizedCandidates.filter(hasUsefulCandidateEvidence).length;
    const usefulCandidateCount = (candidates: RetrievedCandidate[]): number =>
      candidates.filter(hasUsefulCandidateEvidence).length;
    const classifyBackoffReason = (candidates: RetrievedCandidate[]): TriggerBackoffDecision["reason"] | undefined => {
      if (matchedHardFilterRules.length === 0) {
        return undefined;
      }
      if (candidates.length === 0) {
        return "empty_filtered_candidates";
      }
      if (
        usefulCandidateCount(candidates) < minimumUsefulCandidateCount &&
        normalizedUsefulCandidateCount >= minimumUsefulCandidateCount
      ) {
        return "weak_filtered_support";
      }
      return undefined;
    };

    const prioritizedHardFilterRules = [...matchedHardFilterRules].sort((left, right) => {
      const leftStrength = triggerStrengthByRuleId.get(left.id) ?? 1;
      const rightStrength = triggerStrengthByRuleId.get(right.id) ?? 1;
      return leftStrength - rightStrength;
    });

    let retainedHardFilterRules = [...matchedHardFilterRules];
    let selectedCandidates = evaluateRules(retainedHardFilterRules);
    const triggerBackoffReason = classifyBackoffReason(selectedCandidates.candidates);
    const relaxedRuleIds: string[] = [];

    if (triggerBackoffReason) {
      while (classifyBackoffReason(selectedCandidates.candidates)) {
        const relaxationOptions = prioritizedHardFilterRules
          .filter((rule) => retainedHardFilterRules.some((candidateRule) => candidateRule.id === rule.id))
          .map((rule) => {
            const remainingHardFilterRules = retainedHardFilterRules.filter((candidateRule) => candidateRule.id !== rule.id);
            const evaluation = evaluateRules(remainingHardFilterRules);

            return {
              rule,
              remainingHardFilterRules,
              evaluation,
              candidateCount: usefulCandidateCount(evaluation.candidates),
              resolved: !classifyBackoffReason(evaluation.candidates),
              matchStrength: triggerStrengthByRuleId.get(rule.id) ?? 1,
            };
          })
          .filter((option) => option.candidateCount > usefulCandidateCount(selectedCandidates.candidates))
          .sort((left, right) => {
            if (left.resolved !== right.resolved) {
              return left.resolved ? -1 : 1;
            }
            if (left.candidateCount !== right.candidateCount) {
              return right.candidateCount - left.candidateCount;
            }
            if (left.matchStrength !== right.matchStrength) {
              return left.matchStrength - right.matchStrength;
            }
            return left.rule.id.localeCompare(right.rule.id);
          });
        const selectedRelaxation = relaxationOptions[0];
        if (!selectedRelaxation) {
          break;
        }

        retainedHardFilterRules = selectedRelaxation.remainingHardFilterRules;
        relaxedRuleIds.push(selectedRelaxation.rule.id);
        selectedCandidates = selectedRelaxation.evaluation;
      }
    }

    const relaxedRuleIdSet = new Set(relaxedRuleIds);
    const relaxedConstraints = matchedTriggeredRules
      .filter((rule) => relaxedRuleIdSet.has(rule.id))
      .map((rule) => buildAppliedConstraintForRule(rule, "relaxed"));
    const boostedCandidates = applyUpcomingEventBoost({
      candidates: selectedCandidates.candidates,
      enabled: (input.settings.temporalBoostUpcomingEnabled ?? true) && (input.temporalQueryMode ?? "none") !== "none",
      today: formatIsoDateUtc(this.clock()),
    });
    const orderedCandidates = this.applyResolvedCandidateOrdering(input, boostedCandidates);
    const temporallyMergedCandidates = mergeTemporalCandidates({
      mode: (input.settings.temporalStructuredLookupEnabled ?? true) ? (input.temporalQueryMode ?? "none") : "none",
      temporalCandidates: input.temporalContexts ?? [],
      rankedCandidates: orderedCandidates,
    });
    const mergedCandidates = temporallyMergedCandidates.slice(0, RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap);
    const triggerBackoffApplied = relaxedRuleIds.length > 0;

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: mergedCandidates,
      appliedConstraints: triggerBackoffApplied
        ? [...selectedCandidates.appliedRules, ...relaxedConstraints]
        : selectedCandidates.appliedRules,
      candidateFallbackApplied: input.vectorFallbackApplied || triggerBackoffApplied,
      triggerBackoff: {
        applied: triggerBackoffApplied,
        reason: triggerBackoffApplied ? triggerBackoffReason : undefined,
        relaxedRuleIds,
        restoredCandidateCount: triggerBackoffApplied ? usefulCandidateCount(selectedCandidates.candidates) : undefined,
      },
    };
  }

  private applyResolvedCandidateOrdering(
    input: CandidateRetrievalStageResult,
    candidates: RetrievedCandidate[],
  ): RetrievedCandidate[] {
    const clauses = getContextSelectionClauses(input.shapeSelection?.resolvedRun);
    if (clauses.ranking.lexicalBias !== "preferred") {
      return candidates;
    }

    return [...candidates].sort((left, right) => {
      const leftHasLexical = left.lexicalScore > 0 ? 1 : 0;
      const rightHasLexical = right.lexicalScore > 0 ? 1 : 0;
      if (leftHasLexical !== rightHasLexical) {
        return rightHasLexical - leftHasLexical;
      }
      if (left.lexicalScore !== right.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      return getCandidateFusedScore(right) - getCandidateFusedScore(left);
    });
  }
}
