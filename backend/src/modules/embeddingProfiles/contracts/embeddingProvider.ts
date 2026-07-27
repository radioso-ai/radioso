export type EmbeddingPurpose =
  | "retrieval_document"
  | "retrieval_query"
  | "clustering";

export type EmbeddingProviderFamily = "openai_like" | "gemini";
export type EmbeddingNormalization = "provider_unit" | "application_unit";
export type EmbeddingProviderImplementation =
  | "openai"
  | "openai-compatible"
  | "gemini";

export interface SupportedEmbeddingModelDescriptor {
  readonly model: string;
  readonly providerFamily: EmbeddingProviderFamily;
  readonly dimensions: number;
  readonly normalization: EmbeddingNormalization;
  readonly taskMapping: Readonly<Record<EmbeddingPurpose, string | null>>;
  readonly limits: {
    readonly maxBatch: number;
    readonly maxInputBytes: number;
    readonly maxResponseBytes: number;
  };
}

export interface EmbeddingGenerationRequest {
  readonly texts: readonly string[];
  readonly model: string;
  readonly dimensions: number;
  readonly purpose: EmbeddingPurpose;
  readonly provider?: EmbeddingProviderImplementation;
}

export interface EmbeddingProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly providerRequestId?: string;
  readonly quality: "actual" | "estimated";
}

export interface EmbeddingProviderResult {
  readonly vectors: number[][];
  readonly usage?: EmbeddingProviderUsage;
}

export interface EmbeddingProviderPort {
  generate(request: EmbeddingGenerationRequest): Promise<EmbeddingProviderResult>;
}

export interface ValidatedEmbeddingBatch {
  readonly vectors: number[][];
  readonly usage?: EmbeddingProviderUsage;
}
