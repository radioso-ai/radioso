import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import type { UsageLimitPolicy, UsageLimitReservation } from "../../../shared/domain/usageLimitPolicy.js";
import { isUsageLimitExceededError } from "../../../shared/domain/usageLimitPolicy.js";
import type {
  AudiencePulseCensusTopic,
  AudiencePulseEvidence,
  AudiencePulseModelOutput,
  AudiencePulseReportCoverage,
  AudiencePulseStoredReport,
} from "../domain/report.js";
import {
  AudiencePulseReportValidationError,
  buildAudiencePulseComputingReport,
  buildAudiencePulseReport,
  parseAudiencePulseModelOutput,
} from "../domain/report.js";
import type {
  AudiencePulseAuditPort,
  AudiencePulseEvidenceAnchor,
  AudiencePulseFacetDrainPort,
  AudiencePulseHistorySource,
  AudiencePulseHydratedEvidence,
  AudiencePulseHydratedReport,
  AudiencePulseInferenceFactory,
  AudiencePulsePort,
  AudiencePulsePromptEvidenceReference,
  AudiencePulseRefreshRateLimitPort,
  AudiencePulseReadResult,
  AudiencePulseRefreshResult,
  AudiencePulseRunGate,
  AudiencePulseSnapshotRecord,
  AudiencePulseSnapshotStore,
} from "../contracts.js";
import { AUDIENCE_PULSE_ANALYSIS_DAYS } from "../contracts.js";
import type { CensusServiceFactory } from "../infra/censusServiceFactory.js";
import type { CensusRunResult, CensusRunTopicResult } from "./censusService.js";
import {
  AUDIENCE_PULSE_MAX_OUTPUT_TOKENS,
  AUDIENCE_PULSE_MAX_TOTAL_TOKENS,
  AUDIENCE_PULSE_SUMMARY_MAX_EXEMPLARS_PER_TOPIC,
  AUDIENCE_PULSE_SUMMARY_MAX_TOPICS,
  boundAudiencePulseSummaryInputForPrompt,
  buildAudiencePulsePrompt,
  buildAudiencePulseResponseFormat,
  type AudiencePulseSummaryInput,
  type AudiencePulseSummaryTopic,
} from "./prompt.js";

interface SafeLogger {
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface AudiencePulseServiceDependencies {
  historySource: AudiencePulseHistorySource;
  snapshotStore: AudiencePulseSnapshotStore;
  runGate: AudiencePulseRunGate;
  refreshRateLimit: AudiencePulseRefreshRateLimitPort;
  facetDrain?: AudiencePulseFacetDrainPort;
  inferenceFactory: AudiencePulseInferenceFactory;
  usageLimitPolicy: UsageLimitPolicy;
  auditService: AudiencePulseAuditPort;
  logger?: SafeLogger;
  now?: () => Date;
  /**
   * Builds a workspace-scoped `CensusService` (spec 956): `refresh()` calls
   * `create(...).run(...)` to cluster the full window population into exact topics
   * before it ever prompts a model for a narrative.
   */
  censusServiceFactory: CensusServiceFactory;
}

// A refresh is an explicit operator action, so it drains enough work for the usual
// historical window in one request without making an unbounded request path.
const AUDIENCE_PULSE_REFRESH_FACET_MAX_JOBS = 500;

const safeAudit = async (
  auditService: AudiencePulseAuditPort,
  input: Parameters<AudiencePulseAuditPort["record"]>[0],
): Promise<void> => {
  await auditService.record(input).catch(() => undefined);
};

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");

const isModelValidationError = (error: unknown): boolean =>
  error instanceof AudiencePulseReportValidationError || error instanceof ZodError || error instanceof SyntaxError;

const errorStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
};

type AudiencePulseRefreshFailureOutcome =
  | "provider"
  | "validation"
  | "cancelled"
  | "rate_limited"
  | "rate_limit_unavailable"
  | "internal";

