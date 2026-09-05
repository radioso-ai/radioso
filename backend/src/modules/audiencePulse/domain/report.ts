import { z } from "zod";

import type { TopicTransition } from "../contracts/topicCensus.js";
import {
  AUDIENCE_PULSE_GROUNDING_SIGNALS,
  audiencePulseContentGapEligible,
  type AudiencePulseGroundingSignal,
} from "../../../shared/domain/audiencePulseContentGap.js";

export { AUDIENCE_PULSE_GROUNDING_SIGNALS };
export type { AudiencePulseGroundingSignal };

export interface AudiencePulseEvidenceReference {
  messageId: string;
  conversationId: string;
}

export interface AudiencePulseEvidence {
  id: string;
  reference: AudiencePulseEvidenceReference;
  /** Transient, untrusted prompt evidence. Never persists in a snapshot. */
  question: string;
  weekStart: string;
  channel: string | null;
  grounding: AudiencePulseGroundingSignal;
  contentGapEligible: boolean;
}

export interface AudiencePulseWeeklyVolume {
  weekStart: string;
  visitorQuestionCount: number;
  conversationCount: number;
}

export interface AudiencePulseCoverage {
  populationSize: number;
  sampleSize: number;
  sampled: boolean;
}

/**
 * `AudiencePulseCoverage` plus the census's facet-readiness split (spec 956
 * follow-up): `facetReadyQuestionCount` is `CensusRunResult.facetReadyQuestionCount`,
 * how many of `populationSize` questions had a current, embedded facet clustering
 * could actually use. Distinct from `unclassifiedQuestionCount`: a population can be
 * fully facet-ready and still classify into zero topics (every cluster below the
 * size floor), so this is the only field that tells "topic analysis has not run on
 * this window yet" apart from "it ran and found no recurring pattern." Kept apart
 * from `AudiencePulseCoverage` itself because the history source that produces the
 * base coverage has no notion of facets; the report layer is where the two combine.
 */
export interface AudiencePulseReportCoverage extends AudiencePulseCoverage {
  facetReadyQuestionCount: number;
}

export interface AudiencePulseGroundingSummary {
  grounded: number;
  degraded: number;
  noSupport: number;
  unknown: number;
  contentGapEligible: number;
}

export interface AudiencePulseStoredTheme {
  id: string;
  title: string;
  description: string;
  evidenceIds: string[];
  /** Exact count of population questions assigned to this topic -- never a sample. */
  memberCount: number;
  /** Exact count assigned to the same topic in the prior stored snapshot, if available. */
  previousMemberCount: number | null;
  /** The same topic's share in the prior stored snapshot, if it was present there. */
  previousShare: number | null;
  /** Identity classification persisted for this topic in this census run. */
  transition: TopicTransition | null;
  /** `memberCount / populationSize`, computed in code from the same membership. */
  share: number;
  weeklyPulse: Array<{ weekStart: string; count: number }>;
  grounding: AudiencePulseGroundingSummary;
}

/**
 * One topic as the census names and populates it (spec 956): a stable identity, an
 * operator-visible label, and its exact member evidence ids -- every population
 * question the clustering step assigned to it, not a model-picked subset. `buildAudiencePulseReport`
 * derives `memberCount`/`share`/`weeklyPulse` from `evidenceIds` resolved against the
 * full window population; it never trusts a pre-computed count.
 */
export interface AudiencePulseCensusTopic {
  id: string;
  title: string;
  description: string;
  evidenceIds: string[];
  /** Optional only for callers constructed before transition persistence existed. */
  transition?: TopicTransition | null;
}

export interface AudiencePulseStoredRecommendation {
  id: string;
  themeId: string;
  title: string;
  rationale: string;
  questions: string[];
  evidenceIds: string[];
}

export interface AudiencePulseDissolvedTopic {
  id: string;
  title: string;
}

/** Ratio used by the backend when deciding whether a prior narrative remains reusable. */
export const AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT = 0.2;

