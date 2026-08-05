import type {
  ClusteringEmbeddingPort,
  ClusteringEmbeddingRequest,
  ClusteringEmbeddingResult,
  DocumentEmbeddingPort,
  DocumentEmbeddingRequest,
  EmbeddingConsumerResult,
  EmbeddingSpaceRef,
  PinnedDocumentEmbeddingPort,
  PinnedDocumentEmbeddingRequest,
  QueryEmbeddingPort,
  QueryEmbeddingRequest,
} from "../contracts/embeddingConsumers.js";
import type {
  EmbeddingGenerationGateway,
  EmbeddingGenerationOptions,
} from "../contracts/embeddingGeneration.js";
import type {
  EmbeddingProviderImplementation,
  EmbeddingPurpose,
} from "../contracts/embeddingProvider.js";
import { EmbeddingGenerationService } from "./embeddingGenerationService.js";

export interface EmbeddingBinding {
  readonly space: EmbeddingSpaceRef;
  readonly model: string;
  readonly provider?: EmbeddingProviderImplementation;
  readonly endpointScopeFingerprint?: string;
}

export interface EmbeddingBindingResolverPort {
  resolveBinding(input: {
    readonly workspaceId: string;
    readonly purpose: EmbeddingPurpose;
  }): Promise<EmbeddingBinding>;
  resolveBindingForSpace(input: {
    readonly workspaceId: string;
    readonly embeddingSpaceId: string;
  }): Promise<EmbeddingBinding>;
}

/**
 * The only service that translates purpose-specific consumer requests into
 * provider generation options. Consumers receive an opaque space reference and
 * never choose a provider, model, dimension, or provider task.
 */
export class ProfileBoundEmbeddingPorts
implements
QueryEmbeddingPort,
DocumentEmbeddingPort,
PinnedDocumentEmbeddingPort,
ClusteringEmbeddingPort {
  private readonly generation: EmbeddingGenerationService;

  constructor(
    gateway: EmbeddingGenerationGateway,
    private readonly bindings: EmbeddingBindingResolverPort,
  ) {
    this.generation = new EmbeddingGenerationService(gateway);
  }

  async embedQueries(
    request: QueryEmbeddingRequest,
  ): Promise<EmbeddingConsumerResult> {
    const binding = await this.bindings.resolveBinding({
      workspaceId: request.workspaceId,
      purpose: "retrieval_query",
    });
    const result = await this.generate(binding, request.texts, {
      purpose: "retrieval_query",
      usageContext: request.usageContext,
    });
    return {
      space: binding.space,
      vectors: result.vectors,
      usage: result.usage,
    };
  }

  async embedDocumentChunks(
    request: DocumentEmbeddingRequest,
  ): Promise<EmbeddingConsumerResult> {
    const binding = await this.bindings.resolveBinding({
      workspaceId: request.workspaceId,
      purpose: "retrieval_document",
    });
    const result = await this.generate(binding, request.texts, {
      purpose: "retrieval_document",
      usageContext: request.usageContext ?? {
        workspaceId: request.workspaceId,
        requestId: request.jobId ?? undefined,
        surface: "documents",
        operation: "embedding",
        attemptKey: `document:${request.documentId}:${request.documentRevision}:${request.jobId ?? "unattributed"}`,
      },
      sourceId: request.sourceId,
      documentId: request.documentId,
      documentRevision: request.documentRevision,
      jobId: request.jobId,
      usageItems: request.usageItems,
    });
    return {
      space: binding.space,
      vectors: result.vectors,
      usage: result.usage,
    };
  }

  async embedDocumentChunksForSpace(
    request: PinnedDocumentEmbeddingRequest,
  ): Promise<EmbeddingConsumerResult> {
    const binding = await this.bindings.resolveBindingForSpace({
      workspaceId: request.workspaceId,
      embeddingSpaceId: request.embeddingSpaceId,
    });
    const result = await this.generate(binding, request.texts, {
      purpose: "retrieval_document",
      usageContext: request.usageContext,
      sourceId: request.sourceId,
      documentId: request.documentId,
      documentRevision: request.documentRevision,
      jobId: request.jobId,
      usageItems: request.usageItems,
    });
    return {
      space: binding.space,
      vectors: result.vectors,
      usage: result.usage,
    };
  }

  async embedForClustering(
    request: ClusteringEmbeddingRequest,
  ): Promise<ClusteringEmbeddingResult> {
    const binding = await this.bindings.resolveBinding({
      workspaceId: request.workspaceId,
      purpose: "clustering",
    });
    const result = await this.generate(binding, request.texts, {
      purpose: "clustering",
      usageContext: request.usageContext,
    });
    return { ...result, space: binding.space };
  }

  private generate(
    binding: EmbeddingBinding,
    texts: readonly string[],
    options: Omit<
      EmbeddingGenerationOptions,
      "model" | "dimensions" | "provider" | "endpointScopeFingerprint"
    > & {
      purpose: EmbeddingPurpose;
    },
  ) {
    return this.generation.embedChunksWithUsage(texts, {
      ...options,
      model: binding.model,
      dimensions: binding.space.dimensions,
      provider: binding.provider,
      endpointScopeFingerprint: binding.endpointScopeFingerprint,
    });
  }
}
