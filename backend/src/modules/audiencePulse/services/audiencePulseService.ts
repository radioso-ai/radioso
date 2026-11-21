import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import type { UsageLimitPolicy, UsageLimitReservation } from "../../../shared/domain/usageLimitPolicy.js";
import { isUsageLimitExceededError } from "../../../shared/domain/usageLimitPolicy.js";
import type { ProviderDispatchRecord } from "../../../shared/infra/llm/providerTypes.js";
import type {
  AudiencePulseCensusTopic,
  AudiencePulseEvidence,
  AudiencePulseModelOutput,
  AudiencePulseReportCoverage,
  AudiencePulseStoredReport,
} from "../domain/report.js";
import {
  audiencePulsePreviousPeriod,
  audiencePulseVisibleFrom,
  summarizeAudiencePulsePeriod,
  type AudiencePulsePreviousPeriod,
} from "../domain/periodTotals.js";
import {
  applyAudiencePulseNarrative,
  AudiencePulseReportValidationError,
  buildAudiencePulseCensusReport,
  buildAudiencePulseComputingReport,
  evaluateTopicContentGap,
  parseAudiencePulseModelOutput,
} from "../domain/report.js";
import type {
  AudiencePulseAuditPort,
  AudiencePulseEvidenceAnchor,
  AudiencePulseFacetDrainPort,
  AudiencePulseHistoryHorizonSource,
  AudiencePulseHistorySource,
  AudiencePulseInferenceFactory,
  AudiencePulsePort,
  AudiencePulsePromptEvidenceReference,
  AudiencePulseRefreshRateLimitPort,
  AudiencePulseReadResult,
  AudiencePulseRefreshResult,
  AudiencePulseRunGate,
  AudiencePulseSnapshotStore,
  AudiencePulseTopicDraftLink,
  AudiencePulseTopicState,
  AudiencePulseTopicStateStore,
  AudiencePulseTopicStateWrite,
} from "../contracts.js";
import { AUDIENCE_PULSE_ANALYSIS_DAYS } from "../contracts.js";
import type { CensusServiceFactory } from "../infra/censusServiceFactory.js";
import type { CensusRunResult, CensusRunTopicResult } from "./censusService.js";
import { createHydratedEvidence } from "./themeEvidence.js";
import { hydrateReport } from "./reportHydration.js";
import {
  previousThemeMemberCounts,
  previousThemeShares,
  reusableNarrativeSnapshot,
  richestFirst,
} from "./narrativeReuse.js";
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
  /** Dismissals and draft links, read beside every report and never stored in a snapshot. */
  topicStateStore: AudiencePulseTopicStateStore;
  /** How far back the workspace's history is whole, which bounds the previous-period comparison. */
  historyHorizon: AudiencePulseHistoryHorizonSource;
  logger?: SafeLogger;
  now?: () => Date;
  /**
   * Builds a workspace-scoped `CensusService` (spec 956): `refresh()` calls
   * `create(...).run(...)` to cluster the full window population into exact topics
   * before it ever prompts a model for a narrative.
   */
  censusServiceFactory: CensusServiceFactory;
}

const safeAudit = async (
  auditService: AudiencePulseAuditPort,
  input: Parameters<AudiencePulseAuditPort["record"]>[0],
): Promise<void> => {
  await auditService.record(input).catch(() => undefined);
};

const ANALYSIS_WINDOW_MS = AUDIENCE_PULSE_ANALYSIS_DAYS * 24 * 60 * 60 * 1000;