export interface AudiencePulseStoredReport {
  period: { start: string; end: string };
  generatedAt: string;
  /** Internal persistence link to the census run whose data this report renders. */
  censusRunId?: string;
  /** True only when the census found no prior topics to match against. */
  isFirstCensus: boolean;
  narrativeGeneratedAt: string;
  narrativeReuseCount: number;
  /** Exact relative-drift threshold used for this report's narrative reuse decision. */
  narrativeReuseMaxDrift: number;
  coverage: AudiencePulseReportCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  /**
   * Absent when no narrative call ran (`buildAudiencePulseComputingReport`, spec 956
   * follow-up: `coverage.facetReadyQuestionCount === 0`) -- there is nothing computed
   * yet for the model to summarize, so this stays unset rather than holding an
   * invented audience conclusion or a hardcoded stand-in string.
   */
  summary?: string;
  /** Population questions claimed by no topic, measured against the population -- never the sample. */
  unclassifiedQuestionCount: number;
  /** Topics retired by this census run. They have no current-run membership or member count. */
  dissolvedTopics: AudiencePulseDissolvedTopic[];
  themes: AudiencePulseStoredTheme[];
  contentGaps: Array<{
    themeId: string;
    eligibleEvidenceCount: number;
    distinctConversationCount: number;
  }>;
  recommendations: AudiencePulseStoredRecommendation[];
  caveats: string[];
}

export const AUDIENCE_PULSE_MODEL_TEXT_LIMITS = {
  summary: 300,
  themeTitle: 120,
  themeDescription: 250,
  recommendationTitle: 160,
  recommendationRationale: 250,
  question: 240,
  caveat: 160,
} as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const evidenceIdsSchema = (minimum: number) => z.array(z.string().trim().min(1).max(80)).min(minimum).max(12);

/**
 * Normalized narrative shape consumed by the report domain. The provider contract in
 * `services/prompt.ts` keys recommendation copy by qualifying topic index so it can
 * require every target exactly once; `audiencePulseService.ts` validates that wire
 * shape and injects `recommendations[].themeIndex` at the boundary. `themes` remains
 * empty and is retained only for compatibility: topic identity and membership come
 * from the census (`AudiencePulseCensusTopic`), never from the model. The report owns
 * recommendation eligibility and evidence; the model writes copy only.
 */
export const audiencePulseModelOutputSchema = z.object({
  summary: boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.summary),
  themes: z.array(z.object({
    title: boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.themeTitle),
    description: boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.themeDescription),
    evidenceIds: evidenceIdsSchema(2),
  }).strict()).max(8),
  recommendations: z.array(z.object({
    themeIndex: z.number().int().min(0).max(7),
    title: boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.recommendationTitle),
    rationale: boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.recommendationRationale),
    questions: z.array(boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.question)).min(1).max(8),
  }).strict()).max(8),
  caveats: z.array(boundedText(AUDIENCE_PULSE_MODEL_TEXT_LIMITS.caveat)).max(6),
}).strict();

export type AudiencePulseModelOutput = z.infer<typeof audiencePulseModelOutputSchema>;

export class AudiencePulseReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudiencePulseReportValidationError";
  }
}

export const contentGapEligible = audiencePulseContentGapEligible;

const ensureUnique = (ids: string[], label: string): void => {
  if (new Set(ids).size !== ids.length) {
    throw new AudiencePulseReportValidationError(`${label} contains duplicate evidence ids`);
  }
};

const groundingSummary = (items: AudiencePulseEvidence[]): AudiencePulseGroundingSummary => {
  const result: AudiencePulseGroundingSummary = {
    grounded: 0,
    degraded: 0,
    noSupport: 0,
    unknown: 0,
    contentGapEligible: 0,
  };

  for (const item of items) {
    if (item.grounding === "grounded") result.grounded += 1;
    if (item.grounding === "degraded") result.degraded += 1;
    if (item.grounding === "no_support") result.noSupport += 1;
    if (item.grounding === "unknown") result.unknown += 1;
    if (item.contentGapEligible) result.contentGapEligible += 1;
  }
  return result;
};

/**
 * Buckets a topic's exact member evidence by real week. Correct by construction as
 * soon as `items` is a topic's real population membership rather than a
 * stratified-equal sample: a topic concentrated in one high-volume week reports that
 * concentration, because every member's true `weekStart` is counted once.
 */