const rateLimitFailureOutcome = (error: unknown): AudiencePulseRefreshFailureOutcome | null => {
  switch (errorStatusCode(error)) {
    case 429:
      return "rate_limited";
    case 503:
      return "rate_limit_unavailable";
    default:
      return null;
  }
};

const unavailableReason = (error: unknown): "provider" | "validation" | "cancelled" => {
  if (isAbortError(error)) return "cancelled";
  if (isModelValidationError(error)) {
    return "validation";
  }
  return "provider";
};

const createHydratedEvidence = (evidence: AudiencePulseEvidence[]): Map<string, AudiencePulseHydratedEvidence> =>
  new Map(evidence.map((item) => [item.id, {
    evidenceId: item.id,
    conversationId: item.reference.conversationId,
    messageId: item.reference.messageId,
    question: item.question,
  }]));

type AudiencePulseThemeResponse = AudiencePulseHydratedReport["themes"][number];
type AudiencePulseEvidenceResponse = AudiencePulseThemeResponse["evidence"][number];

const normalizeQuestionForDisplay = (question: string): string => question
  .trim()
  .replace(/\s+/gu, " ");

const questionDisplayKey = (question: string): string => normalizeQuestionForDisplay(question).toLowerCase();

const hydrateThemeEvidence = (
  evidenceIds: string[],
  resolve: (evidenceId: string) => AudiencePulseHydratedEvidence,
): Pick<AudiencePulseThemeResponse, "distinctQuestionCount" | "evidence"> => {
  const occurrences = new Map<string, AudiencePulseEvidenceResponse>();
  for (const evidenceId of evidenceIds) {
    const source = resolve(evidenceId);
    const question = normalizeQuestionForDisplay(source.question);
    const key = questionDisplayKey(question);
    const existing = occurrences.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }
    occurrences.set(key, {
      reference: source.evidenceId,
      conversationId: source.conversationId,
      messageId: source.messageId,
      question,
      occurrenceCount: 1,
    });
  }
  return {
    distinctQuestionCount: occurrences.size,
    evidence: [...occurrences.values()],
  };
};

const hydrateReport = (
  report: AudiencePulseStoredReport,
  evidenceById: Map<string, AudiencePulseHydratedEvidence>,
): AudiencePulseHydratedReport => {
  const resolve = (evidenceId: string): AudiencePulseHydratedEvidence => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      throw new AudiencePulseReportValidationError("A saved report source could not be rehydrated");
    }
    return evidence;
  };

  const legacyReport = report as AudiencePulseStoredReport & {
    unclassifiedQuestionCount?: number;
    coverage: AudiencePulseStoredReport["coverage"] & { facetReadyQuestionCount?: number };
    themes: Array<AudiencePulseStoredReport["themes"][number] & { sampleCount?: number }>;
  };
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
    coverage,
    weeklyVolume: report.weeklyVolume,
    summary: report.summary,
    // Computed once, in `buildAudiencePulseReport`, against the population -- not
    // reconstructed here from whichever evidence ids happened to rehydrate.
    unclassifiedQuestionCount,
    themes: legacyReport.themes.map((theme) => {
      const legacyTheme = theme as AudiencePulseStoredReport["themes"][number] & {
        memberCount?: number;
        sampleCount?: number;
        share?: number;
      };
      const memberCount = legacyTheme.memberCount ?? legacyTheme.sampleCount ?? theme.evidenceIds.length;
      const share = legacyTheme.share ?? (populationSize === 0 ? 0 : memberCount / populationSize);
      return {
        id: theme.id,
        title: theme.title,
        description: theme.description,
        memberCount,
        share,
        ...hydrateThemeEvidence(theme.evidenceIds, resolve),
        weeklyPulse: theme.weeklyPulse,
        grounding: theme.grounding,
      };
    }),
    contentGaps: report.contentGaps,
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
  };
};

const parseModelResult = (text: string): AudiencePulseModelOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AudiencePulseReportValidationError("Audience Pulse model response was not valid JSON");
  }
  try {
    return parseAudiencePulseModelOutput(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AudiencePulseReportValidationError("Audience Pulse model response did not match the approved schema");
    }
    throw error;
  }
};

