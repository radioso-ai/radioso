import type {
  ContentPlanCorpusState,
  ContentPlanEvidenceStrength,
  ContentPlanRecommendationAction,
} from "../contracts/index.js";
import type { ContentPlanSuggestedShape } from "../contracts/persistence.js";
import {
  resolveContentPlanEnrichmentRetry,
  type ContentPlanEnrichmentAnalysisMode,
  type ContentPlanEnrichmentSourceEvidence,
} from "./enrichmentScheduler.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanProviderOperation,
  type ContentPlanWorkerEventSink,
  type ContentPlanWorkerFailureReason,
  type ContentPlanWorkerOutcome,
} from "./contentPlanWorkerObservability.js";
import type {
  ContentPlanningEnrichmentService,
  ContentPlanningQuestionSample,
} from "./topicEnrichmentService.js";

export interface ContentPlanEnrichmentClaim {
  workspaceId: string;
  generationId: string;
  topicId: string;
  sourceTopicRevision: number;
  attemptCount: number;
  claimToken: string;
  analysisMode: ContentPlanEnrichmentAnalysisMode;
  recommendationState: "ready" | "outside_analysis_cap";
  sourceEvidence: ContentPlanEnrichmentSourceEvidence;
  evidenceStrength: ContentPlanEvidenceStrength;
}

export type { ContentPlanEnrichmentSourceEvidence } from "./enrichmentScheduler.js";

export interface ContentPlanEnrichmentProcessingContext {
  analysisMode: ContentPlanEnrichmentAnalysisMode;
  recommendationState: "ready" | "outside_analysis_cap";
  samples: readonly ContentPlanningQuestionSample[];
  action: ContentPlanRecommendationAction | null;
  corpusState: ContentPlanCorpusState;
  corpusCheckedAt: Date | null;
  sourceEvidence: ContentPlanEnrichmentSourceEvidence;
  evidenceStrength: ContentPlanEvidenceStrength;
  corpusEvidenceFingerprint: string;
}

export interface ContentPlanEnrichmentContextPort {
  load(claim: ContentPlanEnrichmentClaim): Promise<ContentPlanEnrichmentProcessingContext | null>;
}

export interface ContentPlanEnrichmentPublicationPort {
  publish(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    claimToken: string;
    publishState: "ready" | "outside_analysis_cap";
    label: string;
    description: string;
    suggestedTitle: string | null;
    rationale: string | null;
    questionsToAnswer: readonly string[] | null;
    suggestedShape: ContentPlanSuggestedShape | null;
    evidenceStatement: string | null;
    action: ContentPlanRecommendationAction | null;
    actionRuleVersion: 1;
    corpusState: ContentPlanCorpusState;
    corpusCheckedAt: Date | null;
    sourceEvidence: ContentPlanEnrichmentSourceEvidence;
    evidenceStrength: ContentPlanEvidenceStrength;
    corpusEvidenceFingerprint: string;
    enrichedAt: Date;
  }): Promise<boolean>;
  fail(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    claimToken: string;
    terminal: boolean;
    failureStage: "evidence_assembly" | "label_generation" | "brief_generation";
    failureReason: "context_unavailable" | "provider_error" | "invalid_output";
    availableAt: Date;
  }): Promise<boolean>;
}

type EnrichmentGenerator = Pick<
  ContentPlanningEnrichmentService,
  "generateLabel" | "generateBrief"
>;

export type ContentPlanEnrichmentProcessingResult =
  | { status: "published" }
  | { status: "stale" }
  | { status: "retry_scheduled" }
  | { status: "terminal_failure" };

export class ContentPlanningEnrichmentProcessor {
  private readonly clock: () => Date;
  private readonly observability: ContentPlanWorkerEventSink;

