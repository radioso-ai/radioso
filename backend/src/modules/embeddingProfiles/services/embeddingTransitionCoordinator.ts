import type {
  EmbeddingProfileRepositoryPort,
} from "../contracts/repositories.js";
import {
  EmbeddingProfileLifecycleError,
  type EmbeddingTransitionState,
  type WorkspaceEmbeddingProfileState,
} from "../domain/profileLifecycle.js";

export type EmbeddingTransitionCoordinatorRepository = Pick<
  EmbeddingProfileRepositoryPort,
  | "findEmbeddingSpaceById"
  | "findWorkspaceProfile"
  | "listBuildingTransitions"
  | "startTransition"
  | "cancelTransition"
  | "promoteTransitionIfEligible"
  | "failTransition"
  | "quarantineEmbeddingSpace"
>;

export interface FixedInputEmbeddingValidationPort {
  validateFixedInput(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
  }): Promise<void>;
}

export class FixedInputEmbeddingValidationError extends Error {
  constructor(
    readonly code: "contract_invalid" | "temporarily_unavailable",
  ) {
    super(
      code === "contract_invalid"
        ? "Embedding fixed-input validation detected incompatible output"
        : "Embedding fixed-input validation is temporarily unavailable",
    );
    this.name = "FixedInputEmbeddingValidationError";
  }
}

export interface EmbeddingTransitionWorkFence {
  workspaceId: string;
  transitionId: string;
  targetEmbeddingSpaceId: string;
  generation: string;
}

export interface EmbeddingTransitionBackfillPort {
  ensureTransitionWork(input: EmbeddingTransitionWorkFence): Promise<void>;
  cancelTransitionWork(input: EmbeddingTransitionWorkFence): Promise<void>;
}

export class EmbeddingTransitionCoordinatorError extends Error {
  constructor(
    readonly code:
      | "target_not_found"
      | "target_quarantined"
      | "validation_failed"
      | "validation_blocked"
      | "transition_conflict"
      | "backfill_handoff_failed"
      | "backfill_cancellation_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EmbeddingTransitionCoordinatorError";
  }
}

export interface EmbeddingTransitionStartResult {
  outcome: "started" | "already_pending";
  profile: WorkspaceEmbeddingProfileState;
  transition: EmbeddingTransitionState;
}

export interface EmbeddingTransitionPromotionResult {
  outcome:
    | "waiting"
    | "promoted"
    | "blocked"
    | "quarantined"
    | "cancelled"
    | "failed"
    | "superseded";
  profile: WorkspaceEmbeddingProfileState;
}

export class EmbeddingTransitionCoordinator {
  constructor(
    private readonly repository: EmbeddingTransitionCoordinatorRepository,
    private readonly validation: FixedInputEmbeddingValidationPort,
    private readonly backfill: EmbeddingTransitionBackfillPort,
    private readonly options: { backendKey: string },
  ) {}