const promptEvidenceReferences = (evidence: AudiencePulseEvidence[]): AudiencePulsePromptEvidenceReference[] =>
  evidence.map((item) => ({
    evidenceId: item.id,
    messageId: item.reference.messageId,
    conversationId: item.reference.conversationId,
  }));

/** Richest-member topic first, ties broken by id for a deterministic, stable order. */
const richestFirst = (topics: readonly CensusRunTopicResult[]): CensusRunTopicResult[] =>
  [...topics].sort((a, b) => b.memberCount - a.memberCount || a.topicId.localeCompare(b.topicId));

/**
 * Builds this run's real topic membership for `buildAudiencePulseReport` (spec 956
 * FR-005): every topic the census produced, carrying every member id the
 * just-completed run actually assigned to it -- not a subset. `buildAudiencePulseReport`
 * derives `memberCount`/`share`/`weeklyPulse`/`grounding` from this membership against
 * the full population; this function only assembles the membership, never a count.
 */
const censusTopicsFromRun = (input: {
  topics: readonly CensusRunTopicResult[];
}): AudiencePulseCensusTopic[] => richestFirst(input.topics).map((topic) => {
  return { id: topic.topicId, title: topic.title, description: topic.description, evidenceIds: topic.memberIds };
});

/**
 * Builds the narrative call's input (spec 956): the richest
 * `AUDIENCE_PULSE_SUMMARY_MAX_TOPICS` topics, each with a bounded set of real member
 * questions as exemplars, plus an aggregate for whatever topics did not make the cut.
 * `memberCount`/`share` come straight from the census, not from `exemplars.length` --
 * exemplars illustrate a topic, they never resize it.
 */
const buildSummaryTopics = (input: {
  topics: readonly CensusRunTopicResult[];
  evidenceById: ReadonlyMap<string, AudiencePulseEvidence>;
}): { shown: AudiencePulseSummaryTopic[]; additionalTopics: { count: number; share: number } } => {
  const ordered = richestFirst(input.topics);
  const shown = ordered.slice(0, AUDIENCE_PULSE_SUMMARY_MAX_TOPICS).map((topic): AudiencePulseSummaryTopic => {
    const exemplars = topic.memberIds
      .slice(0, AUDIENCE_PULSE_SUMMARY_MAX_EXEMPLARS_PER_TOPIC)
      .flatMap((messageId) => {
        const evidence = input.evidenceById.get(messageId);
        return evidence ? [{
          id: evidence.id,
          conversationId: evidence.reference.conversationId,
          weekStart: evidence.weekStart,
          channel: evidence.channel,
          grounding: evidence.grounding,
          contentGapEligible: evidence.contentGapEligible,
          question: evidence.question,
        }] : [];
      });
    return {
      title: topic.title,
      description: topic.description,
      memberCount: topic.memberCount,
      share: topic.share,
      exemplars,
    };
  });
  const remaining = ordered.slice(AUDIENCE_PULSE_SUMMARY_MAX_TOPICS);
  return {
    shown,
    additionalTopics: {
      count: remaining.length,
      share: remaining.reduce((sum, topic) => sum + topic.share, 0),
    },
  };
};

/**
 * Orchestrates the bounded report without querying Chat persistence directly. The
 * Chat-owned history source is responsible for source eligibility and reauthorization.
 */
export class AudiencePulseService implements AudiencePulsePort {
  private readonly now: () => Date;

