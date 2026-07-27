import type {
  EmbeddingProfileRepositoryPort,
  EmbeddingSpaceRecord,
} from "../../modules/embeddingProfiles/public.js";
import { createEmbeddingSpaceIdentity } from "../../modules/embeddingProfiles/public.js";
import type {
  EmbeddingProviderImplementation,
} from "../../modules/embeddingProfiles/contracts/embeddingProvider.js";
import {
  getSupportedEmbeddingModel,
  resolveEmbeddingModelDescriptor,
} from "../../shared/infra/llm/supportedEmbeddingModels.js";

export interface EmbeddingModelBindingMetadata {
  readonly provider: string;
  readonly endpointScopeFingerprint?: string;
}

export const EXISTING_WORKSPACE_EMBEDDING_DIMENSIONS = 1536;

export class ModelEmbeddingSpaceMaterializer {
  constructor(
    private readonly profiles: Pick<
      EmbeddingProfileRepositoryPort,
      "createEmbeddingSpace"
    >,
    private readonly identifyModel: (
      model: string,
    ) => EmbeddingModelBindingMetadata,
  ) {}

  async ensure(model: string): Promise<EmbeddingSpaceRecord> {
    const descriptor = getSupportedEmbeddingModel(model);
    const metadata = this.identifyModel(model);
    return this.ensureDescriptor(model, descriptor, metadata);
  }

  async ensureExistingSelection(
    model: string,
    dimensions: number,
  ): Promise<EmbeddingSpaceRecord> {
    const metadata = this.identifyModel(model);
    const provider = requireEmbeddingProvider(metadata.provider);
    const descriptor = resolveEmbeddingModelDescriptor(model, {
      provider,
      dimensions,
    });
    return this.ensureDescriptor(model, descriptor, metadata);
  }

  private async ensureDescriptor(
    model: string,
    descriptor: ReturnType<typeof getSupportedEmbeddingModel>,
    metadata: EmbeddingModelBindingMetadata,
  ): Promise<EmbeddingSpaceRecord> {
    const provider = requireEmbeddingProvider(metadata.provider);
    if (!metadata.endpointScopeFingerprint) {
      throw new Error(
        `Embedding endpoint scope is unavailable for model ${model}`,
      );
    }
    const identity = createEmbeddingSpaceIdentity({
      providerImplementation: provider,
      endpointScopeFingerprint: metadata.endpointScopeFingerprint,
      model,
      dimensions: descriptor.dimensions,
      distance: "cosine",
      normalization: descriptor.normalization,
      documentTask: descriptor.taskMapping.retrieval_document,
      queryTask: descriptor.taskMapping.retrieval_query,
      vectorOptions: {},
      providerModelVersion: null,
    });
    return this.profiles.createEmbeddingSpace({
      identityFingerprint: identity.fingerprint,
      provider: identity.providerImplementation,
      endpointScopeFingerprint: identity.endpointScopeFingerprint,
      model: identity.model,
      dimensions: identity.dimensions,
      distanceMetric: identity.distance,
      normalization: identity.normalization,
      documentTask: identity.documentTask,
      queryTask: identity.queryTask,
      vectorOptions: {},
      modelVersion: identity.providerModelVersion,
    });
  }
}

export const requireEmbeddingProvider = (
  provider: string,
): EmbeddingProviderImplementation => {
  if (
    provider === "openai"
    || provider === "openai-compatible"
    || provider === "gemini"
  ) {
    return provider;
  }
  throw new Error(`Unsupported embedding provider ${provider}`);
};
