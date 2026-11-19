import type { AudiencePulseEvidence, AudiencePulseStoredReport } from "../domain/report.js";
import { AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT } from "../domain/report.js";
import type { AudiencePulseSnapshotRecord } from "../contracts.js";
import type { CensusRunResult, CensusRunTopicResult } from "./censusService.js";
import { AUDIENCE_PULSE_SUMMARY_MAX_TOPICS } from "./prompt.js";
import type { LegacyAudiencePulseStoredReport } from "./reportHydration.js";

/*
 * Whether a refresh may carry the prior snapshot's narrative forward, and the prior topic counts
 * and shares a fresh report compares against.
 */

/** One or two questions are treated as integer noise even when their ratio is large. */
export const AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_ABSOLUTE_MOVEMENT = 3;
export const AUDIENCE_PULSE_NARRATIVE_MAX_CONSECUTIVE_REUSES = 3;
/**
 * Reuse requires more than 80% mutual retention of full topic membership. This
 * mirrors the existing 20% drift boundary while refusing equality at the boundary;
 * display evidence is intentionally irrelevant to this decision.
 */
export const AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_MEMBERSHIP_OVERLAP = 0.8;

/** Richest-member topic first, ties broken by id for a deterministic, stable order. */
export const richestFirst = (topics: readonly CensusRunTopicResult[]): CensusRunTopicResult[] =>
  [...topics].sort((a, b) => b.memberCount - a.memberCount || a.topicId.localeCompare(b.topicId));

export const previousThemeMemberCounts = (snapshot: AudiencePulseSnapshotRecord | null): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const theme of snapshot?.report.themes ?? []) {
    if (typeof theme.memberCount === "number") {
      counts.set(theme.id, theme.memberCount);
    }
  }
  return counts;
};

export const previousThemeShares = (snapshot: AudiencePulseSnapshotRecord | null): Map<string, number> => {
  const shares = new Map<string, number>();
  for (const theme of snapshot?.report.themes ?? []) {
    if (typeof theme.share === "number") {
      shares.set(theme.id, theme.share);
    }
  }
  return shares;
};

const reachesNarrativeDriftGate = (absoluteMovement: number, relativeMovement: number): boolean =>
  absoluteMovement >= AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_ABSOLUTE_MOVEMENT
  && relativeMovement >= AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT;

type AudiencePulseNarrativeSnapshot = AudiencePulseSnapshotRecord & {
  report: AudiencePulseStoredReport & { summary: string };
};

