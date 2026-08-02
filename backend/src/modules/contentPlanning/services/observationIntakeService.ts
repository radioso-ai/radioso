import type { ConversationInteractionRole } from "@radioso/conversation-contract";
import { randomUUID } from "node:crypto";

import { isOperatorTestSourceChannel } from "../../../shared/domain/conversationSource.js";
import type { SemanticVectorEnvelope } from "../../retrieval/public.js";
import type {
  ContentPlanObservationIntakePort,
  ContentPlanProjectionRepositoryPort,
  ContentPlanTurnContribution,
  ContentPlanTurnRegistrationResult,
  ContentPlanVectorWorkInput,
} from "../contracts/persistence.js";
import {
  decideObservationEligibility,
  type PendingObservationContribution,
  type ReadyObservationContribution,
} from "../domain/observationEligibility.js";

export const DEFAULT_PENDING_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;
const EXPIRED_BY_NEXT_TURN_REASON = "superseded_by_next_turn";

type WritableGenerationPort = Pick<
  ContentPlanProjectionRepositoryPort,
  "resolveWritableGeneration"
> & Partial<Pick<
  ContentPlanProjectionRepositoryPort,
  "ensureTargetGenerationForIntake"
>>;

export interface ObservationIntakeSummary {
  status: "processed" | "skipped" | "projection_unavailable";
  acceptedCount: number;
  duplicateCount: number;
  truncatedCount: number;
  finalizedCount: number;
  excludedCount: number;
}

export interface ObservationIntakeServiceOptions {
  clock?: () => Date;
  pendingContextTtlMs?: number;
  generationIdFactory?: () => string;
  projectionHorizonMs?: number;
  projectionPolicyVersion?: number;
  projectionBudgetVersion?: number;
}

const DEFAULT_PROJECTION_HORIZON_MS = 60 * 24 * 60 * 60 * 1_000;

/** Consumer-specific view of Chat's neutral committed-turn envelope. */
export interface ObservationTurnIntakeInput {
  workspaceId: string;
  conversationId: string;
  sourceChannel?: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  interaction: {
    role: ConversationInteractionRole;
    semanticIntents: ReadonlyArray<{ id: string; text: string }>;
  };
  semanticVectors: ReadonlyArray<SemanticVectorEnvelope>;
  expiresUnresolvedSourceUserMessageId?: string;
}

const emptySummary = (
  status: ObservationIntakeSummary["status"],
): ObservationIntakeSummary => ({
  status,
  acceptedCount: 0,
  duplicateCount: 0,
  truncatedCount: 0,
  finalizedCount: 0,
  excludedCount: 0,
});

const compatibleReusableVector = (input: {
  contribution: ReadyObservationContribution;
  embeddingSpaceId: string;
  semanticVectors: ReadonlyArray<SemanticVectorEnvelope>;
}): SemanticVectorEnvelope | undefined =>
  input.semanticVectors.find((vector) =>
    vector.intentId === input.contribution.semanticIntentId &&
    vector.semanticTextHash === input.contribution.semanticTextHash &&
    vector.space.id === input.embeddingSpaceId &&
    vector.space.dimensions === vector.vector.length &&
    vector.vector.length > 0 &&
    vector.vector.every(Number.isFinite),
  );

const reusableVectorSpaceFor = (input: {
  contributions: readonly ReadyObservationContribution[];
  semanticVectors: ReadonlyArray<SemanticVectorEnvelope>;
}): string | undefined => {
  const contributions = new Map(
    input.contributions.map((contribution) => [contribution.semanticIntentId, contribution]),
  );
  return input.semanticVectors.find((vector) => {
    const contribution = contributions.get(vector.intentId);
    return contribution?.semanticTextHash === vector.semanticTextHash
      && vector.space.dimensions === vector.vector.length
      && vector.vector.length > 0
      && vector.vector.every(Number.isFinite);
  })?.space.id;
};

const utcDayStart = (value: Date): Date => new Date(Date.UTC(
  value.getUTCFullYear(),
  value.getUTCMonth(),
  value.getUTCDate(),
));

