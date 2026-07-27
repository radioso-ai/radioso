import type {
  EmbeddingProfileTerminalFailureKind,
  EmbeddingProfileTerminalFailurePort,
} from "../../modules/documents/composition.js";
import {
  EmbeddingProfileLifecycleError,
  type EmbeddingProfileRepositoryPort,
  type EmbeddingTransitionCoordinator,
  type WorkspaceEmbeddingProfileState,
} from "../../modules/embeddingProfiles/public.js";

export class EmbeddingProfileJobFailureAdapter
implements EmbeddingProfileTerminalFailurePort {
  constructor(
    private readonly profiles: Pick<
      EmbeddingProfileRepositoryPort,
      "findWorkspaceProfile"
    >,
    private readonly coordinator: Pick<
      EmbeddingTransitionCoordinator,
      "recordFailure"
    >,
  ) {}

  async recordFailure(
    input: Parameters<EmbeddingProfileTerminalFailurePort["recordFailure"]>[0],
  ): Promise<void> {
    const profile = await this.profiles.findWorkspaceProfile(
      input.workspaceId,
    );
    const transition = matchingTransition(profile, input);
    if (!transition || transition.status !== "building") {
      return;
    }

    try {
      await this.coordinator.recordFailure({
        workspaceId: input.workspaceId,
        transitionId: transition.id,
        targetEmbeddingSpaceId: input.embeddingSpaceId,
        expectedGeneration: input.workspaceProfileGeneration,
        kind: coordinatorFailureKind(input.failureKind),
      });
    } catch (error) {
      if (!(error instanceof EmbeddingProfileLifecycleError)) {
        throw error;
      }
      const current = await this.profiles.findWorkspaceProfile(
        input.workspaceId,
      );
      const currentTransition = matchingTransition(current, input);
      if (!currentTransition || currentTransition.status !== "building") {
        return;
      }
      throw error;
    }
  }
}

const matchingTransition = (
  profile: WorkspaceEmbeddingProfileState | null,
  input: {
    embeddingSpaceId: string;
    workspaceProfileGeneration: string;
  },
): WorkspaceEmbeddingProfileState["transition"] => {
  if (
    !profile
    || profile.generation !== input.workspaceProfileGeneration
    || profile.pendingEmbeddingSpaceId !== input.embeddingSpaceId
    || profile.transition?.targetEmbeddingSpaceId !== input.embeddingSpaceId
    || profile.transition.generation !== input.workspaceProfileGeneration
  ) {
    return null;
  }
  return profile.transition;
};

const coordinatorFailureKind = (
  kind: EmbeddingProfileTerminalFailureKind,
): "retryable" | "contract_drift" | "terminal" => {
  switch (kind) {
    case "retry_exhausted":
      return "retryable";
    case "contract_invalid":
      return "contract_drift";
    case "permanent":
      return "terminal";
  }
};