  constructor(private readonly deps: AudiencePulseServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async read(input: { accountId: string; userId: string; workspaceId: string }): Promise<AudiencePulseReadResult> {
    // A failed revision-conditional invalidation means a refresh won the race. Re-read it
    // once so an old GET can neither delete nor hide a fresh report.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.deps.snapshotStore.find(input.workspaceId);
      if (!snapshot) return { kind: "not_generated" };

      const hydrated = await this.deps.historySource.rehydrate({
        workspaceId: input.workspaceId,
        references: snapshot.promptEvidenceRefs,
      });
      if (hydrated.size === snapshot.promptEvidenceRefs.length) {
        return { kind: "completed", report: hydrateReport(snapshot.report, hydrated) };
      }

      const invalidated = await this.deps.snapshotStore.invalidate({
        workspaceId: input.workspaceId,
        expectedRevision: snapshot.revision,
      });
      if (invalidated) return { kind: "not_generated" };
    }
    return { kind: "not_generated" };
  }

  async readEvidenceAnchor(input: {
    accountId: string;
    userId: string;
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }): Promise<AudiencePulseEvidenceAnchor | null> {
    return this.deps.historySource.readEvidenceAnchor({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });
  }

  async refresh(input: {
    accountId: string;
    userId: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<AudiencePulseRefreshResult> {
    const startedAt = this.now();
    const analysisEnd = startedAt;
    const analysisStart = new Date(analysisEnd.getTime() - AUDIENCE_PULSE_ANALYSIS_DAYS * 24 * 60 * 60 * 1000);
    await safeAudit(this.deps.auditService, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "audience_pulse.refresh_requested",
      eventStatus: "success",
      metadata: { userId: input.userId },
    });

    const lease = await this.deps.runGate.tryAcquire(input.workspaceId);
    if (!lease) {
      await this.recordOutcome(input, "busy", startedAt, {});
      return { kind: "busy" };
    }

    let reservation: UsageLimitReservation | null = null;
    let reservationMustRemain = false;
    let deferredFailureOutcome: AudiencePulseRefreshFailureOutcome | null = null;
    try {
      try {
        await this.deps.refreshRateLimit.enforce({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        deferredFailureOutcome = rateLimitFailureOutcome(error);
        throw error;
      }

      const history = await this.deps.historySource.read({
        workspaceId: input.workspaceId,
        analysisStart,
        analysisEnd,
      });
      if (history.coverage.populationSize === 0 || history.evidence.length === 0) {
        await this.recordOutcome(input, "no_traffic", startedAt, {
          populationSize: history.coverage.populationSize,
        });
        return {
          kind: "no_traffic",
          period: { start: analysisStart.toISOString(), end: analysisEnd.toISOString() },
          weeklyVolume: history.weeklyVolume,
        };
      }

      try {
        reservation = await this.deps.usageLimitPolicy.reserveAnswer({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          surface: "audience_pulse",
        });
      } catch (error) {
        if (isUsageLimitExceededError(error)) {
          await this.recordOutcome(input, "usage_limited", startedAt, {
            populationSize: history.coverage.populationSize,
            sampleSize: history.coverage.sampleSize,
          });
          return { kind: "usage_limited" };
        }
        throw error;
      }

      const facetProcessedJobCount = await this.deps.facetDrain?.drainWorkspace({
        workspaceId: input.workspaceId,
        maxJobs: AUDIENCE_PULSE_REFRESH_FACET_MAX_JOBS,
      }) ?? 0;

      // The census clusters the exact eligible-question population for this same
      // window (spec 956 FR-003): it names and sizes every topic before any model
      // call writes a word of narrative about them.
      const census = this.deps.censusServiceFactory.create({ workspaceId: input.workspaceId });
      let censusResult: CensusRunResult;
      try {
        censusResult = await census.run({
          workspaceId: input.workspaceId,
          windowStart: analysisStart,
          windowEnd: analysisEnd,
          signal: input.signal,
        });
      } catch (error) {
        if (errorStatusCode(error) !== undefined) throw error;
        const reason = unavailableReason(error);
        deferredFailureOutcome = reason;
        return { kind: "unavailable", reason };
      }
      // The census and the history read independently query the same fixed
      // [analysisStart, analysisEnd) window; a mismatch means the two reads observed
      // different data and every downstream count would be unsound (spec 956 FR-005).
      if (censusResult.populationSize !== history.coverage.populationSize) {
        throw new Error(
          `audience_pulse: census population (${censusResult.populationSize}) does not match `
          + `history population (${history.coverage.populationSize}) for workspace ${input.workspaceId}`,
        );
      }
      const reportCoverage: AudiencePulseReportCoverage = {
        ...history.coverage,
        facetReadyQuestionCount: censusResult.facetReadyQuestionCount,
      };

      if (censusResult.facetReadyQuestionCount === 0) {
        // Every eligible question in this window is still missing a current, embedded
        // facet -- a historical population predating the extraction hook, or a
        // backfill still draining (spec 956 follow-up). The census could not cluster
        // anything, so there is nothing for a narrative call to summarize; skip it
        // rather than ask a model to narrate zero computed data, the same precedent
        // an empty population already sets for `no_traffic`. The early reservation
        // above is released by the shared `finally` path because no billable model
        // completion ran for the report.
        const generatedAt = this.now();
        const report = buildAudiencePulseComputingReport({
          period: { start: analysisStart, end: analysisEnd },
          generatedAt,
          coverage: reportCoverage,
          weeklyVolume: history.weeklyVolume,
        });
        await this.deps.snapshotStore.replace({
          workspaceId: input.workspaceId,
          period: { start: analysisStart, end: analysisEnd },
          generatedAt,
          report,
          promptEvidenceRefs: [],
        });
        const hydrated = hydrateReport(report, new Map());
        await this.recordOutcome(input, "completed", startedAt, {
          populationSize: history.coverage.populationSize,
          sampleSize: history.coverage.sampleSize,
          facetProcessedJobCount,
          unclassifiedCount: report.unclassifiedQuestionCount,
          topicCount: 0,
          facetReadyQuestionCount: 0,
        });
        return { kind: "completed", report: hydrated };
      }

      const censusTopics = censusTopicsFromRun({ topics: censusResult.topics });

      const evidenceById = new Map(history.evidence.map((item) => [item.id, item]));
      const { shown, additionalTopics } = buildSummaryTopics({
        topics: censusResult.topics,
        evidenceById,
      });
      const summaryInput: AudiencePulseSummaryInput = {
        period: { start: analysisStart, end: analysisEnd },
        coverage: {
          populationSize: history.coverage.populationSize,
          unclassifiedQuestionCount: censusResult.unclassifiedCount,
          facetReadyQuestionCount: censusResult.facetReadyQuestionCount,
        },
        weeklyVolume: history.weeklyVolume,
        topics: shown,
        additionalTopics,
      };
      const boundedSummaryInput = boundAudiencePulseSummaryInputForPrompt(summaryInput);
      const prompt = buildAudiencePulsePrompt(boundedSummaryInput);
      const responseFormat = buildAudiencePulseResponseFormat(shown.length);
      const modelCallContext = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        requestId: randomUUID(),
        surface: "audience_pulse",
        operation: "analysis",
        attemptKey: randomUUID(),
      };
      const inference = await this.deps.inferenceFactory.create({
        workspaceContext: { workspaceId: input.workspaceId, accountId: input.accountId },
        modelCallContext,
      });

      let completion: Awaited<ReturnType<typeof inference.complete>>;
      try {
        completion = await inference.complete({
          prompt,
          maxInputTokens: AUDIENCE_PULSE_MAX_TOTAL_TOKENS,
          maxOutputTokens: AUDIENCE_PULSE_MAX_OUTPUT_TOKENS,
          responseFormat,
          signal: input.signal,
          operation: modelCallContext,
          validateResult(result) {
            parseModelResult(result.text);
          },
        });
      } catch (error) {
        if (errorStatusCode(error) !== undefined) throw error;
        const reason = unavailableReason(error);
        deferredFailureOutcome = reason;
        return { kind: "unavailable", reason };
      }

      let report: AudiencePulseStoredReport;
      let generatedAt: Date;
      try {
        const model = parseModelResult(completion.text);
        generatedAt = this.now();
        report = buildAudiencePulseReport({
          period: { start: analysisStart, end: analysisEnd },
          generatedAt,
          coverage: reportCoverage,
          weeklyVolume: history.weeklyVolume,
          population: history.evidence,
          topics: censusTopics,
          model,
        });
        // Belt-and-suspenders on the invariant the whole feature exists for (spec 956
        // FR-005): every eligible question is a member of exactly one topic, or
        // unclassified, and the two sum to the population. `buildAudiencePulseReport`
        // derives `unclassifiedQuestionCount` independently of the census's own
        // count; they must agree.
        if (report.unclassifiedQuestionCount !== censusResult.unclassifiedCount) {
          throw new Error(
            `audience_pulse: report unclassified count (${report.unclassifiedQuestionCount}) does not match `
            + `census unclassified count (${censusResult.unclassifiedCount}) for workspace ${input.workspaceId}`,
          );
        }
      } catch (error) {
        if (!isAbortError(error) && !isModelValidationError(error)) throw error;
        const reason = unavailableReason(error);
        deferredFailureOutcome = reason;
        return { kind: "unavailable", reason };
      }

      // A validated model completion is billable even when a later snapshot write or
      // accounting operation fails, so do not release its reservation afterward.
      reservationMustRemain = true;
      await reservation.commit();
      // Only evidence a theme or recommendation actually references ever needs to
      // rehydrate later -- an unclassified question's evidence ref would never be
      // read again, and the population can be far larger than what any topic claimed.
      const referencedEvidenceIds = new Set([
        ...report.themes.flatMap((theme) => theme.evidenceIds),
        ...report.recommendations.flatMap((recommendation) => recommendation.evidenceIds),
      ]);
      const referencedEvidence = history.evidence.filter((item) => referencedEvidenceIds.has(item.id));
      await this.deps.snapshotStore.replace({
        workspaceId: input.workspaceId,
        period: { start: analysisStart, end: analysisEnd },
        generatedAt,
        report,
        promptEvidenceRefs: promptEvidenceReferences(referencedEvidence),
      });
      const hydrated = hydrateReport(report, createHydratedEvidence(referencedEvidence));
      await this.recordOutcome(input, "completed", startedAt, {
        populationSize: history.coverage.populationSize,
        sampleSize: history.coverage.sampleSize,
        facetProcessedJobCount,
        unclassifiedCount: censusResult.unclassifiedCount,
        topicCount: censusTopics.length,
      });
      return { kind: "completed", report: hydrated };
    } catch (error) {
      deferredFailureOutcome ??= errorStatusCode(error) === 503 ? "provider" : "internal";
      throw error;
    } finally {
      try {
        if (reservation && !reservationMustRemain) {
          await reservation.release();
        }
      } catch (error) {
        // Releasing is accounting work, so surface failures while still cleaning up the lease.
        await this.recordOutcome(input, "internal", startedAt, {}).catch(() => undefined);
        throw error;
      } finally {
        await lease.release().catch(() => undefined);
      }
      if (deferredFailureOutcome) {
        await this.recordOutcome(input, deferredFailureOutcome, startedAt, {});
      }
    }
  }

  private async recordOutcome(
    input: { accountId: string; userId: string; workspaceId: string },
    outcome: string,
    startedAt: Date,
    counts: Record<string, number>,
  ): Promise<void> {
    const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
    const eventStatus: "success" | "failure" = outcome === "completed" || outcome === "no_traffic" ? "success" : "failure";
    const metadata = { userId: input.userId, outcome, durationMs, ...counts };
    await safeAudit(this.deps.auditService, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: outcome === "completed" || outcome === "no_traffic"
        ? "audience_pulse.refresh_completed"
        : "audience_pulse.refresh_failed",
      eventStatus,
      metadata,
    });
    const context = { workspaceId: input.workspaceId, outcome, durationMs, ...counts };
    if (eventStatus === "success") {
      this.deps.logger?.info?.(context, "audience_pulse_refresh");
    } else {
      this.deps.logger?.warn?.(context, "audience_pulse_refresh");
    }
  }
}

export { hydrateReport };