type AudiencePulseTopicActionInput = { accountId: string; userId: string; workspaceId: string; topicId: string };

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
  | "census"
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

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Maps the provider's exact keyed contract onto the report domain's index-based contract. */
const parseModelResult = (
  text: string,
  qualifyingTopicIndexes: readonly number[],
): AudiencePulseModelOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AudiencePulseReportValidationError("Audience Pulse model response was not valid JSON");
  }

  if (!isJsonObject(parsed)) {
    throw new AudiencePulseReportValidationError("Audience Pulse model response did not match the approved schema");
  }
  const rawRecommendations = parsed.recommendations;
  if (!isJsonObject(rawRecommendations)) {
    throw new AudiencePulseReportValidationError("Audience Pulse model response did not match the approved schema");
  }
  const expectedRecommendationKeys = qualifyingTopicIndexes.map(String);
  const actualRecommendationKeys = Object.keys(rawRecommendations);
  if (
    actualRecommendationKeys.length !== expectedRecommendationKeys.length
    || expectedRecommendationKeys.some((key) => !Object.hasOwn(rawRecommendations, key))
  ) {
    throw new AudiencePulseReportValidationError("Audience Pulse model response did not match the approved schema");
  }

  const recommendations = qualifyingTopicIndexes.map((themeIndex) => {
    const recommendation = rawRecommendations[String(themeIndex)];
    if (!isJsonObject(recommendation) || Object.hasOwn(recommendation, "themeIndex")) {
      throw new AudiencePulseReportValidationError("Audience Pulse model response did not match the approved schema");
    }
    return { ...recommendation, themeIndex };
  });

  try {
    return parseAudiencePulseModelOutput({ ...parsed, recommendations });
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
  return {
    id: topic.topicId,
    title: topic.title,
    description: topic.description,
    evidenceIds: topic.memberIds,
    transition: topic.transition,
  };
});

/**
 * Builds the narrative call's input (spec 956): the richest
 * `AUDIENCE_PULSE_SUMMARY_MAX_TOPICS` topics, each with a bounded set of real member
 * questions as exemplars, plus an aggregate for whatever topics did not make the cut.
 * `memberCount`/`share` come straight from the census, not from `exemplars.length` --
 * exemplars illustrate a topic, they never resize it.
 */