const vectorWorkFor = (input: {
  contribution: ReadyObservationContribution;
  generationId: string;
  embeddingSpaceId: string;
  semanticVectors: ReadonlyArray<SemanticVectorEnvelope>;
}): ContentPlanVectorWorkInput => {
  const reusable = compatibleReusableVector(input);
  return {
    generationId: input.generationId,
    embeddingSpaceId: input.embeddingSpaceId,
    ...(reusable
      ? {
          dimensions: reusable.space.dimensions,
          embedding: [...reusable.vector],
          vectorSource: "reused" as const,
        }
      : {}),
  };
};

const addRegistrationResult = (
  summary: ObservationIntakeSummary,
  result: ContentPlanTurnRegistrationResult,
): void => {
  summary.acceptedCount += result.acceptedCount;
  summary.duplicateCount += result.duplicateCount;
  summary.truncatedCount += result.truncatedCount;
};

export class ObservationIntakeService {
  private readonly clock: () => Date;
  private readonly pendingContextTtlMs: number;
  private readonly generationIdFactory: () => string;
  private readonly projectionHorizonMs: number;
  private readonly projectionPolicyVersion: number;
  private readonly projectionBudgetVersion: number;

  constructor(
    private readonly observations: ContentPlanObservationIntakePort,
    private readonly generations: WritableGenerationPort,
    options: ObservationIntakeServiceOptions = {},
  ) {
    const pendingContextTtlMs = options.pendingContextTtlMs ?? DEFAULT_PENDING_CONTEXT_TTL_MS;
    if (!Number.isSafeInteger(pendingContextTtlMs) || pendingContextTtlMs <= 0) {
      throw new RangeError("pending context TTL must be a positive safe integer");
    }
    this.clock = options.clock ?? (() => new Date());
    this.pendingContextTtlMs = pendingContextTtlMs;
    this.generationIdFactory = options.generationIdFactory ?? randomUUID;
    this.projectionHorizonMs = options.projectionHorizonMs ?? DEFAULT_PROJECTION_HORIZON_MS;
    this.projectionPolicyVersion = options.projectionPolicyVersion ?? 1;
    this.projectionBudgetVersion = options.projectionBudgetVersion ?? 1;
    for (const value of [
      this.projectionHorizonMs,
      this.projectionPolicyVersion,
      this.projectionBudgetVersion,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError("projection intake options must be positive safe integers");
      }
    }
  }