  async start(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    expectedGeneration: string;
  }): Promise<EmbeddingTransitionStartResult> {
    const target = await this.repository.findEmbeddingSpaceById(
      input.targetEmbeddingSpaceId,
    );
    if (!target) {
      throw new EmbeddingTransitionCoordinatorError(
        "target_not_found",
        "Embedding transition target does not exist",
      );
    }
    if (target.status === "quarantined") {
      throw new EmbeddingTransitionCoordinatorError(
        "target_quarantined",
        "Embedding transition target is quarantined",
      );
    }

    try {
      await this.validation.validateFixedInput({
        workspaceId: input.workspaceId,
        targetEmbeddingSpaceId: input.targetEmbeddingSpaceId,
      });
    } catch (cause) {
      if (
        cause instanceof FixedInputEmbeddingValidationError
        && cause.code === "contract_invalid"
      ) {
        await this.repository.quarantineEmbeddingSpace({
          embeddingSpaceId: input.targetEmbeddingSpaceId,
          reason: "validation_failed",
        });
        throw new EmbeddingTransitionCoordinatorError(
          "validation_failed",
          "Embedding target failed fixed-input validation",
          { cause },
        );
      }
      throw new EmbeddingTransitionCoordinatorError(
        "validation_blocked",
        "Embedding target validation is temporarily unavailable",
        { cause },
      );
    }

    let started: {
      profile: WorkspaceEmbeddingProfileState;
      transition: EmbeddingTransitionState;
    };
    let outcome: EmbeddingTransitionStartResult["outcome"] = "started";
    try {
      started = await this.repository.startTransition(input);
    } catch (cause) {
      if (
        cause instanceof EmbeddingProfileLifecycleError
        && cause.code === "target_quarantined"
      ) {
        throw new EmbeddingTransitionCoordinatorError(
          "target_quarantined",
          "Embedding transition target is quarantined",
          { cause },
        );
      }
      const existing = await this.resolveConcurrentSameTarget(input, cause);
      if (!existing) {
        throw new EmbeddingTransitionCoordinatorError(
          "transition_conflict",
          "Another embedding transition is already pending",
          { cause },
        );
      }
      started = existing;
      outcome = "already_pending";
    }

    const fence = transitionFence(input.workspaceId, started.transition);
    try {
      await this.backfill.ensureTransitionWork(fence);
    } catch (cause) {
      throw new EmbeddingTransitionCoordinatorError(
        "backfill_handoff_failed",
        "Embedding transition backfill could not be durably scheduled",
        { cause },
      );
    }

    return { outcome, ...started };
  }

  async cancel(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
  }): Promise<WorkspaceEmbeddingProfileState> {
    let cancelled: WorkspaceEmbeddingProfileState;
    try {
      cancelled = await this.repository.cancelTransition({
        workspaceId: input.workspaceId,
        transitionId: input.transitionId,
        expectedGeneration: input.expectedGeneration,
      });
    } catch (cause) {
      if (
        !(cause instanceof EmbeddingProfileLifecycleError)
        || !["stale_generation", "transition_not_building"].includes(cause.code)
      ) {
        throw cause;
      }
      const existing = await this.requireWorkspaceProfile(input.workspaceId);
      if (
        existing.transition?.id !== input.transitionId
        || existing.transition.status !== "cancelled"
      ) {
        throw cause;
      }
      cancelled = existing;
    }
    const cancelledTransition = cancelled.transition;
    if (
      !cancelledTransition
      || cancelledTransition.id !== input.transitionId
      || cancelledTransition.status !== "cancelled"
    ) {
      throw new EmbeddingTransitionCoordinatorError(
        "transition_conflict",
        "Cancelled embedding transition state is inconsistent",
      );
    }
    try {
      await this.backfill.cancelTransitionWork({
        workspaceId: input.workspaceId,
        transitionId: input.transitionId,
        targetEmbeddingSpaceId: cancelledTransition.targetEmbeddingSpaceId,
        generation: cancelledTransition.generation,
      });
    } catch (cause) {
      throw new EmbeddingTransitionCoordinatorError(
        "backfill_cancellation_failed",
        "Embedding transition was cancelled but durable work cancellation must be retried",
        { cause },
      );
    }
    return cancelled;
  }

  async reconcileBackfills(input: {
    limit: number;
  }): Promise<{
    discovered: number;
    handedOff: number;
    failed: number;
  }> {
    const pending = await this.repository.listBuildingTransitions(input);
    let handedOff = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        await this.backfill.ensureTransitionWork(
          transitionFence(item.profile.workspaceId, item.transition),
        );
        handedOff += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      discovered: pending.length,
      handedOff,
      failed,
    };
  }

  async reconcilePromotion(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
  }): Promise<EmbeddingTransitionPromotionResult> {
    try {
      const profile = await this.repository.promoteTransitionIfEligible({
        ...input,
        backendKey: this.options.backendKey,
      });
      return { outcome: "promoted", profile };
    } catch (cause) {
      if (!isExpectedPromotionRace(cause)) {
        throw cause;
      }
      const profile = await this.requireWorkspaceProfile(input.workspaceId);
      return {
        outcome: promotionOutcome(profile, input.transitionId),
        profile,
      };
    }
  }

  async recordFailure(input: {
    workspaceId: string;
    transitionId: string;
    targetEmbeddingSpaceId: string;
    expectedGeneration: string;
    kind: "retryable" | "contract_drift" | "terminal";
  }): Promise<WorkspaceEmbeddingProfileState> {
    return this.repository.failTransition({
      workspaceId: input.workspaceId,
      transitionId: input.transitionId,
      expectedGeneration: input.expectedGeneration,
      status: failureStatus(input.kind),
      reason: failureReason(input.kind),
    });
  }

  private async resolveConcurrentSameTarget(
    input: {
      workspaceId: string;
      targetEmbeddingSpaceId: string;
    },
    cause: unknown,
  ): Promise<{
    profile: WorkspaceEmbeddingProfileState;
    transition: EmbeddingTransitionState;
  } | null> {
    if (
      !(cause instanceof EmbeddingProfileLifecycleError)
      || !["stale_generation", "transition_conflict"].includes(cause.code)
    ) {
      return null;
    }
    const profile = await this.repository.findWorkspaceProfile(input.workspaceId);
    const transition = profile?.transition;
    if (
      !profile
      || profile.pendingEmbeddingSpaceId !== input.targetEmbeddingSpaceId
      || !transition
      || transition.targetEmbeddingSpaceId !== input.targetEmbeddingSpaceId
      || transition.status !== "building"
    ) {
      return null;
    }
    return { profile, transition };
  }

  private async requireWorkspaceProfile(
    workspaceId: string,
  ): Promise<WorkspaceEmbeddingProfileState> {
    const profile = await this.repository.findWorkspaceProfile(workspaceId);
    if (!profile) {
      throw new EmbeddingTransitionCoordinatorError(
        "transition_conflict",
        "Workspace embedding profile does not exist",
      );
    }
    return profile;
  }
}

