import type {
  EmbeddingProviderPort,
  EmbeddingProviderUsage,
  SupportedEmbeddingModelDescriptor,
  ValidatedEmbeddingBatch,
} from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";
import {
  splitEmbeddingInputs,
  validateEmbeddingBatch,
} from "../../../modules/embeddingProfiles/services/embeddingVectorValidator.js";
import type { EmbeddingClient } from "./providerTypes.js";

const sumUsage = (
  accumulated: EmbeddingProviderUsage | undefined,
  next: EmbeddingProviderUsage | undefined,
): EmbeddingProviderUsage | undefined => {
  if (!accumulated) {
    return next;
  }
  if (!next) {
    return accumulated;
  }
  const add = (left?: number, right?: number): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  return {
    inputTokens: add(accumulated.inputTokens, next.inputTokens),
    outputTokens: add(accumulated.outputTokens, next.outputTokens),
    totalTokens: add(accumulated.totalTokens, next.totalTokens),
    cachedInputTokens: add(
      accumulated.cachedInputTokens,
      next.cachedInputTokens,
    ),
    reasoningTokens: add(
      accumulated.reasoningTokens,
      next.reasoningTokens,
    ),
    providerRequestId:
      next.providerRequestId ?? accumulated.providerRequestId,
    quality:
      accumulated.quality === "actual" && next.quality === "actual"
        ? "actual"
        : "estimated",
  };
};

export class EmbeddingClientProviderAdapter implements EmbeddingProviderPort {
  constructor(
    private readonly client: EmbeddingClient,
    private readonly descriptorFor: (
      model: string,
    ) => SupportedEmbeddingModelDescriptor,
  ) {}

  async generate(
    request: Parameters<EmbeddingProviderPort["generate"]>[0],
  ): Promise<ValidatedEmbeddingBatch> {
    const descriptor = this.descriptorFor(request.model);
    if (request.dimensions !== descriptor.dimensions) {
      throw new Error(
        `requested dimensions ${request.dimensions} do not match descriptor dimensions ${descriptor.dimensions}`,
      );
    }
    const batches = splitEmbeddingInputs(request.texts, descriptor.limits);
    const vectors: number[][] = [];
    let usage: EmbeddingProviderUsage | undefined;
    for (const batch of batches) {
      const result = await this.client.embedTexts(batch, {
        model: request.model,
        dimensions: request.dimensions,
        purpose: request.purpose,
        provider: request.provider,
      });
      if (
        Buffer.byteLength(JSON.stringify(result.vectors), "utf8") >
        descriptor.limits.maxResponseBytes
      ) {
        throw new Error("embedding provider response exceeds size limit");
      }
      vectors.push(
        ...validateEmbeddingBatch(result.vectors, {
          expectedCount: batch.length,
          expectedDimensions: descriptor.dimensions,
          normalization: descriptor.normalization,
        }),
      );
      usage = sumUsage(usage, result.usage);
    }
    return { vectors, usage };
  }
}
