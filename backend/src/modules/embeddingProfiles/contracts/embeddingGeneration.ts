import type {
  ModelCallUsageContext,
} from "../../../shared/domain/modelCallUsageContext.js";
import type {
  EmbeddingProviderImplementation,
  EmbeddingPurpose,
} from "./embeddingProvider.js";
import type {
  EmbeddingUsageItem,
  EmbeddingUsageSummary,
} from "./embeddingConsumers.js";

export interface EmbeddingGenerationOptions {
  readonly model?: string;
  readonly dimensions?: number;
  readonly purpose?: EmbeddingPurpose;
  readonly provider?: EmbeddingProviderImplementation;
  readonly endpointScopeFingerprint?: string;
  readonly usageContext?: ModelCallUsageContext;
  readonly sourceId?: string | null;
  readonly documentId?: string | null;
  readonly documentRevision?: number | null;
  readonly jobId?: string | null;
  readonly usageItems?: readonly EmbeddingUsageItem[];
}

export interface EmbeddingGenerationBatchResult {
  readonly vectors: number[][];
  readonly usage?: EmbeddingUsageSummary;
}

export interface EmbeddingGenerationGateway {
  embedTexts(
    texts: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<number[][]>;
  embedTextsWithUsage?(
    texts: readonly string[],
    options?: EmbeddingGenerationOptions,
  ): Promise<EmbeddingGenerationBatchResult>;
}

export interface EmbeddingInferenceRequest {
  readonly texts: string[];
  readonly model?: string;
  readonly dimensions?: number;
  readonly purpose?: EmbeddingPurpose;
  readonly provider?: EmbeddingProviderImplementation;
  readonly endpointScopeFingerprint?: string;
  readonly operation: ModelCallUsageContext;
  readonly sourceId?: string | null;
  readonly documentId?: string | null;
  readonly documentRevision?: number | null;
  readonly jobId?: string | null;
  readonly items?: EmbeddingUsageItem[];
}

export interface EmbeddingInferencePort {
  embedTexts(
    input: EmbeddingInferenceRequest,
  ): Promise<EmbeddingGenerationBatchResult>;
}