export const buildSummaryTopics = (input: {
  topics: readonly CensusRunTopicResult[];
  evidenceById: ReadonlyMap<string, AudiencePulseEvidence>;
}): { shown: AudiencePulseSummaryTopic[]; additionalTopics: { count: number; share: number } } => {
  const ordered = richestFirst(input.topics);
  const shown = ordered.slice(0, AUDIENCE_PULSE_SUMMARY_MAX_TOPICS).map((topic): AudiencePulseSummaryTopic => {
    const members = topic.memberIds.flatMap((messageId) => {
      const evidence = input.evidenceById.get(messageId);
      return evidence ? [evidence] : [];
    });
    const selectedIds = new Set<string>();
    const selectedConversationIds = new Set<string>();
    for (const member of members) {
      if (!member.contentGapEligible || selectedConversationIds.has(member.reference.conversationId)) continue;
      selectedIds.add(member.id);
      selectedConversationIds.add(member.reference.conversationId);
      if (selectedIds.size === 3) break;
    }
    for (const member of members) {
      if (selectedIds.size === AUDIENCE_PULSE_SUMMARY_MAX_EXEMPLARS_PER_TOPIC) break;
      selectedIds.add(member.id);
    }
    const exemplars = [...selectedIds]
      .flatMap((evidenceId) => {
        const evidence = input.evidenceById.get(evidenceId);
        return evidence ? [evidence] : [];
      })
      .map((evidence) => ({
        id: evidence.id,
        conversationId: evidence.reference.conversationId,
        weekStart: evidence.weekStart,
        channel: evidence.channel,
        grounding: evidence.grounding,
        contentGapEligible: evidence.contentGapEligible,
        question: evidence.question,
      }));
    return {
      title: topic.title,
      description: topic.description,
      memberCount: topic.memberCount,
      share: topic.share,
      contentGapQualifies: evaluateTopicContentGap(members, topic.memberCount).qualifies,
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
        const topicStates = await this.readTopicStates(input.workspaceId, snapshot.report);
        return { kind: "completed", report: hydrateReport(snapshot.report, hydrated, topicStates) };
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

  async dismissTopic(input: AudiencePulseTopicActionInput): Promise<AudiencePulseTopicStateWrite> {
    const result = await this.deps.topicStateStore.dismiss({
      workspaceId: input.workspaceId,
      topicId: input.topicId,
      userId: input.userId,
    });
    if (result === "changed") await this.recordTopicAction(input, "audience_pulse.topic_dismissed", {});
    return result;
  }

  async restoreTopic(input: AudiencePulseTopicActionInput): Promise<AudiencePulseTopicStateWrite> {
    const result = await this.deps.topicStateStore.restore({ workspaceId: input.workspaceId, topicId: input.topicId });
    if (result === "changed") await this.recordTopicAction(input, "audience_pulse.topic_restored", {});
    return result;
  }

  async linkTopicDraft(input: AudiencePulseTopicActionInput & { documentId: string }): Promise<AudiencePulseTopicDraftLink> {
    const result = await this.deps.topicStateStore.linkDraft({
      workspaceId: input.workspaceId,
      topicId: input.topicId,
      documentId: input.documentId,
      userId: input.userId,
    });
    if (result === "changed") {
      await this.recordTopicAction(input, "audience_pulse.topic_draft_linked", { documentId: input.documentId });
    }
    return result;
  }

  async refreshStatus(input: { workspaceId: string }): Promise<{ pending: boolean }> {
    const analysisEnd = this.now();
    const analysisStart = new Date(analysisEnd.getTime() - ANALYSIS_WINDOW_MS);
    return {
      pending: await this.deps.facetDrain?.hasPendingWorkspaceWork({
        workspaceId: input.workspaceId,
        analysisStart,
        analysisEnd,
      }) ?? false,
    };
  }

  async refresh(input: {
    accountId: string;
    userId: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<AudiencePulseRefreshResult> {
    const startedAt = this.now();
    const analysisEnd = startedAt;
    const analysisStart = new Date(analysisEnd.getTime() - ANALYSIS_WINDOW_MS);
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
    let modelCallsIssued = 0;
    let narrativeReused = false;
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

      const facetDrainInput = { workspaceId: input.workspaceId, analysisStart, analysisEnd };
      const hasFacetWork = await this.deps.facetDrain?.hasPendingWorkspaceWork(facetDrainInput) ?? false;
      if (hasFacetWork) {
        await this.deps.facetDrain?.requestWorkspaceDrain(facetDrainInput);
        return { kind: "preparing" };
      }

      try {
        reservation = await this.deps.usageLimitPolicy.reserveAnswer({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          surface: "audience_pulse",
          usage: "pulse_report",
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

      // The census clusters the exact eligible-question population for this same
      // window (spec 956 FR-003): it names and sizes every topic before any model
      // call writes a word of narrative about them.
      // The previous-period read runs beside it: it needs no census, turns a failure into a null
      // comparison, and rejects only when the refresh is cancelled.
      const census = this.deps.censusServiceFactory.create({ workspaceId: input.workspaceId });
      let censusResult: CensusRunResult;
      let previousPeriod: AudiencePulsePreviousPeriod | null;
      try {
        [censusResult, previousPeriod] = await Promise.all([
          census.run({
            workspaceId: input.workspaceId,
            windowStart: analysisStart,
            windowEnd: analysisEnd,
            signal: input.signal,
            onModelCallIssued: () => {
              modelCallsIssued += 1;
            },
          }),
          this.readPreviousPeriod({
            workspaceId: input.workspaceId,
            currentStart: analysisStart,
            now: analysisEnd,
            signal: input.signal,
          }),
        ]);
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
      const priorSnapshot = await this.deps.snapshotStore.find(input.workspaceId);

      if (censusResult.facetReadyQuestionCount === 0) {
        // Every eligible question in this window is still missing a current, embedded
        // facet -- a historical population predating the extraction hook, or a
        // backfill still draining (spec 956 follow-up). The census could not cluster
        // anything, so there is nothing for a narrative call to summarize; skip it
        // rather than ask a model to narrate zero computed data, the same precedent
        // an empty population already sets for `no_traffic`.
        const generatedAt = this.now();
        const report = {
          ...buildAudiencePulseComputingReport({
            period: { start: analysisStart, end: analysisEnd },
            generatedAt,
            isFirstCensus: censusResult.isFirstCensus,
            coverage: reportCoverage,
            weeklyVolume: history.weeklyVolume,
            population: history.evidence,
            previousPeriod,
          }),
          censusRunId: censusResult.runId,
        };
        await this.deps.snapshotStore.replace({
          workspaceId: input.workspaceId,
          period: { start: analysisStart, end: analysisEnd },
          generatedAt,
          report,
          promptEvidenceRefs: [],
        });
        // A report with no topics has no content gap to carry operator state.
        const hydrated = hydrateReport(report, new Map(), new Map());
        await this.recordOutcome(input, "completed", startedAt, {
          populationSize: history.coverage.populationSize,
          sampleSize: history.coverage.sampleSize,
          unclassifiedCount: report.unclassifiedQuestionCount,
          topicCount: 0,
          facetReadyQuestionCount: 0,
        });
        return { kind: "completed", report: hydrated };
      }

      const evidenceById = new Map(history.evidence.map((item) => [item.id, item]));
      const censusTopics = censusTopicsFromRun({ topics: censusResult.topics });
      // This report supplies the current census-derived data to both branches. Reuse
      // carries over only model-authored narrative fields, never an old content-gap
      // decision or a recommendation that the domain no longer qualifies.
      let censusReport: ReturnType<typeof buildAudiencePulseCensusReport>;
      const priorMemberCounts = previousThemeMemberCounts(priorSnapshot);
      try {
        const computedCensusReport = buildAudiencePulseCensusReport({
          period: { start: analysisStart, end: analysisEnd },
          // Final reports resample this timestamp when narrative reuse or generation
          // completes; the census-owned arrays themselves are built only here.
          generatedAt: startedAt,
          isFirstCensus: censusResult.isFirstCensus,
          coverage: reportCoverage,
          weeklyVolume: history.weeklyVolume,
          population: history.evidence,
          topics: censusTopics,
          dissolvedTopics: censusResult.dissolvedTopics,
          previousThemeMemberCounts: priorMemberCounts,
          previousThemeShares: previousThemeShares(priorSnapshot),
          previousPeriod,
          // Names the snapshot only when it gave some topic a previous count to compare with.
          previousGeneratedAt: priorMemberCounts.size > 0 ? priorSnapshot?.report.generatedAt ?? null : null,
        });
        censusReport = {
          ...computedCensusReport,
          report: { ...computedCensusReport.report, censusRunId: censusResult.runId },
        };
      } catch (error) {
        if (!isAbortError(error) && !(error instanceof AudiencePulseReportValidationError)) throw error;
        const reason = isAbortError(error) ? "cancelled" : "census";
        deferredFailureOutcome = reason;
        return { kind: "unavailable", reason };
      }
      const reusableSnapshot = reusableNarrativeSnapshot({
        snapshot: priorSnapshot,
        censusResult,
        currentEvidenceById: evidenceById,
        populationSize: censusReport.report.coverage.populationSize,
        unclassifiedQuestionCount: censusReport.report.unclassifiedQuestionCount,
        contentGapThemeIds: censusReport.report.contentGaps.map((gap) => gap.themeId),
        recommendationEvidenceIdsByThemeId: censusReport.recommendationEvidenceIdsByThemeId,
      });
      narrativeReused = reusableSnapshot !== null;

      let generatedAt: Date;
      let report: AudiencePulseStoredReport;
      if (reusableSnapshot) {
        generatedAt = this.now();
        report = {
          ...censusReport.report,
          generatedAt: generatedAt.toISOString(),
          narrativeGeneratedAt: reusableSnapshot.report.narrativeGeneratedAt
            ?? reusableSnapshot.report.generatedAt,
          narrativeReuseCount: (reusableSnapshot.report.narrativeReuseCount ?? 0) + 1,
          summary: reusableSnapshot.report.summary,
          recommendations: reusableSnapshot.report.recommendations.map((recommendation) => ({
            ...recommendation,
            questions: [...recommendation.questions],
            evidenceIds: [...recommendation.evidenceIds],
          })),
          // Summary, recommendations and caveats all come from one completion, so they
          // carry over together. Reusing the narrative while dropping its caveats would
          // strip qualifications the operator saw a moment ago and bring them back on
          // the next regenerated run.
          caveats: [...reusableSnapshot.report.caveats],
        };
      } else {
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
        // Qualifying topics beyond the narrative cap keep their content gap, which their row shows
        // through its shortfall counts, but cannot receive model copy.
        const shownQualifyingTopicIndexes = shown.flatMap((topic, index) =>
          topic.contentGapQualifies ? [index] : []);
        const responseFormat = buildAudiencePulseResponseFormat(shownQualifyingTopicIndexes);
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
        const dispatchRecord: ProviderDispatchRecord = { dispatched: false };
        try {
          completion = await inference.complete({
            prompt,
            maxInputTokens: AUDIENCE_PULSE_MAX_TOTAL_TOKENS,
            maxOutputTokens: AUDIENCE_PULSE_MAX_OUTPUT_TOKENS,
            responseFormat,
            signal: input.signal,
            operation: modelCallContext,
            dispatchRecord,
            validateResult(result) {
              parseModelResult(result.text, shownQualifyingTopicIndexes);
            },
          });
        } catch (error) {
          if (errorStatusCode(error) !== undefined) throw error;
          const reason = unavailableReason(error);
          deferredFailureOutcome = reason;
          return { kind: "unavailable", reason };
        } finally {
          if (dispatchRecord.dispatched) {
            modelCallsIssued += 1;
          }
        }

        try {
          const model = parseModelResult(completion.text, shownQualifyingTopicIndexes);
          generatedAt = this.now();
          report = applyAudiencePulseNarrative({
            census: censusReport,
            generatedAt,
            model,
          });
          const shownQualifyingThemeIds = shownQualifyingTopicIndexes
            .flatMap((topicIndex) => report.themes[topicIndex]?.id ?? [])
            .sort();
          const recommendationThemeIds = report.recommendations.map((recommendation) => recommendation.themeId).sort();
          if (shownQualifyingThemeIds.join("\u0000") !== recommendationThemeIds.join("\u0000")) {
            this.deps.logger?.warn?.({
              workspaceId: input.workspaceId,
              qualifyingThemeCount: shownQualifyingThemeIds.length,
              recommendationThemeCount: recommendationThemeIds.length,
              qualifyingThemeIds: shownQualifyingThemeIds,
              recommendationThemeIds,
            }, "audience_pulse_recommendation_divergence");
          }
        } catch (error) {
          if (!isAbortError(error) && !isModelValidationError(error)) throw error;
          const reason = unavailableReason(error);
          deferredFailureOutcome = reason;
          return { kind: "unavailable", reason };
        }
      }

      // Belt-and-suspenders on the invariant the whole feature exists for (spec 956
      // FR-005): every eligible question is a member of exactly one topic, or
      // unclassified, and the two sum to the population. `buildAudiencePulseReport`
      // derives `unclassifiedQuestionCount` independently of the census's own
      // count; they must agree on both generated and reused narratives.
      if (report.unclassifiedQuestionCount !== censusResult.unclassifiedCount) {
        throw new Error(
          `audience_pulse: report unclassified count (${report.unclassifiedQuestionCount}) does not match `
          + `census unclassified count (${censusResult.unclassifiedCount}) for workspace ${input.workspaceId}`,
        );
      }

      // Issued model work is billable even when validation or a later snapshot write
      // fails, so commit before persistence once the successful path reaches here.
      if (modelCallsIssued > 0) {
        if (!reservation) {
          throw new Error("audience_pulse: model completion has no usage reservation");
        }
        reservationMustRemain = true;
        await reservation.commit();
      }
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
      const hydrated = hydrateReport(
        report,
        createHydratedEvidence(referencedEvidence),
        await this.readTopicStates(input.workspaceId, report),
      );
      await this.recordOutcome(input, "completed", startedAt, {
        populationSize: history.coverage.populationSize,
        sampleSize: history.coverage.sampleSize,
        unclassifiedCount: censusResult.unclassifiedCount,
        topicCount: censusTopics.length,
        narrativeReused,
      });
      return { kind: "completed", report: hydrated };
    } catch (error) {
      deferredFailureOutcome ??= errorStatusCode(error) === 503 ? "provider" : "internal";
      throw error;
    } finally {
      try {
        if (reservation && !reservationMustRemain) {
          if (modelCallsIssued > 0) {
            reservationMustRemain = true;
            await reservation.commit();
          } else {
            await reservation.release();
          }
        }
      } catch (error) {
        // A usage reservation that cannot be released is a billing-integrity problem, so it
        // deliberately wins over whatever error was already propagating: callers see the
        // accounting failure. `audience_pulse_service.test.ts` pins this precedence.
        // `narrativeReused` is carried even here: a run that reused its narrative and then
        // failed to settle must not report itself as having paid for one.
        await this.recordOutcome(input, "internal", startedAt, { narrativeReused }).catch(() => undefined);
        // eslint-disable-next-line no-unsafe-finally -- deliberate precedence, see above
        throw error;
      } finally {
        await lease.release().catch(() => undefined);
      }
      if (deferredFailureOutcome) {
        await this.recordOutcome(input, deferredFailureOutcome, startedAt, { narrativeReused });
      }
    }
  }

  /**
   * The 30 days before the report's window, counted with the same rule as the window itself from
   * the history source's text-free outcomes. Null when part of those days is out of sight (the
   * workspace is younger, or retention is sweeping them) and when the read fails: the comparison is
   * a nicety, so a failure never fails or bills a refresh. An abort rethrows, so a cancelled
   * refresh stops. The read roughly doubles a refresh's per-question reads, so its cost is logged.
   */
  private async readPreviousPeriod(input: {
    workspaceId: string;
    currentStart: Date;
    now: Date;
    signal?: AbortSignal;
  }): Promise<AudiencePulsePreviousPeriod | null> {
    const period = { start: new Date(input.currentStart.getTime() - ANALYSIS_WINDOW_MS), end: input.currentStart };
    const startedAt = this.now();
    const durationMs = () => Math.max(0, this.now().getTime() - startedAt.getTime());
    try {
      const horizon = await this.deps.historyHorizon.read(input.workspaceId);
      if (!horizon || period.start < audiencePulseVisibleFrom({ ...horizon, now: input.now })) return null;
      const outcomes = await this.deps.historySource.readPeriodOutcomes({
        workspaceId: input.workspaceId,
        analysisStart: period.start,
        analysisEnd: period.end,
        signal: input.signal,
      });
      const totals = summarizeAudiencePulsePeriod(outcomes);
      this.deps.logger?.info?.({
        workspaceId: input.workspaceId,
        questionCount: totals.questionCount,
        durationMs: durationMs(),
      }, "audience_pulse_previous_period_read");
      return audiencePulsePreviousPeriod({ period, totals });
    } catch (error) {
      // A cancelled refresh stops; only a genuine read failure becomes a missing comparison.
      if (isAbortError(error) || input.signal?.aborted) throw error;
      this.deps.logger?.warn?.({
        workspaceId: input.workspaceId,
        durationMs: durationMs(),
        errorName: error instanceof Error ? error.name : "unknown",
      }, "audience_pulse_previous_period_read_failed");
      return null;
    }
  }

  /**
   * Operator state is decoration on a report that is already saved and, on refresh, billed: a
   * failed read serves the report without it rather than failing the request.
   */
  private async readTopicStates(
    workspaceId: string,
    report: AudiencePulseStoredReport,
  ): Promise<Map<string, AudiencePulseTopicState>> {
    const topicIds = report.contentGaps.map((gap) => gap.themeId);
    if (topicIds.length === 0) return new Map();
    try {
      return await this.deps.topicStateStore.readTopicStates({ workspaceId, topicIds });
    } catch (error) {
      this.deps.logger?.warn?.({
        workspaceId,
        topicCount: topicIds.length,
        errorName: error instanceof Error ? error.name : "unknown",
      }, "audience_pulse_topic_state_read_failed");
      return new Map();
    }
  }

  private async recordTopicAction(
    input: AudiencePulseTopicActionInput,
    eventType: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await safeAudit(this.deps.auditService, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType,
      eventStatus: "success",
      metadata: { userId: input.userId, topicId: input.topicId, ...metadata },
    });
  }

  private async recordOutcome(
    input: { accountId: string; userId: string; workspaceId: string },
    outcome: string,
    startedAt: Date,
    counts: Record<string, number | boolean>,
  ): Promise<void> {
    const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
    const eventStatus: "success" | "failure" = outcome === "completed" || outcome === "no_traffic" ? "success" : "failure";
    const narrativeReused = counts.narrativeReused === true;
    const metadata = { userId: input.userId, outcome, durationMs, ...counts, narrativeReused };
    await safeAudit(this.deps.auditService, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: outcome === "completed" || outcome === "no_traffic"
        ? "audience_pulse.refresh_completed"
        : "audience_pulse.refresh_failed",
      eventStatus,
      metadata,
    });
    const context = { workspaceId: input.workspaceId, outcome, durationMs, ...counts, narrativeReused };
    if (eventStatus === "success") {
      this.deps.logger?.info?.(context, "audience_pulse_refresh");
    } else {
      this.deps.logger?.warn?.(context, "audience_pulse_refresh");
    }
  }
}