const createWeeklyPulse = (
  evidence: AudiencePulseEvidence[],
  weeklyVolume: AudiencePulseWeeklyVolume[],
): Array<{ weekStart: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const item of evidence) {
    counts.set(item.weekStart, (counts.get(item.weekStart) ?? 0) + 1);
  }
  return weeklyVolume.map((week) => ({
    weekStart: week.weekStart,
    count: counts.get(week.weekStart) ?? 0,
  }));
};

/**
 * Content-gap eligibility scales against a topic's real member count (spec 956
 * FR-012): a flat floor of `CONTENT_GAP_MIN_ELIGIBLE_ABSOLUTE` for small topics, rising
 * to `CONTENT_GAP_MIN_ELIGIBLE_SHARE` of the topic's exact membership once that share
 * exceeds the floor. A handful of ungrounded mentions was a strong signal against a
 * sample capped at a dozen evidence ids; the same handful is noise against a
 * census-sized topic with hundreds of real members.
 */
const CONTENT_GAP_MIN_ELIGIBLE_ABSOLUTE = 2;
const CONTENT_GAP_MIN_ELIGIBLE_SHARE = 0.1;
const CONTENT_GAP_MIN_DISTINCT_CONVERSATIONS = 2;
const AUDIENCE_PULSE_THEME_DISPLAY_EVIDENCE_MAX = 12;

const requiredEligibleCount = (topicMemberCount: number): number =>
  Math.max(CONTENT_GAP_MIN_ELIGIBLE_ABSOLUTE, Math.ceil(topicMemberCount * CONTENT_GAP_MIN_ELIGIBLE_SHARE));

/** Evaluates the recurring content-gap gate against a topic's full membership. */
export const evaluateTopicContentGap = (items: AudiencePulseEvidence[], memberCount: number): {
  eligibleEvidenceCount: number;
  distinctConversationCount: number;
  qualifies: boolean;
} => {
  const eligible = items.filter((item) => item.contentGapEligible);
  const distinctConversationCount = new Set(eligible.map((item) => item.reference.conversationId)).size;
  return {
    eligibleEvidenceCount: eligible.length,
    distinctConversationCount,
    qualifies: eligible.length >= requiredEligibleCount(memberCount)
      && distinctConversationCount >= CONTENT_GAP_MIN_DISTINCT_CONVERSATIONS,
  };
};

const pickRecurringContentGapEvidenceIds = (
  evidenceIds: readonly string[],
  evidenceById: Map<string, AudiencePulseEvidence>,
  maximum = 6,
): string[] => {
  const conversationIds = new Set<string>();
  const selected: string[] = [];
  for (const evidenceId of evidenceIds) {
    const item = evidenceById.get(evidenceId);
    if (!item?.contentGapEligible || conversationIds.has(item.reference.conversationId)) continue;
    selected.push(evidenceId);
    conversationIds.add(item.reference.conversationId);
    if (selected.length === maximum) return selected;
  }
  return selected;
};

const resolveEvidence = (
  ids: string[],
  evidenceById: Map<string, AudiencePulseEvidence>,
  label: string,
): AudiencePulseEvidence[] => {
  ensureUnique(ids, label);
  return ids.map((id) => {
    const item = evidenceById.get(id);
    if (!item) {
      throw new AudiencePulseReportValidationError(`${label} references unknown evidence id`);
    }
    return item;
  });
};

export interface AudiencePulseCensusReport {
  report: AudiencePulseStoredReport;
  /** Current qualifying evidence, keyed by theme, retained only while applying narrative copy. */
  recommendationEvidenceIdsByThemeId: ReadonlyMap<string, readonly string[]>;
}

/**
 * Computes the report's census-owned data exactly once. `topics` carries exact real
 * membership and `population` contains every eligible question in the window, so all
 * counts, shares, weekly buckets, gaps, and recommendation evidence come from current
 * data rather than model output.
 */
