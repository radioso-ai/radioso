import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { buildAppliedConstraintForRule, MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import {
  mergeTemporalCandidates,
  temporalCandidatePlacement,
  toTemporalCandidate,
} from "./temporal/temporalCandidateMergeService.js";
import { applyUpcomingEventBoost } from "./temporal/upcomingBoostService.js";
import type {
  CandidatePreparationStage as CandidatePreparationStageContract,
  CandidatePreparationStageResult,
  CandidateRetrievalStageResult,
} from "./retrievalPipelineStages.js";
import type { RetrievedCandidate, TriggerBackoffDecision } from "../domain/retrievalPipelineTypes.js";
import { isSomeTermsLexicalMatch, type RetrievedChunk } from "../domain/vectorSearch.js";
import type { RetrievalMetadataRule } from "../../settings/contracts/retrieval.js";
import { getContextSelectionClauses } from "./retrievalShapeResolver.js";
import {
  getCandidateFusedScore,
  hasUsefulCandidateEvidence,
  holdsPrimaryEvidence,
} from "./candidateScoring.js";

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
      // A filter that leaves only some-terms lexical hits has emptied the turn's evidence.
      if (!candidates.some(holdsPrimaryEvidence)) {
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
      enabled: (input.settings.temporalBoostUpcomingEnabled ?? true)
        && ((input.temporalQueryMode ?? "none") !== "none" || input.temporalDateRange !== undefined),
      today: formatIsoDateUtc(this.clock()),
      dateRange: input.temporalDateRange,
    });
    const orderedCandidates = this.applyResolvedCandidateOrdering(input, boostedCandidates);
    // Temporal candidates meet the same document scope and metadata rules as every ranked
    // candidate before they are merged or composed. The rules are applied here, not in the
    // lookup query: which match_turn rules hold is decided by trigger analysis and backoff,
    // after the lookup has already run.
    const temporalCandidates = this.scopeTemporalCandidates(input.temporalContexts ?? [], {
      documentScope,
      metadataRules: [...alwaysOnRules, ...matchedTriggerBoostRules, ...retainedHardFilterRules],
    });
    const requestedRangeLookup = input.temporalLookupRanking !== undefined;
    const temporallyMergedCandidates = mergeTemporalCandidates({
      placement: (input.settings.temporalStructuredLookupEnabled ?? true)
        ? temporalCandidatePlacement({ mode: input.temporalQueryMode ?? "none", requestedRangeLookup })
        : "none",
      temporalCandidates,
      rankedCandidates: orderedCandidates,
    });
    // Some-terms lexical hits corroborate other evidence. A turn that found nothing else
    // keeps none of them, so it reaches the answer as a turn with no evidence.
    const supportedCandidates = temporallyMergedCandidates.some(holdsPrimaryEvidence)
      || (requestedRangeLookup && temporalCandidates.length > 0)
      ? temporallyMergedCandidates
      : [];
    const mergedCandidates = supportedCandidates.slice(0, RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap);
    const triggerBackoffApplied = relaxedRuleIds.length > 0;

    return {
      ...input,
      normalizedCandidates,
      mergedCandidates,
      scoredCandidates: mergedCandidates,
      ...(requestedRangeLookup ? { rangeCandidates: temporalCandidates.map(toTemporalCandidate) } : {}),
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

  private scopeTemporalCandidates(
    temporalContexts: RetrievedChunk[],
    scope: { documentScope?: string[]; metadataRules: RetrievalMetadataRule[] },
  ): RetrievedChunk[] {
    const scopedDocuments = scope.documentScope && scope.documentScope.length > 0
      ? new Set(scope.documentScope)
      : undefined;
    const inScope = scopedDocuments
      ? temporalContexts.filter((chunk) => scopedDocuments.has(chunk.documentId))
      : temporalContexts;
    if (scope.metadataRules.length === 0) {
      return inScope;
    }
    const passing = new Set(
      this.metadataRuleScoringService
        .apply({ candidates: inScope.map(toTemporalCandidate), metadataRules: scope.metadataRules })
        .candidates.map((candidate) => candidate.chunkId),
    );
    return inScope.filter((chunk) => passing.has(chunk.chunkId));
  }

  private applyResolvedCandidateOrdering(
    input: CandidateRetrievalStageResult,
    candidates: RetrievedCandidate[],
  ): RetrievedCandidate[] {
    const clauses = getContextSelectionClauses(input.shapeSelection?.resolvedRun);
    if (clauses.ranking.lexicalBias !== "preferred") {
      return candidates;
    }

    // The preference is for chunks that hold the looked-up term; a partial match does not.
    const preferredLexicalScore = (candidate: RetrievedCandidate): number =>
      isSomeTermsLexicalMatch(candidate) ? 0 : candidate.lexicalScore;
    return [...candidates].sort((left, right) => {
      const leftHasLexical = preferredLexicalScore(left) > 0 ? 1 : 0;
      const rightHasLexical = preferredLexicalScore(right) > 0 ? 1 : 0;
      if (leftHasLexical !== rightHasLexical) {
        return rightHasLexical - leftHasLexical;
      }
      if (preferredLexicalScore(left) !== preferredLexicalScore(right)) {
        return preferredLexicalScore(right) - preferredLexicalScore(left);
      }
      return getCandidateFusedScore(right) - getCandidateFusedScore(left);
    });
  }
}
