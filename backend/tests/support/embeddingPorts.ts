import type {
  ClusteringEmbeddingPort,
  DocumentEmbeddingPort,
  DocumentEmbeddingRequest,
} from "../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";
import {
  EmbeddingGenerationService,
  type EmbeddingGenerationGateway,
} from "../../src/modules/embeddingProfiles/public.js";

const DEFAULT_TEST_MODEL = "text-embedding-3-small";

export const bindDocumentEmbeddingPort = (
  service: EmbeddingGenerationService,
  model = DEFAULT_TEST_MODEL,
): DocumentEmbeddingPort => ({
  async embedDocumentChunks(request: DocumentEmbeddingRequest) {
    const jobId = request.jobId ?? "unattributed";
    const result = await service.embedChunksWithUsage([...request.texts], {
      model,
      purpose: "retrieval_document",
      usageContext: request.usageContext ?? {
        workspaceId: request.workspaceId,
        requestId: jobId,
        surface: "documents",
        operation: "embedding",
        attemptKey: `document:${request.documentId}:${request.documentRevision}:${jobId}:chunks:test`,
      },
      sourceId: request.sourceId,
      documentId: request.documentId,
      documentRevision: request.documentRevision,
      jobId: request.jobId,
      usageItems: request.usageItems?.map((item) => ({ ...item })),
    });
    return {
      space: {
        id: `test-space:${model}`,
        dimensions: result.vectors[0]?.length ?? 0,
        distanceMetric: "cosine",
      },
      vectors: result.vectors,
      usage: result.usage,
    };
  },
});

export const createDocumentEmbeddingPort = (
  gateway: EmbeddingGenerationGateway,
  model = DEFAULT_TEST_MODEL,
): DocumentEmbeddingPort =>
  bindDocumentEmbeddingPort(new EmbeddingGenerationService(gateway), model);

export const bindClusteringEmbeddingPort = (
  service: EmbeddingGenerationService,
): ClusteringEmbeddingPort => ({
  async embedForClustering(request) {
    const vectors = await service.embedTexts([...request.texts], {
      purpose: "clustering",
      usageContext: request.usageContext,
    });
    return { vectors };
  },
});
