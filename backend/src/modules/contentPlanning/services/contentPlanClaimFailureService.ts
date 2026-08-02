import type {
  ContentPlanObservationVectorRecord,
  ContentPlanObservationWorkPort,
} from "../contracts/persistence.js";
import type {
  ContentPlanWorkerEventSink,
  ContentPlanWorkerFailureReason,
  ContentPlanWorkerStage,
} from "./contentPlanWorkerObservability.js";
import {
  contentPlanRetryAvailableAt,
  isContentPlanClaimActive,
  type ContentPlanWorkerOptions,
} from "./contentPlanWorkerPolicy.js";

export type ContentPlanClaimFailureDisposition = "retry" | "terminal" | "stale";

export class ContentPlanClaimFailureService {
  constructor(private readonly dependencies: {
    observationWork: Pick<ContentPlanObservationWorkPort, "failVectorClaim">;
    observability: ContentPlanWorkerEventSink;
    clock: () => Date;
    options: Pick<
      ContentPlanWorkerOptions,
      "maxAttempts" | "retryBaseDelayMs" | "retryMaxDelayMs"
    >;
  }) {}

  async settle(input: {
    record: ContentPlanObservationVectorRecord;
    stage: ContentPlanWorkerStage;
    reason: ContentPlanWorkerFailureReason;
    permanent?: boolean;
    ignoreAttemptCeiling?: boolean;
  }): Promise<ContentPlanClaimFailureDisposition> {
    const now = this.dependencies.clock();
    if (!isContentPlanClaimActive(input.record, now)) {
      this.dependencies.observability.record({
        stage: input.stage,
        outcome: "stale",
        reason: "lease_expired",
        workspaceId: input.record.workspaceId,
        generationId: input.record.generationId,
        observationId: input.record.observationId,
        attemptCount: input.record.attemptCount,
      });
      return "stale";
    }
    const terminal = input.permanent === true
      || (!input.ignoreAttemptCeiling && input.record.attemptCount >= this.dependencies.options.maxAttempts);
    const availableAt = terminal
      ? now
      : contentPlanRetryAvailableAt({
          attemptCount: input.record.attemptCount,
          now,
          options: this.dependencies.options,
        });
    let applied: boolean;
    try {
      applied = await this.dependencies.observationWork.failVectorClaim({
        workspaceId: input.record.workspaceId,
        observationId: input.record.observationId,
        generationId: input.record.generationId,
        claimToken: input.record.claimToken!,
        terminal,
        failureStage: input.stage,
        failureReason: input.reason,
        availableAt,
      });
    } catch {
      this.dependencies.observability.record({
        stage: input.stage,
        outcome: "retry_scheduled",
        reason: "claim_settlement_failed",
        workspaceId: input.record.workspaceId,
        generationId: input.record.generationId,
        observationId: input.record.observationId,
        attemptCount: input.record.attemptCount,
      });
      return "retry";
    }
    if (!applied) {
      this.dependencies.observability.record({
        stage: input.stage,
        outcome: "stale",
        reason: input.reason,
        workspaceId: input.record.workspaceId,
        generationId: input.record.generationId,
        observationId: input.record.observationId,
        attemptCount: input.record.attemptCount,
      });
      return "stale";
    }
    this.dependencies.observability.record({
      stage: input.stage,
      outcome: terminal ? "terminal_failure" : "retry_scheduled",
      reason: input.reason,
      workspaceId: input.record.workspaceId,
      generationId: input.record.generationId,
      observationId: input.record.observationId,
      attemptCount: input.record.attemptCount,
    });
    return terminal ? "terminal" : "retry";
  }
}
