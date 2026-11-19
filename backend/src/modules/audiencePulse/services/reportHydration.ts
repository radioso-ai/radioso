import { AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT, AudiencePulseReportValidationError } from "../domain/report.js";
import type { AudiencePulseStoredReport } from "../domain/report.js";
import type { AudiencePulseAnswerStatus, AudiencePulseAnswerSummary } from "../domain/answerStatus.js";
import type {
  AudiencePulseHydratedEvidence,
  AudiencePulseHydratedReport,
  AudiencePulseTopicState,
} from "../contracts.js";
import { hydrateThemeEvidence } from "./themeEvidence.js";

/*
 * Maps a stored snapshot report onto the response shape, including reports saved before a field
 * existed.
 */

type LegacyAudiencePulseStoredTheme = Omit<
  AudiencePulseStoredReport["themes"][number],
  "memberCount" | "previousMemberCount" | "previousShare" | "transition" | "share"
> & {
  memberCount?: number;
  previousMemberCount?: number | null;
  previousShare?: number | null;
  transition?: AudiencePulseStoredReport["themes"][number]["transition"];
  sampleCount?: number;
  share?: number;
};
export type LegacyAudiencePulseStoredReport = Omit<
  AudiencePulseStoredReport,
  | "narrativeGeneratedAt"
  | "narrativeReuseCount"
  | "narrativeReuseMaxDrift"
  | "isFirstCensus"
  | "unclassifiedQuestionCount"
  | "dissolvedTopics"
  | "coverage"
  | "themes"
> & {
  narrativeGeneratedAt?: string;
  narrativeReuseCount?: number;
  narrativeReuseMaxDrift?: number;
  isFirstCensus?: boolean;
  unclassifiedQuestionCount?: number;
  dissolvedTopics?: AudiencePulseStoredReport["dissolvedTopics"];
  coverage: AudiencePulseStoredReport["coverage"] & { facetReadyQuestionCount?: number };
  themes: LegacyAudiencePulseStoredTheme[];
};

interface ThemeAnswers {
  answers: AudiencePulseAnswerSummary;
  /** Undefined when the snapshot stored nothing an example's status could be read from. */
  statusOf: (evidenceId: string) => AudiencePulseAnswerStatus | undefined;
}

/**
 * Snapshots saved before topics carried `answers` stored neither the summary nor a
 * per-example status. One rule reads both from what they did store, so the counts
 * and the labels agree. With a coverage summary, the recorded verdicts decide, and a
 * scope-boundary decline stays in the partly answered or unanswered count where that
 * snapshot put it. Without one, the topic's grounding counts decide; no per-example
 * grounding was stored, so those examples carry no status.
 */
const legacyThemeAnswers = (theme: LegacyAudiencePulseStoredTheme): ThemeAnswers => {
  const { coverage, coverageByEvidenceId } = theme;
  if (coverage) {
    return {
      answers: {
        answered: coverage.answered,
        partial: coverage.partial,
        unanswered: coverage.unanswered,
        unclear: coverage.unclear,
        outOfScope: 0,
        notAssessed: coverage.unassessed + coverage.legacy,
      },
      statusOf: (evidenceId) => {
        const assessment = coverageByEvidenceId?.[evidenceId];
        return assessment?.availability === "assessed" ? assessment.coverage : "not_assessed";
      },
    };
  }
  const { grounding } = theme;
  return {
    answers: {
      answered: grounding.grounded,
      partial: grounding.degraded,
      unanswered: grounding.noSupport,
      unclear: 0,
      outOfScope: 0,
      notAssessed: grounding.unknown,
    },
    statusOf: () => undefined,
  };
};

const themeAnswers = (theme: LegacyAudiencePulseStoredTheme): ThemeAnswers => {
  if (!theme.answers) return legacyThemeAnswers(theme);
  const statuses = theme.answerStatusByEvidenceId;
  return { answers: theme.answers, statusOf: (evidenceId) => statuses?.[evidenceId] };
};

/** The whole-window counts, copied when the snapshot has them and left absent when it predates them. */
const hydrateWholeWindowCounts = (report: AudiencePulseStoredReport): Pick<
  AudiencePulseHydratedReport,
  "totals" | "dailyVolume" | "previousPeriod" | "channels" | "previousGeneratedAt"
> => ({
  ...(report.totals ? { totals: report.totals } : {}),
  ...(report.dailyVolume ? { dailyVolume: report.dailyVolume } : {}),
  ...(report.previousPeriod !== undefined ? { previousPeriod: report.previousPeriod } : {}),
  ...(report.channels ? { channels: report.channels } : {}),
  ...(report.previousGeneratedAt !== undefined ? { previousGeneratedAt: report.previousGeneratedAt } : {}),
});

