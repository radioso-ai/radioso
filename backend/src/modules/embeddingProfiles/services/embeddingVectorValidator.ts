import type {
  EmbeddingNormalization,
  EmbeddingProviderPort,
  EmbeddingPurpose,
  SupportedEmbeddingModelDescriptor,
  ValidatedEmbeddingBatch,
} from "../contracts/embeddingProvider.js";

const UNIT_NORM_TOLERANCE = 1e-3;
export const EMBEDDING_PROBE_TEXT =
  "Radioso embedding compatibility probe.";

export interface EmbeddingValidationOptions {
  readonly expectedCount: number;
  readonly expectedDimensions: number;
  readonly normalization: EmbeddingNormalization;
}

export class EmbeddingVectorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingVectorContractError";
  }
}

export const validateEmbeddingBatch = (
  vectors: number[][],
  options: EmbeddingValidationOptions,
): number[][] => {
  if (vectors.length !== options.expectedCount) {
    throw new EmbeddingVectorContractError(
      `embedding vector count ${vectors.length} does not match expected vector count ${options.expectedCount}`,
    );
  }

  return vectors.map((vector, index) => {
    if (vector.length !== options.expectedDimensions) {
      throw new EmbeddingVectorContractError(
        `embedding vector ${index} dimensions ${vector.length} do not match expected dimensions ${options.expectedDimensions}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingVectorContractError(`embedding vector ${index} must contain only finite values`);
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) {
      throw new EmbeddingVectorContractError(`embedding vector ${index} must be non-zero for cosine search`);
    }
    if (options.normalization === "provider_unit") {
      if (Math.abs(norm - 1) > UNIT_NORM_TOLERANCE) {
        throw new EmbeddingVectorContractError(`embedding vector ${index} must be unit-normalized`);
      }
      return vector;
    }
    return vector.map((value) => value / norm);
  });
};

export const splitEmbeddingInputs = (
  texts: readonly string[],
  limits: { readonly maxBatch: number; readonly maxInputBytes: number },
): string[][] => {
  if (!Number.isInteger(limits.maxBatch) || limits.maxBatch < 1) {
    throw new Error("maxBatch must be a positive integer");
  }
  if (!Number.isInteger(limits.maxInputBytes) || limits.maxInputBytes < 1) {
    throw new Error("maxInputBytes must be a positive integer");
  }

  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const text of texts) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limits.maxInputBytes) {
      throw new Error("embedding input exceeds provider byte limit");
    }
    if (
      current.length > 0 &&
      (current.length >= limits.maxBatch ||
        currentBytes + bytes > limits.maxInputBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(text);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
};

export class EmbeddingModelProbeService {
  constructor(private readonly provider: EmbeddingProviderPort) {}

  async probe(
    descriptor: SupportedEmbeddingModelDescriptor,
    purpose: EmbeddingPurpose = "retrieval_document",
  ): Promise<ValidatedEmbeddingBatch> {
    const result = await this.provider.generate({
      texts: [EMBEDDING_PROBE_TEXT],
      model: descriptor.model,
      dimensions: descriptor.dimensions,
      purpose,
    });
    const vectors = validateEmbeddingBatch(result.vectors, {
      expectedCount: 1,
      expectedDimensions: descriptor.dimensions,
      normalization: descriptor.normalization,
    });
    const responseBytes = Buffer.byteLength(JSON.stringify(vectors), "utf8");
    if (responseBytes > Math.min(descriptor.limits.maxResponseBytes, 131_072)) {
      throw new EmbeddingVectorContractError("embedding probe response exceeds size limit");
    }
    return { vectors, usage: result.usage };
  }
}
