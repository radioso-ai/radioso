import {
  EmbeddingTransitionCoordinatorError,
  EmbeddingVectorContractError,
  FixedInputEmbeddingValidationError,
  type EmbeddingProfileRepositoryPort,
  type EmbeddingProviderImplementation,
  type EmbeddingTransitionCoordinator,
  type FixedInputEmbeddingValidationPort,
  type WorkspaceEmbeddingProfileState,
} from "../../modules/embeddingProfiles/public.js";
import type {
  EmbeddingModelTransitionPort,
  EmbeddingModelTransitionState,
} from "../../modules/settings/composition.js";
import {
  AppError,
  badRequest,
  conflict,
  serviceUnavailable,
} from "../../shared/domain/errors.js";
import {
  EXISTING_WORKSPACE_EMBEDDING_DIMENSIONS,
  ModelEmbeddingSpaceMaterializer,
  requireEmbeddingProvider,
  type EmbeddingModelBindingMetadata,
} from "./modelEmbeddingSpaceMaterializer.js";
import type { EmbeddingSpaceRef } from "../../modules/embeddingProfiles/contracts/embeddingConsumers.js";

type TransitionProfiles = Pick<
  EmbeddingProfileRepositoryPort,
  | "createEmbeddingSpace"
  | "findEmbeddingSpaceById"
  | "findWorkspaceProfile"
  | "initializeWorkspaceProfile"
>;

type TransitionCommands = Pick<
  EmbeddingTransitionCoordinator,
  "start" | "cancel" | "reconcilePromotion"
>;

export interface EmbeddingTransitionIndexPreparationPort {
  prepare(input: {
    workspaceId: string;
    space: EmbeddingSpaceRef;
  }): Promise<void>;
}

export class EmbeddingModelTransitionAdapter
implements EmbeddingModelTransitionPort {
  private readonly spaces: ModelEmbeddingSpaceMaterializer;

  constructor(
    private readonly profiles: TransitionProfiles,
    identifyModel: (model: string) => EmbeddingModelBindingMetadata,
    private readonly coordinator: TransitionCommands,
    private readonly indexPreparation: EmbeddingTransitionIndexPreparationPort,
  ) {
    this.spaces = new ModelEmbeddingSpaceMaterializer(
      profiles,
      identifyModel,
    );
  }

  async getState(
    workspaceId: string,
  ): Promise<EmbeddingModelTransitionState | null> {
    const profile = await this.profiles.findWorkspaceProfile(workspaceId);
    return profile ? this.present(profile) : null;
  }

  async start(input: {
    workspaceId: string;
    activeModel: string;
    targetModel: Parameters<EmbeddingModelTransitionPort["start"]>[0]["targetModel"];
  }): Promise<EmbeddingModelTransitionState> {
    try {
      const profile = await this.ensureProfile(
        input.workspaceId,
        input.activeModel,
      );
      const target = await this.spaces.ensure(input.targetModel);
      if (
        profile.activeEmbeddingSpaceId === target.id
        && !profile.pendingEmbeddingSpaceId
      ) {
        return this.present(profile);
      }
      if (target.status === "quarantined") {
        throw new EmbeddingTransitionCoordinatorError(
          "target_quarantined",
          "Embedding transition target is quarantined",
        );
      }
      await this.indexPreparation.prepare({
        workspaceId: input.workspaceId,
        space: {
          id: target.id,
          dimensions: target.dimensions,
          distanceMetric: target.distanceMetric,
        },
      });
      const started = await this.coordinator.start({
        workspaceId: input.workspaceId,
        targetEmbeddingSpaceId: target.id,
        expectedGeneration: profile.generation,
      });
      return this.present(started.profile);
    } catch (error) {
      throw safeTransitionError(error);
    }
  }

  async cancel(workspaceId: string): Promise<EmbeddingModelTransitionState> {
    const profile = await this.requireProfile(workspaceId);
    const transition = profile.transition;
    if (
      !transition
      || !["building", "blocked", "quarantined"].includes(transition.status)
    ) {
      return this.present(profile);
    }
    try {
      const cancelled = await this.coordinator.cancel({
        workspaceId,
        transitionId: transition.id,
        expectedGeneration: profile.generation,
      });
      return this.present(cancelled);
    } catch (error) {
      throw safeTransitionError(error);
    }
  }

  async reconcile(
    workspaceId: string,
  ): Promise<EmbeddingModelTransitionState | null> {
    const profile = await this.profiles.findWorkspaceProfile(workspaceId);
    const transition = profile?.transition;
    if (!profile || !transition || transition.status !== "building") {
      return profile ? this.present(profile) : null;
    }
    try {
      const result = await this.coordinator.reconcilePromotion({
        workspaceId,
        transitionId: transition.id,
        expectedGeneration: profile.generation,
      });
      return this.present(result.profile);
    } catch (error) {
      throw safeTransitionError(error);
    }
  }

  private async ensureProfile(
    workspaceId: string,
    activeModel: string,
  ): Promise<WorkspaceEmbeddingProfileState> {
    const existing = await this.profiles.findWorkspaceProfile(workspaceId);
    if (existing) {
      return existing;
    }
    const active = await this.spaces.ensureExistingSelection(
      activeModel,
      EXISTING_WORKSPACE_EMBEDDING_DIMENSIONS,
    );
    return this.profiles.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
  }

  private async requireProfile(
    workspaceId: string,
  ): Promise<WorkspaceEmbeddingProfileState> {
    const profile = await this.profiles.findWorkspaceProfile(workspaceId);
    if (!profile) {
      throw serviceUnavailable(
        "Embedding model transition state is temporarily unavailable",
      );
    }
    return profile;
  }

  private async present(
    profile: WorkspaceEmbeddingProfileState,
  ): Promise<EmbeddingModelTransitionState> {
    const [active, pending] = await Promise.all([
      this.profiles.findEmbeddingSpaceById(
        profile.activeEmbeddingSpaceId,
      ),
      profile.pendingEmbeddingSpaceId
        ? this.profiles.findEmbeddingSpaceById(
            profile.pendingEmbeddingSpaceId,
          )
        : Promise.resolve(null),
    ]);
    if (!active || (profile.pendingEmbeddingSpaceId && !pending)) {
      throw serviceUnavailable(
        "Embedding model transition state is temporarily unavailable",
      );
    }
    const status = profile.transition?.status ?? "idle";
    return {
      activeModel: active.model,
      pendingModel: pending
        ? requireSupportedSettingsModel(pending.model)
        : null,
      status,
      readiness: transitionReadiness(status),
      failureReason: profile.transition?.failureReason ?? null,
    };
  }
}

