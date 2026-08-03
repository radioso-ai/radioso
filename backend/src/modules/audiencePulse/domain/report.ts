import { z } from "zod";

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
  sampleCount: number;
  weeklyPulse: Array<{ weekStart: string; count: number }>;
  grounding: AudiencePulseGroundingSummary;
}

export interface AudiencePulseStoredRecommendation {
  id: string;
  themeId: string;
  title: string;
  rationale: string;
  questions: string[];
  evidenceIds: string[];
}

export interface AudiencePulseStoredReport {
  period: { start: string; end: string };
  generatedAt: string;
  coverage: AudiencePulseCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  summary: string;
  themes: AudiencePulseStoredTheme[];
  contentGaps: Array<{
    themeId: string;
    eligibleEvidenceCount: number;
    distinctConversationCount: number;
  }>;
  recommendations: AudiencePulseStoredRecommendation[];
  caveats: string[];
}

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const evidenceIdsSchema = (minimum: number) => z.array(z.string().trim().min(1).max(80)).min(minimum).max(12);

export const audiencePulseModelOutputSchema = z.object({
  summary: boundedText(600),
  themes: z.array(z.object({
    title: boundedText(120),
    description: boundedText(500),
    evidenceIds: evidenceIdsSchema(2),
  }).strict()).max(8),
  recommendations: z.array(z.object({
    themeIndex: z.number().int().min(0).max(7),
    title: boundedText(160),
    rationale: boundedText(500),
    questions: z.array(boundedText(240)).min(1).max(8),
    evidenceIds: evidenceIdsSchema(2),
  }).strict()).max(8),
  caveats: z.array(boundedText(320)).max(6),
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

const recurringGap = (items: AudiencePulseEvidence[]): {
  eligibleEvidenceCount: number;
  distinctConversationCount: number;
  qualifies: boolean;
} => {
  const eligible = items.filter((item) => item.contentGapEligible);
  const distinctConversationCount = new Set(eligible.map((item) => item.reference.conversationId)).size;
  return {
    eligibleEvidenceCount: eligible.length,
    distinctConversationCount,
    qualifies: eligible.length >= 2 && distinctConversationCount >= 2,
  };
};

const pickRecurringContentGapEvidenceIds = (
  theme: AudiencePulseStoredTheme,
  evidenceById: Map<string, AudiencePulseEvidence>,
): string[] => {
  const conversationIds = new Set<string>();
  const evidenceIds: string[] = [];
  for (const evidenceId of theme.evidenceIds) {
    const item = evidenceById.get(evidenceId);
    if (!item?.contentGapEligible || conversationIds.has(item.reference.conversationId)) continue;
    evidenceIds.push(evidenceId);
    conversationIds.add(item.reference.conversationId);
    if (evidenceIds.length === 2) return evidenceIds;
  }
  return [];
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

export const buildAudiencePulseReport = (input: {
  period: { start: Date; end: Date };
  generatedAt: Date;
  coverage: AudiencePulseCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  evidence: AudiencePulseEvidence[];
  model: AudiencePulseModelOutput;
}): AudiencePulseStoredReport => {
  const model = audiencePulseModelOutputSchema.parse(input.model);
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  if (evidenceById.size !== input.evidence.length) {
    throw new AudiencePulseReportValidationError("Submitted evidence ids must be unique");
  }

  const claimedThemeEvidence = new Set<string>();
  const themes = model.themes.map((theme, themeIndex): AudiencePulseStoredTheme => {
    if (theme.evidenceIds.length < 2) {
      throw new AudiencePulseReportValidationError("A discussion theme must contain at least two evidence items");
    }
    const items = resolveEvidence(theme.evidenceIds, evidenceById, "Theme");
    for (const id of theme.evidenceIds) {
      if (claimedThemeEvidence.has(id)) {
        throw new AudiencePulseReportValidationError("Evidence may not belong to more than one theme");
      }
      claimedThemeEvidence.add(id);
    }
    return {
      id: `theme-${themeIndex + 1}`,
      title: theme.title,
      description: theme.description,
      evidenceIds: [...theme.evidenceIds],
      sampleCount: items.length,
      weeklyPulse: createWeeklyPulse(items, input.weeklyVolume),
      grounding: groundingSummary(items),
    };
  });

  const contentGaps = themes.flatMap((theme) => {
    const gap = recurringGap(resolveEvidence(theme.evidenceIds, evidenceById, "Theme"));
    return gap.qualifies ? [{
      themeId: theme.id,
      eligibleEvidenceCount: gap.eligibleEvidenceCount,
      distinctConversationCount: gap.distinctConversationCount,
    }] : [];
  });

  const recommendations = model.recommendations.flatMap((recommendation, recommendationIndex): AudiencePulseStoredRecommendation[] => {
    const parentTheme = themes[recommendation.themeIndex];
    if (!parentTheme) {
      throw new AudiencePulseReportValidationError("Recommendation references an unknown theme");
    }
    const parentEvidence = new Set(parentTheme.evidenceIds);
    const items = resolveEvidence(recommendation.evidenceIds, evidenceById, "Recommendation");
    if (!recommendation.evidenceIds.every((id) => parentEvidence.has(id))) {
      throw new AudiencePulseReportValidationError("Recommendation evidence must be a subset of its parent theme");
    }
    const gap = recurringGap(items);
    const evidenceIds = gap.qualifies
      ? [...recommendation.evidenceIds]
      : pickRecurringContentGapEvidenceIds(parentTheme, evidenceById);
    if (evidenceIds.length === 0) return [];
    return [{
      id: `recommendation-${recommendationIndex + 1}`,
      themeId: parentTheme.id,
      title: recommendation.title,
      rationale: recommendation.rationale,
      questions: [...recommendation.questions],
      evidenceIds,
    }];
  });

  return {
    period: {
      start: input.period.start.toISOString(),
      end: input.period.end.toISOString(),
    },
    generatedAt: input.generatedAt.toISOString(),
    coverage: input.coverage,
    weeklyVolume: input.weeklyVolume.map((week) => ({ ...week })),
    summary: model.summary,
    themes,
    contentGaps,
    recommendations,
    caveats: [...model.caveats],
  };
};

export const parseAudiencePulseModelOutput = (value: unknown): AudiencePulseModelOutput =>
  audiencePulseModelOutputSchema.parse(value);
