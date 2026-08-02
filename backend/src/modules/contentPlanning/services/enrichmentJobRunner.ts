import type {
  ContentPlanEnrichmentClaim,
  ContentPlanEnrichmentProcessingResult,
  ContentPlanningEnrichmentProcessor,
} from "./enrichmentProcessor.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
} from "./contentPlanWorkerObservability.js";

export const CONTENT_PLAN_ENRICHMENT_JOB_POLICY_V1 = Object.freeze({
  version: 1 as const,
  batchSize: 2,
  leaseMs: 10 * 60 * 1_000,
});

export interface ContentPlanEnrichmentClaimSourcePort {
  claimBatch(input: {
    workspaceId?: string;
    generationId?: string;
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanEnrichmentClaim[]>;
}

type EnrichmentProcessor = Pick<ContentPlanningEnrichmentProcessor, "process">;

export class ContentPlanningEnrichmentJobRunner {
  private readonly clock: () => Date;
  private readonly observability: ContentPlanWorkerEventSink;

  constructor(private readonly dependencies: {
    claims: ContentPlanEnrichmentClaimSourcePort;
    processor: EnrichmentProcessor;
    observability?: ContentPlanWorkerEventSink;
    clock?: () => Date;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.observability = dependencies.observability ?? NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY;
  }

  async runOnce(input: { workspaceId?: string; generationId?: string } = {}): Promise<{
    claimedCount: number;
    outcomes: Record<ContentPlanEnrichmentProcessingResult["status"], number>;
  }> {
    let claims: ContentPlanEnrichmentClaim[];
    try {
      claims = await this.dependencies.claims.claimBatch({
        ...input,
        limit: CONTENT_PLAN_ENRICHMENT_JOB_POLICY_V1.batchSize,
        now: this.clock(),
        leaseMs: CONTENT_PLAN_ENRICHMENT_JOB_POLICY_V1.leaseMs,
      });
    } catch (error) {
      this.observability.record({
        stage: "enrichment",
        outcome: "retry_scheduled",
        reason: "enrichment_claim_failed",
        workspaceId: input.workspaceId,
        generationId: input.generationId,
      });
      throw error;
    }
    this.observability.record({
      stage: "enrichment",
      outcome: "claimed",
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      itemCount: claims.length,
    });
    const outcomes = emptyOutcomes();
    for (const claim of claims) {
      const result = await this.dependencies.processor.process(claim);
      outcomes[result.status] += 1;
    }
    return { claimedCount: claims.length, outcomes };
  }
}

const emptyOutcomes = (): Record<ContentPlanEnrichmentProcessingResult["status"], number> => ({
  published: 0,
  stale: 0,
  retry_scheduled: 0,
  terminal_failure: 0,
});