export const buildAudiencePulseCensusReport = (input: {
  period: { start: Date; end: Date };
  generatedAt: Date;
  isFirstCensus: boolean;
  coverage: AudiencePulseReportCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  population: AudiencePulseEvidence[];
  topics: AudiencePulseCensusTopic[];
  dissolvedTopics?: AudiencePulseDissolvedTopic[];
  previousThemeMemberCounts?: Map<string, number>;
  previousThemeShares?: Map<string, number>;
}): AudiencePulseCensusReport => {
  const evidenceById = new Map(input.population.map((item) => [item.id, item]));
  if (evidenceById.size !== input.population.length) {
    throw new AudiencePulseReportValidationError("Submitted population evidence ids must be unique");
  }
  const populationSize = input.population.length;

  const claimedTopicEvidence = new Set<string>();
  const memberEvidenceIdsByTopicId = new Map<string, string[]>();
  const themes = input.topics.map((topic): AudiencePulseStoredTheme => {
    if (topic.evidenceIds.length < 2) {
      throw new AudiencePulseReportValidationError("A topic must contain at least two member questions");
    }
    const items = resolveEvidence(topic.evidenceIds, evidenceById, "Topic");
    for (const id of topic.evidenceIds) {
      if (claimedTopicEvidence.has(id)) {
        throw new AudiencePulseReportValidationError("A question may not belong to more than one topic");
      }
      claimedTopicEvidence.add(id);
    }
    const memberCount = items.length;
    const memberEvidenceIds = [...topic.evidenceIds];
    memberEvidenceIdsByTopicId.set(topic.id, memberEvidenceIds);
    return {
      id: topic.id,
      title: topic.title,
      description: topic.description,
      evidenceIds: memberEvidenceIds.slice(0, AUDIENCE_PULSE_THEME_DISPLAY_EVIDENCE_MAX),
      memberCount,
      previousMemberCount: input.previousThemeMemberCounts?.get(topic.id) ?? null,
      previousShare: input.previousThemeShares?.get(topic.id) ?? null,
      transition: topic.transition ?? null,
      share: populationSize === 0 ? 0 : memberCount / populationSize,
      weeklyPulse: createWeeklyPulse(items, input.weeklyVolume),
      grounding: groundingSummary(items),
    };
  });

  const unclassifiedQuestionCount = populationSize - claimedTopicEvidence.size;

  const contentGaps = themes.flatMap((theme) => {
    const memberEvidenceIds = memberEvidenceIdsByTopicId.get(theme.id) ?? [];
    const gap = evaluateTopicContentGap(resolveEvidence(memberEvidenceIds, evidenceById, "Topic"), theme.memberCount);
    return gap.qualifies ? [{
      themeId: theme.id,
      eligibleEvidenceCount: gap.eligibleEvidenceCount,
      distinctConversationCount: gap.distinctConversationCount,
    }] : [];
  });

  const recommendationEvidenceIdsByThemeId = new Map<string, readonly string[]>();
  for (const gap of contentGaps) {
    const parentTheme = themes.find((theme) => theme.id === gap.themeId)!;
    const parentMemberEvidenceIds = memberEvidenceIdsByTopicId.get(parentTheme.id) ?? [];
    const evidenceIds = pickRecurringContentGapEvidenceIds(parentMemberEvidenceIds, evidenceById);
    if (evidenceIds.length >= CONTENT_GAP_MIN_ELIGIBLE_ABSOLUTE) {
      recommendationEvidenceIdsByThemeId.set(parentTheme.id, evidenceIds);
    }
  }

  return {
    report: {
      period: {
        start: input.period.start.toISOString(),
        end: input.period.end.toISOString(),
      },
      generatedAt: input.generatedAt.toISOString(),
      isFirstCensus: input.isFirstCensus,
      narrativeGeneratedAt: input.generatedAt.toISOString(),
      narrativeReuseCount: 0,
      narrativeReuseMaxDrift: AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT,
      coverage: input.coverage,
      weeklyVolume: input.weeklyVolume.map((week) => ({ ...week })),
      unclassifiedQuestionCount,
      dissolvedTopics: (input.dissolvedTopics ?? []).map((topic) => ({ ...topic })),
      themes,
      contentGaps,
      recommendations: [],
      caveats: [],
    },
    recommendationEvidenceIdsByThemeId,
  };
};