export const reusableNarrativeSnapshot = (input: {
  snapshot: AudiencePulseSnapshotRecord | null;
  censusResult: CensusRunResult;
  currentEvidenceById: ReadonlyMap<string, AudiencePulseEvidence>;
  populationSize: number;
  unclassifiedQuestionCount: number;
  contentGapThemeIds: readonly string[];
  recommendationEvidenceIdsByThemeId: ReadonlyMap<string, readonly string[]>;
}): AudiencePulseNarrativeSnapshot | null => {
  const {
    snapshot,
    censusResult,
    currentEvidenceById,
    populationSize,
    unclassifiedQuestionCount,
    contentGapThemeIds,
    recommendationEvidenceIdsByThemeId,
  } = input;
  if (!snapshot || typeof snapshot.report.summary !== "string" || snapshot.report.summary.trim().length === 0) {
    return null;
  }
  if (!snapshot.report.censusRunId
    || snapshot.report.censusRunId !== censusResult.membershipBaselineRunId) {
    return null;
  }
  const legacyReport = snapshot.report as LegacyAudiencePulseStoredReport;
  if ((legacyReport.narrativeReuseCount ?? 0) >= AUDIENCE_PULSE_NARRATIVE_MAX_CONSECUTIVE_REUSES) {
    return null;
  }
  if (!censusResult.fullyFacetReady || censusResult.topics.length === 0) {
    return null;
  }
  if (censusResult.topics.some((topic) =>
    topic.transition?.kind !== "survived" || topic.transition.viaCentroidFallback)) {
    return null;
  }
  if (censusResult.topics.some((topic) =>
    topic.transition?.membershipOverlap === null
    || topic.transition?.membershipOverlap === undefined
    || topic.transition.membershipOverlap <= AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_MEMBERSHIP_OVERLAP)) {
    return null;
  }
  if (censusResult.dissolvedTopicIds.length > 0) {
    return null;
  }

  const currentNarrativeTopicIds = richestFirst(censusResult.topics)
    .slice(0, AUDIENCE_PULSE_SUMMARY_MAX_TOPICS)
    .map((topic) => topic.topicId);
  const priorNarrativeTopicIds = snapshot.report.themes
    .slice(0, AUDIENCE_PULSE_SUMMARY_MAX_TOPICS)
    .map((theme) => theme.id);
  if (currentNarrativeTopicIds.length !== priorNarrativeTopicIds.length
    || currentNarrativeTopicIds.some((topicId, index) => topicId !== priorNarrativeTopicIds[index])) {
    return null;
  }

  const priorCounts = previousThemeMemberCounts(snapshot);
  const priorShares = previousThemeShares(snapshot);
  const topicDrifts = censusResult.topics.map((topic) => {
    const previousMemberCount = priorCounts.get(topic.topicId);
    const previousShare = priorShares.get(topic.topicId);
    if (previousMemberCount === undefined || previousShare === undefined) {
      return null;
    }
    const countMovement = Math.abs(topic.memberCount - previousMemberCount);
    const countDrift = countMovement / Math.max(previousMemberCount, 1);
    const currentShare = topic.memberCount / populationSize;
    const shareDrift = previousShare === 0
      ? currentShare === 0 ? 0 : Infinity
      : Math.abs(currentShare - previousShare) / previousShare;
    return { countMovement, countDrift, shareDrift };
  });
  if (topicDrifts.some((drift) => drift === null
    || reachesNarrativeDriftGate(drift.countMovement, drift.countDrift))) {
    return null;
  }
  if (topicDrifts.some((drift) => drift !== null
    && reachesNarrativeDriftGate(drift.countMovement, drift.shareDrift))) {
    return null;
  }

  const currentMemberIdsByTopicId = new Map(
    censusResult.topics.map((topic) => [topic.topicId, new Set(topic.memberIds)]),
  );
  if (snapshot.report.themes.some((theme) => {
    const currentMemberIds = currentMemberIdsByTopicId.get(theme.id);
    return currentMemberIds === undefined
      || theme.evidenceIds.some((evidenceId) => !currentMemberIds.has(evidenceId));
  })) {
    return null;
  }

  const priorPopulationSize = snapshot.report.coverage.populationSize;
  const populationMovement = typeof priorPopulationSize === "number"
    ? Math.abs(populationSize - priorPopulationSize)
    : Infinity;
  if (typeof priorPopulationSize !== "number"
    || reachesNarrativeDriftGate(
      populationMovement,
      populationMovement / Math.max(priorPopulationSize, 1),
    )) {
    return null;
  }

  // Snapshots written before this field exists cannot prove that unclassified demand
  // stayed stable, so their narratives are regenerated.
  const priorUnclassifiedQuestionCount = snapshot.report.unclassifiedQuestionCount;
  const unclassifiedMovement = typeof priorUnclassifiedQuestionCount === "number"
    ? Math.abs(unclassifiedQuestionCount - priorUnclassifiedQuestionCount)
    : Infinity;
  if (typeof priorUnclassifiedQuestionCount !== "number"
    || reachesNarrativeDriftGate(
      unclassifiedMovement,
      unclassifiedMovement / Math.max(priorUnclassifiedQuestionCount, 1),
    )) {
    return null;
  }

  // A snapshot predating content gaps cannot prove which topics qualified, so its
  // narrative is regenerated rather than trusted -- the same treatment absent legacy
  // fields get above.
  const priorContentGaps = snapshot.report.contentGaps as AudiencePulseStoredReport["contentGaps"] | undefined;
  if (priorContentGaps === undefined) {
    return null;
  }
  const priorContentGapThemeIds = new Set(priorContentGaps.map((gap) => gap.themeId));
  if (priorContentGapThemeIds.size !== contentGapThemeIds.length
    || contentGapThemeIds.some((themeId) => !priorContentGapThemeIds.has(themeId))) {
    return null;
  }

  if (snapshot.report.recommendations.some((recommendation) => {
    const currentMemberIds = currentMemberIdsByTopicId.get(recommendation.themeId);
    const selectedEvidenceIds = recommendationEvidenceIdsByThemeId.get(recommendation.themeId);
    return currentMemberIds === undefined
      || selectedEvidenceIds === undefined
      || recommendation.evidenceIds.length !== selectedEvidenceIds.length
      || recommendation.evidenceIds.some((evidenceId, index) =>
        evidenceId !== selectedEvidenceIds[index]
        || !currentMemberIds.has(evidenceId)
        || !currentEvidenceById.get(evidenceId)?.contentGapEligible);
  })) {
    return null;
  }

  return snapshot as AudiencePulseNarrativeSnapshot;
};
