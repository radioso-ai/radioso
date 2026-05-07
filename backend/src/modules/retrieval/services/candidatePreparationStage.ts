import { CandidatePreparationService } from "./candidatePreparationService.js";
import { buildAppliedConstraintForRule, MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type {
  CandidatePreparationStage as CandidatePreparationStageContract,
  CandidatePreparationStageResult,
  CandidateRetrievalStageResult,
} from "./retrievalPipelineStages.js";
import type { RetrievedCandidate, TriggerBackoffDecision } from "../domain/retrievalPipelineTypes.js";
import { getContextSelectionClauses } from "./retrievalShapeResolver.js";

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
    const classifyBackoffReason = (
      candidateCount: number,
    ): TriggerBackoffDecision["reason"] | undefined => {
      if (matchedHardFilterRules.length === 0) {
        return undefined;
      }
      if (candidateCount === 0) {
        return "empty_filtered_candidates";
      }
      if (
        candidateCount < minimumUsefulCandidateCount &&
        normalizedCandidates.length >= minimumUsefulCandidateCount
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
    const triggerBackoffReason = classifyBackoffReason(selectedCandidates.candidates.length);
    const relaxedRuleIds: string[] = [];

    if (triggerBackoffReason) {
      while (classifyBackoffReason(selectedCandidates.candidates.length)) {
        const relaxationOptions = prioritizedHardFilterRules
          .filter((rule) => retainedHardFilterRules.some((candidateRule) => candidateRule.id === rule.id))
          .map((rule) => {
            const remainingHardFilterRules = retainedHardFilterRules.filter((candidateRule) => candidateRule.id !== rule.id);
            const evaluation = evaluateRules(remainingHardFilterRules);

            return {
              rule,
              remainingHardFilterRules,
              evaluation,
              candidateCount: evaluation.candidates.length,
              resolved: !classifyBackoffReason(evaluation.candidates.length),
              matchStrength: triggerStrengthByRuleId.get(rule.id) ?? 1,
            };
          })
          .filter((option) => option.candidateCount > selectedCandidates.candidates.length)
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
    const orderedCandidates = this.applyResolvedCandidateOrdering(input, selectedCandidates.candidates);
    const mergedCandidates = orderedCandidates.slice(0, RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap);
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
        restoredCandidateCount: triggerBackoffApplied ? selectedCandidates.candidates.length : undefined,
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
      return right.similarity - left.similarity;
    });
  }
}