const transitionFence = (
  workspaceId: string,
  transition: EmbeddingTransitionState,
): EmbeddingTransitionWorkFence => ({
  workspaceId,
  transitionId: transition.id,
  targetEmbeddingSpaceId: transition.targetEmbeddingSpaceId,
  generation: transition.generation,
});

const isExpectedPromotionRace = (
  error: unknown,
): error is EmbeddingProfileLifecycleError =>
  error instanceof EmbeddingProfileLifecycleError
  && [
    "promotion_not_ready",
    "stale_generation",
    "transition_not_building",
  ].includes(error.code);

const promotionOutcome = (
  profile: WorkspaceEmbeddingProfileState,
  transitionId: string,
): EmbeddingTransitionPromotionResult["outcome"] => {
  const transition = profile.transition;
  if (!transition || transition.id !== transitionId) {
    return "superseded";
  }
  switch (transition.status) {
    case "building":
      return "waiting";
    case "promoted":
      return "promoted";
    case "blocked":
    case "quarantined":
    case "cancelled":
    case "failed":
      return transition.status;
  }
};

const failureStatus = (
  kind: "retryable" | "contract_drift" | "terminal",
): "blocked" | "quarantined" | "failed" => {
  switch (kind) {
    case "retryable":
      return "blocked";
    case "contract_drift":
      return "quarantined";
    case "terminal":
      return "failed";
  }
};

const failureReason = (
  kind: "retryable" | "contract_drift" | "terminal",
): "backfill_retry_exhausted" | "embedding_contract_drift" | "terminal_failure" => {
  switch (kind) {
    case "retryable":
      return "backfill_retry_exhausted";
    case "contract_drift":
      return "embedding_contract_drift";
    case "terminal":
      return "terminal_failure";
  }
};