interface EmbeddingModelProbeRegistry {
  createEmbeddingModelProbe(
    model: string,
    provider?: EmbeddingProviderImplementation,
    endpointScopeFingerprint?: string,
  ): {
    probe(workspaceId?: string): Promise<unknown>;
  };
}

export class RegistryFixedInputEmbeddingValidation
implements FixedInputEmbeddingValidationPort {
  constructor(
    private readonly profiles: Pick<
      EmbeddingProfileRepositoryPort,
      "findEmbeddingSpaceById"
    >,
    private readonly registry: EmbeddingModelProbeRegistry,
  ) {}

  async validateFixedInput(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
  }): Promise<void> {
    const target = await this.profiles.findEmbeddingSpaceById(
      input.targetEmbeddingSpaceId,
    );
    if (!target) {
      throw new FixedInputEmbeddingValidationError(
        "temporarily_unavailable",
      );
    }
    try {
      await this.registry
        .createEmbeddingModelProbe(
          target.model,
          requireEmbeddingProvider(target.provider),
          target.endpointScopeFingerprint,
        )
        .probe(input.workspaceId);
    } catch (error) {
      throw new FixedInputEmbeddingValidationError(
        error instanceof EmbeddingVectorContractError
          ? "contract_invalid"
          : "temporarily_unavailable",
      );
    }
  }
}

const requireSupportedSettingsModel = (
  model: string,
): Parameters<EmbeddingModelTransitionPort["start"]>[0]["targetModel"] => {
  switch (model) {
    case "text-embedding-3-small":
    case "text-embedding-3-large":
    case "text-embedding-ada-002":
    case "gemini-embedding-001":
      return model;
    default:
      throw serviceUnavailable(
        "Embedding model transition state is temporarily unavailable",
      );
  }
};

const transitionReadiness = (
  status: EmbeddingModelTransitionState["status"],
): EmbeddingModelTransitionState["readiness"] => {
  switch (status) {
    case "building":
      return "building";
    case "blocked":
      return "blocked";
    case "quarantined":
    case "failed":
      return "unavailable";
    case "promoted":
      return "ready";
    case "idle":
    case "cancelled":
      return null;
  }
};

const safeTransitionError = (error: unknown): unknown => {
  if (error instanceof AppError) {
    return error;
  }
  if (!(error instanceof EmbeddingTransitionCoordinatorError)) {
    return serviceUnavailable(
      "Embedding model transition is temporarily unavailable",
    );
  }
  switch (error.code) {
    case "transition_conflict":
      return conflict("Another embedding model change is already pending");
    case "validation_failed":
    case "target_quarantined":
      return badRequest(
        "The replacement embedding model failed compatibility validation",
      );
    case "validation_blocked":
    case "backfill_handoff_failed":
    case "backfill_cancellation_failed":
    case "target_not_found":
      return serviceUnavailable(
        "Embedding model transition is temporarily unavailable",
      );
  }
};