/** Applies model-authored copy to a previously computed census report. */
export const applyAudiencePulseNarrative = (input: {
  census: AudiencePulseCensusReport;
  generatedAt: Date;
  model: AudiencePulseModelOutput;
}): AudiencePulseStoredReport => {
  const model = audiencePulseModelOutputSchema.parse(input.model);
  const seenThemeIndexes = new Set<number>();
  const recommendations = model.recommendations.flatMap((recommendation, recommendationIndex): AudiencePulseStoredRecommendation[] => {
    const parentTheme = input.census.report.themes[recommendation.themeIndex];
    if (!parentTheme) {
      throw new AudiencePulseReportValidationError("Recommendation references an unknown topic");
    }
    if (seenThemeIndexes.has(recommendation.themeIndex)) {
      throw new AudiencePulseReportValidationError("A recommendation topic may only be referenced once");
    }
    seenThemeIndexes.add(recommendation.themeIndex);
    const evidenceIds = input.census.recommendationEvidenceIdsByThemeId.get(parentTheme.id);
    if (!evidenceIds) return [];
    return [{
      id: `recommendation-${recommendationIndex + 1}`,
      themeId: parentTheme.id,
      title: recommendation.title,
      rationale: recommendation.rationale,
      questions: [...recommendation.questions],
      evidenceIds: [...evidenceIds],
    }];
  });

  return {
    ...input.census.report,
    generatedAt: input.generatedAt.toISOString(),
    narrativeGeneratedAt: input.generatedAt.toISOString(),
    narrativeReuseCount: 0,
    summary: model.summary,
    recommendations,
    caveats: [...model.caveats],
  };
};

/** Convenience composition for callers that do not need to reuse census computation. */
export const buildAudiencePulseReport = (input: {
  period: { start: Date; end: Date };
  generatedAt: Date;
  isFirstCensus: boolean;
  coverage: AudiencePulseReportCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  population: AudiencePulseEvidence[];
  topics: AudiencePulseCensusTopic[];
  dissolvedTopics?: AudiencePulseDissolvedTopic[];
  previousThemeMemberCounts?: Map<string, number>;
  previousThemeShares?: Map<string, number>;
  model: AudiencePulseModelOutput;
}): AudiencePulseStoredReport => applyAudiencePulseNarrative({
  census: buildAudiencePulseCensusReport(input),
  generatedAt: input.generatedAt,
  model: input.model,
});

/**
 * Builds the stored report for a window whose population has no facet-ready question
 * yet (spec 956 follow-up, `coverage.facetReadyQuestionCount === 0`): every eligible
 * question is real, but none has cleared extraction and embedding, so the census could
 * not cluster anything and there is nothing for a narrative call to summarize. Callers
 * skip the model call entirely for this case -- the same precedent an empty population
 * already sets for `no_traffic` -- so `summary` stays absent rather than inventing an
 * audience conclusion from zero computed data. The dashboard renders this state from
 * `coverage.facetReadyQuestionCount`, never from a hardcoded string standing in here.
 */
export const buildAudiencePulseComputingReport = (input: {
  period: { start: Date; end: Date };
  generatedAt: Date;
  isFirstCensus: boolean;
  coverage: AudiencePulseReportCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
}): AudiencePulseStoredReport => ({
  period: {
    start: input.period.start.toISOString(),
    end: input.period.end.toISOString(),
  },
  generatedAt: input.generatedAt.toISOString(),
  isFirstCensus: input.isFirstCensus,
  narrativeGeneratedAt: input.generatedAt.toISOString(),
  narrativeReuseCount: 0,
  narrativeReuseMaxDrift: AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT,
  coverage: input.coverage,
  weeklyVolume: input.weeklyVolume.map((week) => ({ ...week })),
  unclassifiedQuestionCount: input.coverage.populationSize,
  dissolvedTopics: [],
  themes: [],
  contentGaps: [],
  recommendations: [],
  caveats: [],
});

export const parseAudiencePulseModelOutput = (value: unknown): AudiencePulseModelOutput =>
  audiencePulseModelOutputSchema.parse(value);