  async registerCommittedTurn(
    input: ObservationTurnIntakeInput,
  ): Promise<ObservationIntakeSummary> {
    if (isOperatorTestSourceChannel(input.sourceChannel)) {
      return emptySummary("skipped");
    }

    const summary = emptySummary("processed");
    await this.excludeSupersededPendingContext(input, summary);

    const resolutionDeadline = new Date(this.clock().getTime() + this.pendingContextTtlMs);
    const decision = decideObservationEligibility({
      interaction: input.interaction,
      sourceUserMessageId: input.sourceUserMessageId,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
      populationEligible: true,
      resolutionDeadline,
    });
    summary.truncatedCount += decision.kind === "register" || decision.kind === "finalize_pending"
      ? decision.truncatedCount
      : 0;

    if (decision.kind === "skip") {
      return summary.excludedCount > 0 ? summary : emptySummary("skipped");
    }
    if (decision.kind === "exclude_pending") {
      const pending = await this.observations.findPendingContext({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        sourceUserMessageId: decision.sourceUserMessageId,
      });
      if (pending) {
        const excluded = await this.observations.excludePendingContext({
          workspaceId: input.workspaceId,
          observationId: pending.id,
          excludedReason: decision.reason,
          sourceAssistantMessageId: input.sourceAssistantMessageId,
        });
        summary.excludedCount += excluded ? 1 : 0;
      }
      return summary;
    }

    const pendingContributions = decision.contributions.filter(
      (contribution): contribution is PendingObservationContribution =>
        contribution.observationState === "pending_context",
    );
    if (pendingContributions.length > 0) {
      const result = await this.observations.registerTurn({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        sourceUserMessageId: decision.sourceUserMessageId,
        sourceAssistantMessageId: decision.sourceAssistantMessageId,
        interactionRole: decision.role,
        contributions: pendingContributions,
      });
      addRegistrationResult(summary, result);
      return summary;
    }

    const readyContributions = decision.contributions.filter(
      (contribution): contribution is ReadyObservationContribution =>
        contribution.observationState === "ready",
    );
    let generation = await this.generations.resolveWritableGeneration({
      workspaceId: input.workspaceId,
    });
    if (!generation && this.generations.ensureTargetGenerationForIntake) {
      const horizonTo = this.clock();
      generation = await this.generations.ensureTargetGenerationForIntake({
        workspaceId: input.workspaceId,
        preferredEmbeddingSpaceId: reusableVectorSpaceFor({
          contributions: readyContributions,
          semanticVectors: input.semanticVectors,
        }),
        generationId: this.generationIdFactory(),
        policyVersion: this.projectionPolicyVersion,
        horizonFrom: new Date(horizonTo.getTime() - this.projectionHorizonMs),
        horizonTo,
        budgetVersion: this.projectionBudgetVersion,
        budgetWindowStartedAt: utcDayStart(horizonTo),
      });
    }
    if (!generation) {
      return {
        ...summary,
        status: "projection_unavailable",
      };
    }
    const durableContributions = readyContributions.map((contribution) => ({
      ...contribution,
      vectorWork: vectorWorkFor({
        contribution,
        generationId: generation.id,
        embeddingSpaceId: generation.embeddingSpaceId,
        semanticVectors: input.semanticVectors,
      }),
    })) satisfies ContentPlanTurnContribution[];

    if (decision.kind === "finalize_pending") {
      await this.finalizePendingContext(input, "clarification_value", durableContributions, summary);
      return summary;
    }

    const result = await this.observations.registerTurn({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceUserMessageId: decision.sourceUserMessageId,
      sourceAssistantMessageId: decision.sourceAssistantMessageId,
      interactionRole: decision.role,
      contributions: durableContributions,
    });
    addRegistrationResult(summary, result);
    return summary;
  }

  private async excludeSupersededPendingContext(
    input: ObservationTurnIntakeInput,
    summary: ObservationIntakeSummary,
  ): Promise<void> {
    const currentRoleResolvesPending =
      input.interaction.role !== "unresolved" &&
      input.interaction.role !== "clarification_value";
    if (!input.expiresUnresolvedSourceUserMessageId && !currentRoleResolvesPending) {
      return;
    }
    const pending = await this.observations.findPendingContext({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      ...(input.expiresUnresolvedSourceUserMessageId
        ? { sourceUserMessageId: input.expiresUnresolvedSourceUserMessageId }
        : {}),
    });
    if (!pending) {
      return;
    }
    const excluded = await this.observations.excludePendingContext({
      workspaceId: input.workspaceId,
      observationId: pending.id,
      excludedReason: EXPIRED_BY_NEXT_TURN_REASON,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
    });
    summary.excludedCount += excluded ? 1 : 0;
  }

  private async finalizePendingContext(
    input: ObservationTurnIntakeInput,
    interactionRole: "clarification_value",
    contributions: Array<Extract<ContentPlanTurnContribution, { observationState: "ready" }>>,
    summary: ObservationIntakeSummary,
  ): Promise<void> {
    const pending = await this.observations.findPendingContext({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceUserMessageId: input.sourceUserMessageId,
    });
    const first = contributions[0];
    let remaining = contributions;
    if (pending && first) {
      const finalized = await this.observations.finalizePendingContext({
        workspaceId: input.workspaceId,
        observationId: pending.id,
        sourceAssistantMessageId: input.sourceAssistantMessageId,
        semanticIntentId: first.semanticIntentId,
        semanticTextHash: first.semanticTextHash,
        interactionRole,
        vectorWork: first.vectorWork,
      });
      if (finalized) {
        summary.finalizedCount += 1;
        remaining = contributions.slice(1);
      }
    }
    if (remaining.length === 0) {
      return;
    }
    const result = await this.observations.registerTurn({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceUserMessageId: input.sourceUserMessageId,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
      interactionRole,
      contributions: remaining,
    });
    addRegistrationResult(summary, result);
  }
}
