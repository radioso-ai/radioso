export type EmbeddingTransitionStatus =
  | "building"
  | "blocked"
  | "quarantined"
  | "cancelled"
  | "promoted"
  | "failed";

export type EmbeddingTransitionFailureStatus =
  | "blocked"
  | "quarantined"
  | "failed";

export type EmbeddingTransitionFailureReason =
  | "validation_failed"
  | "backfill_retry_exhausted"
  | "embedding_contract_drift"
  | "terminal_failure";

export interface EmbeddingTransitionState {
  id: string;
  sourceEmbeddingSpaceId: string;
  targetEmbeddingSpaceId: string;
  generation: string;
  status: EmbeddingTransitionStatus;
  failureReason: EmbeddingTransitionFailureReason | null;
}

export interface WorkspaceEmbeddingProfileState {
  workspaceId: string;
  activeEmbeddingSpaceId: string;
  pendingEmbeddingSpaceId: string | null;
  generation: string;
  transition: EmbeddingTransitionState | null;
}

export interface EmbeddingTransitionFence {
  transitionId: string;
  targetEmbeddingSpaceId: string;
  generation: string;
}

export interface EmbeddingPromotionReadiness {
  transitionId: string;
  expectedGeneration: string;
  canonicalCoverageComplete: boolean;
  vectorIndexReady: boolean;
  hasInFlightWork: boolean;
}

export class EmbeddingProfileLifecycleError extends Error {
  constructor(
    readonly code:
      | "stale_generation"
      | "transition_conflict"
      | "active_target"
      | "target_quarantined"
      | "transition_not_building"
      | "promotion_not_ready",
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingProfileLifecycleError";
  }
}

const parseGeneration = (value: string): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new EmbeddingProfileLifecycleError(
      "stale_generation",
      "Workspace embedding profile generation must be an unsigned decimal integer",
    );
  }
  return BigInt(value);
};

const nextGeneration = (value: string): string => (parseGeneration(value) + 1n).toString();

const assertExpectedGeneration = (
  profile: WorkspaceEmbeddingProfileState,
  expectedGeneration: string,
): void => {
  if (profile.generation !== expectedGeneration) {
    throw new EmbeddingProfileLifecycleError(
      "stale_generation",
      `Stale workspace embedding profile generation: expected ${expectedGeneration}, current ${profile.generation}`,
    );
  }
};

const assertBuildingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  transitionId: string,
): EmbeddingTransitionState => {
  const transition = profile.transition;
  if (!transition || transition.id !== transitionId || transition.status !== "building") {
    throw new EmbeddingProfileLifecycleError(
      "transition_not_building",
      "Embedding transition is not the current building transition",
    );
  }
  return transition;
};

const assertUnpromotedTransition = (
  profile: WorkspaceEmbeddingProfileState,
  transitionId: string,
): EmbeddingTransitionState => {
  const transition = profile.transition;
  if (
    !transition
    || transition.id !== transitionId
    || !["building", "blocked", "quarantined"].includes(transition.status)
  ) {
    throw new EmbeddingProfileLifecycleError(
      "transition_not_building",
      "Embedding transition is not the current unpromoted transition",
    );
  }
  return transition;
};

export const beginEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  input: {
    transitionId: string;
    targetEmbeddingSpaceId: string;
    expectedGeneration: string;
  },
): { profile: WorkspaceEmbeddingProfileState; transition: EmbeddingTransitionState } => {
  assertExpectedGeneration(profile, input.expectedGeneration);
  if (input.targetEmbeddingSpaceId === profile.activeEmbeddingSpaceId) {
    throw new EmbeddingProfileLifecycleError("active_target", "Embedding space is already active");
  }
  if (profile.pendingEmbeddingSpaceId || (profile.transition && !isTerminal(profile.transition.status))) {
    throw new EmbeddingProfileLifecycleError(
      "transition_conflict",
      "Another embedding transition is already pending",
    );
  }

  const generation = nextGeneration(profile.generation);
  const transition: EmbeddingTransitionState = {
    id: input.transitionId,
    sourceEmbeddingSpaceId: profile.activeEmbeddingSpaceId,
    targetEmbeddingSpaceId: input.targetEmbeddingSpaceId,
    generation,
    status: "building",
    failureReason: null,
  };

  return {
    profile: {
      ...profile,
      pendingEmbeddingSpaceId: input.targetEmbeddingSpaceId,
      generation,
      transition,
    },
    transition,
  };
};