const hydrateContentGaps = (
  contentGaps: AudiencePulseStoredReport["contentGaps"],
  topicStates: ReadonlyMap<string, AudiencePulseTopicState>,
): AudiencePulseHydratedReport["contentGaps"] => contentGaps.map((gap) => {
  const state = topicStates.get(gap.themeId);
  return {
    themeId: gap.themeId,
    eligibleEvidenceCount: gap.eligibleEvidenceCount,
    distinctConversationCount: gap.distinctConversationCount,
    dismissedAt: state?.dismissedAt?.toISOString() ?? null,
    latestDraft: state?.latestDraft
      ? { documentId: state.latestDraft.documentId, createdAt: state.latestDraft.createdAt.toISOString() }
      : null,
  };
});

/**
 * `topicStates` is the operator's state on the report's content-gap topics, read at request time:
 * the snapshot never stores it, so a refresh cannot drop it.
 */
export const hydrateReport = (
  report: AudiencePulseStoredReport,
  evidenceById: Map<string, AudiencePulseHydratedEvidence>,
  topicStates: ReadonlyMap<string, AudiencePulseTopicState>,
): AudiencePulseHydratedReport => {
  const resolve = (evidenceId: string): AudiencePulseHydratedEvidence => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      throw new AudiencePulseReportValidationError("A saved report source could not be rehydrated");
    }
    return evidence;
  };

  const legacyReport = report as LegacyAudiencePulseStoredReport;
  const populationSize = legacyReport.coverage.populationSize;
  const groupedEvidenceIds = new Set(legacyReport.themes.flatMap((theme) => theme.evidenceIds));
  const unclassifiedQuestionCount = typeof legacyReport.unclassifiedQuestionCount === "number"
    ? legacyReport.unclassifiedQuestionCount
    : [...evidenceById.keys()].filter((evidenceId) => !groupedEvidenceIds.has(evidenceId)).length;
  const coverage = {
    ...legacyReport.coverage,
    facetReadyQuestionCount: legacyReport.coverage.facetReadyQuestionCount
      ?? legacyReport.coverage.sampleSize
      ?? populationSize,
  };

  return {
    period: report.period,
    generatedAt: report.generatedAt,
    isFirstCensus: legacyReport.isFirstCensus ?? false,
    narrativeGeneratedAt: legacyReport.narrativeGeneratedAt ?? report.generatedAt,
    narrativeReuseCount: legacyReport.narrativeReuseCount ?? 0,
    narrativeReuseMaxDrift: legacyReport.narrativeReuseMaxDrift ?? AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT,
    coverage,
    weeklyVolume: report.weeklyVolume,
    summary: report.summary,
    // Computed once, in `buildAudiencePulseReport`, against the population -- not
    // reconstructed here from whichever evidence ids happened to rehydrate.
    unclassifiedQuestionCount,
    dissolvedTopics: (legacyReport.dissolvedTopics ?? []).map((topic) => ({ ...topic })),
    themes: legacyReport.themes.map((theme) => {
      const legacyTheme: LegacyAudiencePulseStoredTheme = theme;
      const { answers, statusOf } = themeAnswers(legacyTheme);
      const memberCount = legacyTheme.memberCount ?? legacyTheme.sampleCount ?? theme.evidenceIds.length;
      const share = legacyTheme.share ?? (populationSize === 0 ? 0 : memberCount / populationSize);
      return {
        id: theme.id,
        title: theme.title,
        description: theme.description,
        memberCount,
        previousMemberCount: theme.previousMemberCount ?? null,
        previousShare: theme.previousShare ?? null,
        transition: theme.transition ? {
          ...theme.transition,
          membershipOverlap: theme.transition.membershipOverlap ?? null,
        } : null,
        share,
        ...hydrateThemeEvidence(theme.evidenceIds, resolve, statusOf, theme.coverageByEvidenceId),
        weeklyPulse: theme.weeklyPulse,
        grounding: theme.grounding,
        ...(theme.coverage ? { coverage: theme.coverage } : {}),
        answers,
      };
    }),
    contentGaps: hydrateContentGaps(report.contentGaps, topicStates),
    recommendations: report.recommendations.map((recommendation) => ({
      id: recommendation.id,
      themeId: recommendation.themeId,
      title: recommendation.title,
      rationale: recommendation.rationale,
      questions: recommendation.questions,
      evidenceReferences: recommendation.evidenceIds.map((id) => resolve(id).evidenceId),
      startDraft: {
        title: recommendation.title,
        questions: recommendation.questions,
      },
    })),
    caveats: report.caveats,
    ...hydrateWholeWindowCounts(report),
  };
};
