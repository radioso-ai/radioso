import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import type { UsageLimitPolicy, UsageLimitReservation } from "../../../shared/domain/usageLimitPolicy.js";
import { isUsageLimitExceededError } from "../../../shared/domain/usageLimitPolicy.js";
import type {
  AudiencePulseEvidence,
  AudiencePulseModelOutput,
  AudiencePulseStoredReport,
} from "../domain/report.js";
import {
  AudiencePulseReportValidationError,
  buildAudiencePulseReport,
  parseAudiencePulseModelOutput,
} from "../domain/report.js";
import type {
  AudiencePulseAuditPort,
  AudiencePulseEvidenceAnchor,
  AudiencePulseHistorySource,
  AudiencePulseHydratedEvidence,
  AudiencePulseHydratedReport,
  AudiencePulseInferenceFactory,
  AudiencePulsePort,
  AudiencePulsePromptEvidenceReference,
  AudiencePulseReadResult,
  AudiencePulseRefreshResult,
  AudiencePulseRunGate,
  AudiencePulseSnapshotRecord,
  AudiencePulseSnapshotStore,
} from "../contracts.js";
import {
  AUDIENCE_PULSE_ANALYSIS_DAYS,
  DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY,
} from "../contracts.js";
import {
  AUDIENCE_PULSE_MAX_OUTPUT_TOKENS,
  AUDIENCE_PULSE_MAX_TOTAL_TOKENS,
  AUDIENCE_PULSE_RESPONSE_FORMAT,
  boundAudiencePulseHistoryForPrompt,
  buildAudiencePulsePrompt,
} from "./prompt.js";

interface SafeLogger {
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface AudiencePulseServiceDependencies {
  historySource: AudiencePulseHistorySource;
  snapshotStore: AudiencePulseSnapshotStore;
  runGate: AudiencePulseRunGate;
  inferenceFactory: AudiencePulseInferenceFactory;
  usageLimitPolicy: UsageLimitPolicy;
  auditService: AudiencePulseAuditPort;
  logger?: SafeLogger;
  now?: () => Date;
}

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
  const groupedEvidenceIds = new Set(report.themes.flatMap((theme) => theme.evidenceIds));

  return {
    period: report.period,
    generatedAt: report.generatedAt,
    coverage: report.coverage,
    weeklyVolume: report.weeklyVolume,
    summary: report.summary,
    unclassifiedQuestionCount: [...evidenceById.keys()]
      .filter((evidenceId) => !groupedEvidenceIds.has(evidenceId)).length,
    themes: report.themes.map((theme) => ({
      id: theme.id,
      title: theme.title,
      description: theme.description,
      sampleCount: theme.sampleCount,
      ...hydrateThemeEvidence(theme.evidenceIds, resolve),
      weeklyPulse: theme.weeklyPulse,
      grounding: theme.grounding,
    })),
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
    let deferredFailureOutcome: "provider" | "validation" | "cancelled" | "internal" | null = null;
    try {
      const history = await this.deps.historySource.read({
        workspaceId: input.workspaceId,
        analysisStart,
        analysisEnd,
        samplePolicy: DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY,
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

      const boundedHistory = boundAudiencePulseHistoryForPrompt(history);
      const prompt = buildAudiencePulsePrompt(boundedHistory);
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
          responseFormat: AUDIENCE_PULSE_RESPONSE_FORMAT,
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
          period: boundedHistory.period,
          generatedAt,
          coverage: boundedHistory.coverage,
          weeklyVolume: boundedHistory.weeklyVolume,
          evidence: boundedHistory.evidence,
          model,
        });
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
      await this.deps.snapshotStore.replace({
        workspaceId: input.workspaceId,
        period: boundedHistory.period,
        generatedAt,
        report,
        promptEvidenceRefs: promptEvidenceReferences(boundedHistory.evidence),
      });
      const hydrated = hydrateReport(report, createHydratedEvidence(boundedHistory.evidence));
      await this.recordOutcome(input, "completed", startedAt, {
        populationSize: history.coverage.populationSize,
        sampleSize: history.coverage.sampleSize,
      });
      return { kind: "completed", report: hydrated };
    } catch (error) {
      deferredFailureOutcome = errorStatusCode(error) === 503 ? "provider" : "internal";
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