export const canCommitEmbeddingTransitionWork = (
  profile: WorkspaceEmbeddingProfileState,
  fence: EmbeddingTransitionFence,
): boolean =>
  profile.generation === fence.generation
  && profile.pendingEmbeddingSpaceId === fence.targetEmbeddingSpaceId
  && profile.transition?.id === fence.transitionId
  && profile.transition.targetEmbeddingSpaceId === fence.targetEmbeddingSpaceId
  && profile.transition.status === "building";

export const canPromoteEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  readiness: EmbeddingPromotionReadiness,
): boolean =>
  profile.generation === readiness.expectedGeneration
  && profile.transition?.id === readiness.transitionId
  && profile.transition.status === "building"
  && profile.pendingEmbeddingSpaceId === profile.transition.targetEmbeddingSpaceId
  && readiness.canonicalCoverageComplete
  && readiness.vectorIndexReady
  && !readiness.hasInFlightWork;

export const promoteEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  readiness: EmbeddingPromotionReadiness,
): WorkspaceEmbeddingProfileState => {
  if (!canPromoteEmbeddingTransition(profile, readiness)) {
    throw new EmbeddingProfileLifecycleError(
      "promotion_not_ready",
      "Embedding transition is not ready for promotion",
    );
  }

  const transition = profile.transition!;
  return {
    ...profile,
    activeEmbeddingSpaceId: transition.targetEmbeddingSpaceId,
    pendingEmbeddingSpaceId: null,
    generation: nextGeneration(profile.generation),
    transition: {
      ...transition,
      status: "promoted",
    },
  };
};

export const cancelEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  input: { transitionId: string; expectedGeneration: string },
): WorkspaceEmbeddingProfileState => {
  assertExpectedGeneration(profile, input.expectedGeneration);
  const transition = assertUnpromotedTransition(profile, input.transitionId);
  return {
    ...profile,
    pendingEmbeddingSpaceId: null,
    generation: nextGeneration(profile.generation),
    transition: {
      ...transition,
      status: "cancelled",
    },
  };
};

export const blockEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  input: {
    transitionId: string;
    expectedGeneration: string;
    reason: EmbeddingTransitionFailureReason;
  },
): WorkspaceEmbeddingProfileState =>
  failTransition(profile, input, "blocked");

export const quarantineEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  input: {
    transitionId: string;
    expectedGeneration: string;
    reason: EmbeddingTransitionFailureReason;
  },
): WorkspaceEmbeddingProfileState =>
  failTransition(profile, input, "quarantined");

export const failEmbeddingTransition = (
  profile: WorkspaceEmbeddingProfileState,
  input: {
    transitionId: string;
    expectedGeneration: string;
    reason: EmbeddingTransitionFailureReason;
  },
): WorkspaceEmbeddingProfileState => {
  assertExpectedGeneration(profile, input.expectedGeneration);
  const transition = assertBuildingTransition(profile, input.transitionId);
  return {
    ...profile,
    pendingEmbeddingSpaceId: null,
    generation: nextGeneration(profile.generation),
    transition: {
      ...transition,
      status: "failed",
      failureReason: input.reason,
    },
  };
};

const failTransition = (
  profile: WorkspaceEmbeddingProfileState,
  input: {
    transitionId: string;
    expectedGeneration: string;
    reason: EmbeddingTransitionFailureReason;
  },
  status: "blocked" | "quarantined",
): WorkspaceEmbeddingProfileState => {
  assertExpectedGeneration(profile, input.expectedGeneration);
  const transition = assertBuildingTransition(profile, input.transitionId);
  return {
    ...profile,
    transition: {
      ...transition,
      status,
      failureReason: input.reason,
    },
  };
};

export const canCleanupEmbeddingSpace = (input: {
  now: Date;
  cleanupAfter: Date;
  isActive: boolean;
  isPending: boolean;
  hasInFlightWork: boolean;
  hasRebuildReference: boolean;
}): boolean =>
  input.now.getTime() >= input.cleanupAfter.getTime()
  && !input.isActive
  && !input.isPending
  && !input.hasInFlightWork
  && !input.hasRebuildReference;

const isTerminal = (status: EmbeddingTransitionStatus): boolean =>
  status === "cancelled" || status === "promoted" || status === "failed";
