import type {
  EmbeddingBinding,
  EmbeddingBindingResolverPort,
} from "../../modules/embeddingProfiles/services/profileBoundEmbeddingPorts.js";
import type {
  EmbeddingProfileRepositoryPort,
  EmbeddingSpaceRecord,
} from "../../modules/embeddingProfiles/contracts/repositories.js";
import type { EmbeddingPurpose } from "../../modules/embeddingProfiles/contracts/embeddingProvider.js";
import type { IngestionSettingsRecord } from "../../modules/settings/contracts/ingestion.js";
import {
  resolveEmbeddingModelDescriptor,
} from "../../shared/infra/llm/supportedEmbeddingModels.js";
import {
  ModelEmbeddingSpaceMaterializer,
  requireEmbeddingProvider,
} from "./modelEmbeddingSpaceMaterializer.js";

interface WorkspaceEmbeddingSettingsPort {
  getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord>;
}

interface EmbeddingModelMetadata {
  readonly provider: string;
  readonly endpointScopeFingerprint?: string;
}

const EXISTING_WORKSPACE_EMBEDDING_DIMENSIONS = 1536;

export interface WorkspaceEmbeddingBindingResolverOptions {
  readonly settings: WorkspaceEmbeddingSettingsPort;
  readonly profiles?: Pick<
    EmbeddingProfileRepositoryPort,
    | "createEmbeddingSpace"
    | "findWorkspaceProfile"
    | "findEmbeddingSpaceById"
    | "initializeWorkspaceProfile"
  >;
  readonly identifyModel: (model: string) => EmbeddingModelMetadata;
}

export class WorkspaceEmbeddingBindingResolver
implements EmbeddingBindingResolverPort {
  constructor(
    private readonly options: WorkspaceEmbeddingBindingResolverOptions,
  ) {}

  async resolveBinding(input: {
    workspaceId: string;
    purpose: EmbeddingPurpose;
  }): Promise<EmbeddingBinding> {
    const profileBinding = await this.resolveStoredProfile(input);
    if (profileBinding) {
      return profileBinding;
    }

    const settings = await this.options.settings.getForWorkspace(input.workspaceId);
    if (this.options.profiles) {
      return this.materializeLegacyProfile(
        input.workspaceId,
        settings.embeddingModel,
      );
    }
    const model = settings.embeddingModel;
    const metadata = this.options.identifyModel(model);
    const provider = requireEmbeddingProvider(metadata.provider);
    const descriptor = resolveEmbeddingModelDescriptor(model, {
      provider,
      dimensions: EXISTING_WORKSPACE_EMBEDDING_DIMENSIONS,
    });

    // Existing workspaces have model-keyed vectors until legacy profile
    // materialization assigns a persisted space. Keeping that translation here
    // prevents the compatibility convention from leaking into consumers.
    return {
      space: {
        id: model,
        dimensions: descriptor.dimensions,
        distanceMetric: "cosine",
      },
      model,
      provider,
      endpointScopeFingerprint: metadata.endpointScopeFingerprint,
    };
  }

  async resolveBindingForSpace(input: {
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<EmbeddingBinding> {
    const profiles = this.options.profiles;
    if (!profiles) {
      throw new Error("Pinned embedding spaces require profile persistence");
    }
    const profile = await profiles.findWorkspaceProfile(input.workspaceId);
    if (
      !profile
      || (
        profile.activeEmbeddingSpaceId !== input.embeddingSpaceId
        && profile.pendingEmbeddingSpaceId !== input.embeddingSpaceId
      )
    ) {
      throw new Error(
        `Embedding space ${input.embeddingSpaceId} is not active or pending for workspace`,
      );
    }
    const space = await profiles.findEmbeddingSpaceById(input.embeddingSpaceId);
    if (!space) {
      throw new Error(`Embedding profile references missing space ${input.embeddingSpaceId}`);
    }
    return toBinding(space);
  }

  private async materializeLegacyProfile(
    workspaceId: string,
    model: string,
  ): Promise<EmbeddingBinding> {
    const profiles = this.options.profiles!;
    const space = await new ModelEmbeddingSpaceMaterializer(
      profiles,
      this.options.identifyModel,
    ).ensureExistingSelection(
      model,
      EXISTING_WORKSPACE_EMBEDDING_DIMENSIONS,
    );
    const profile = await profiles.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: space.id,
    });
    if (profile.activeEmbeddingSpaceId === space.id) {
      return toBinding(space);
    }
    const activeSpace = await profiles.findEmbeddingSpaceById(
      profile.activeEmbeddingSpaceId,
    );
    if (!activeSpace) {
      throw new Error(
        `Embedding profile references missing space ${profile.activeEmbeddingSpaceId}`,
      );
    }
    return toBinding(activeSpace);
  }

  private async resolveStoredProfile(input: {
    workspaceId: string;
    purpose: EmbeddingPurpose;
  }): Promise<EmbeddingBinding | null> {
    if (!this.options.profiles) {
      return null;
    }
    const profile = await this.options.profiles.findWorkspaceProfile(
      input.workspaceId,
    );
    if (!profile) {
      return null;
    }
    const spaceId = profile.activeEmbeddingSpaceId;
    const space = await this.options.profiles.findEmbeddingSpaceById(spaceId);
    if (!space) {
      throw new Error(`Embedding profile references missing space ${spaceId}`);
    }
    return toBinding(space);
  }
}

const toBinding = (
  space: EmbeddingSpaceRecord,
): EmbeddingBinding => ({
  space: {
    id: space.id,
    dimensions: space.dimensions,
    distanceMetric: space.distanceMetric,
  },
  model: space.model,
  provider: requireEmbeddingProvider(space.provider),
  endpointScopeFingerprint: space.endpointScopeFingerprint,
});