  constructor(private readonly dependencies: {
    generator: EnrichmentGenerator;
    context: ContentPlanEnrichmentContextPort;
    store: ContentPlanEnrichmentPublicationPort;
    observability?: ContentPlanWorkerEventSink;
    clock?: () => Date;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.observability = dependencies.observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
  }

  async process(claim: ContentPlanEnrichmentClaim): Promise<ContentPlanEnrichmentProcessingResult> {
    const startedAt = Date.now();
    let context: ContentPlanEnrichmentProcessingContext | null;
    try {
      context = await this.dependencies.context.load(claim);
    } catch {
      context = null;
    }
    if (!context) {
      const result = await this.fail(claim, "evidence_assembly", "context_unavailable");
      this.recordOutcome(claim, result, startedAt, "enrichment_context_unavailable");
      return result;
    }

    const labelStartedAt = Date.now();
    const label = await this.dependencies.generator.generateLabel({
      workspaceId: claim.workspaceId,
      topicId: claim.topicId,
      topicRevision: claim.sourceTopicRevision,
      samples: context.samples,
    });
    this.recordProviderCall(
      claim,
      "topic_label",
      label.state === "ready" ? "completed" : "retry_scheduled",
      label.state === "ready" ? undefined : mapEnrichmentFailureReason(label.reason),
      labelStartedAt,
    );
    if (label.state !== "ready") {
      const result = await this.fail(claim, "label_generation", label.reason);
      this.recordOutcome(claim, result, startedAt, mapEnrichmentFailureReason(label.reason));
      return result;
    }

    let brief: {
      rationale: string;
      suggestedTitle: string;
      questionsToAnswer: string[];
      suggestedShape: ContentPlanSuggestedShape;
      evidenceStatement: string;
    } | null = null;
    if (context.analysisMode === "label_and_brief") {
      const briefStartedAt = Date.now();
      const generated = await this.dependencies.generator.generateBrief({
        workspaceId: claim.workspaceId,
        topicId: claim.topicId,
        topicRevision: claim.sourceTopicRevision,
        label: label.label,
        samples: context.samples,
        evidence: {
          ...context.sourceEvidence,
          strength: context.evidenceStrength,
          action: context.action,
        },
      });
      this.recordProviderCall(
        claim,
        "content_brief",
        generated.state === "ready" ? "completed" : "retry_scheduled",
        generated.state === "ready" ? undefined : mapEnrichmentFailureReason(generated.reason),
        briefStartedAt,
      );
      if (generated.state !== "ready") {
        const result = await this.fail(claim, "brief_generation", generated.reason);
        this.recordOutcome(claim, result, startedAt, mapEnrichmentFailureReason(generated.reason));
        return result;
      }
      brief = generated;
    }

    const published = await this.dependencies.store.publish({
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      topicId: claim.topicId,
      sourceTopicRevision: claim.sourceTopicRevision,
      claimToken: claim.claimToken,
      publishState: context.recommendationState,
      label: label.label,
      description: label.description,
      suggestedTitle: brief?.suggestedTitle ?? null,
      rationale: brief?.rationale ?? null,
      questionsToAnswer: brief?.questionsToAnswer ?? null,
      suggestedShape: brief?.suggestedShape ?? null,
      evidenceStatement: brief?.evidenceStatement ?? null,
      action: context.analysisMode === "label_and_brief" ? context.action : null,
      actionRuleVersion: 1,
      corpusState: context.corpusState,
      corpusCheckedAt: context.corpusCheckedAt,
      sourceEvidence: context.sourceEvidence,
      evidenceStrength: context.evidenceStrength,
      corpusEvidenceFingerprint: context.corpusEvidenceFingerprint,
      enrichedAt: this.clock(),
    });
    const result = published
      ? { status: "published" as const }
      : { status: "stale" as const };
    this.recordOutcome(claim, result, startedAt);
    return result;
  }

  private recordProviderCall(
    claim: ContentPlanEnrichmentClaim,
    providerOperation: ContentPlanProviderOperation,
    outcome: "completed" | "retry_scheduled",
    reason: ContentPlanWorkerFailureReason | undefined,
    startedAt: number,
  ): void {
    this.observability.record({
      stage: "enrichment",
      outcome,
      ...(reason ? { reason } : {}),
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      topicId: claim.topicId,
      revision: claim.sourceTopicRevision,
      durationMs: Math.max(0, Date.now() - startedAt),
      providerOperation,
      providerCallCount: 1,
    });
  }

  private recordOutcome(
    claim: ContentPlanEnrichmentClaim,
    result: ContentPlanEnrichmentProcessingResult,
    startedAt: number,
    reason?: ContentPlanWorkerFailureReason,
  ): void {
    this.observability.record({
      stage: "enrichment",
      outcome: enrichmentOutcome(result),
      ...(reason ? { reason } : {}),
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      topicId: claim.topicId,
      attemptCount: claim.attemptCount,
      durationMs: Math.max(0, Date.now() - startedAt),
      revision: claim.sourceTopicRevision,
    });
  }

  private async fail(
    claim: ContentPlanEnrichmentClaim,
    failureStage: Parameters<ContentPlanEnrichmentPublicationPort["fail"]>[0]["failureStage"],
    failureReason: Parameters<ContentPlanEnrichmentPublicationPort["fail"]>[0]["failureReason"],
  ): Promise<ContentPlanEnrichmentProcessingResult> {
    const retry = resolveContentPlanEnrichmentRetry({
      attemptCount: claim.attemptCount,
      now: this.clock(),
    });
    const applied = await this.dependencies.store.fail({
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      topicId: claim.topicId,
      sourceTopicRevision: claim.sourceTopicRevision,
      claimToken: claim.claimToken,
      terminal: retry.terminal,
      failureStage,
      failureReason,
      availableAt: retry.availableAt,
    });
    if (!applied) return { status: "stale" };
    return retry.terminal ? { status: "terminal_failure" } : { status: "retry_scheduled" };
  }
}

const mapEnrichmentFailureReason = (
  reason: "provider_error" | "invalid_output",
): ContentPlanWorkerFailureReason => reason === "provider_error"
  ? "enrichment_provider_error"
  : "enrichment_invalid_output";

const enrichmentOutcome = (
  result: ContentPlanEnrichmentProcessingResult,
): ContentPlanWorkerOutcome => result.status;
