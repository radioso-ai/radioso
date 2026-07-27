import type { ModelCallUsageContext } from "../../domain/modelCallUsageContext.js";
import { setTraceAttributes, traceOperation } from "../../observability/tracing/operations.js";
import {
  NoopUsageEventRecorder,
  type UsageEventRecorder,
  type UsageEventStatus,
} from "../../domain/usageEventRecorder.js";
import type {
  EmbeddingProviderImplementation,
} from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";
import type {
  EmbeddingClient,
  EmbeddingClientOptions,
  EmbeddingResult,
  LlmProviderMetadata,
  ProviderUsage,
} from "./providerTypes.js";

export interface EmbeddingUsageItem {
  chunkIndex: number;
  chunkId?: string | null;
  contentBytes: number;
  estimatedTokens?: number | null;
}

export interface EmbeddingInferenceRequest {
  texts: string[];
  model?: string;
  dimensions?: number;
  purpose?: EmbeddingClientOptions["purpose"];
  provider?: EmbeddingClientOptions["provider"];
  endpointScopeFingerprint?: string;
  operation: ModelCallUsageContext;
  sourceId?: string | null;
  documentId?: string | null;
  documentRevision?: number | null;
  jobId?: string | null;
  items?: EmbeddingUsageItem[];
}

export interface EmbeddingInferencePipeline {
  readonly metadata: LlmProviderMetadata;
  embedTexts(input: EmbeddingInferenceRequest): Promise<EmbeddingResult>;
}

const estimateTokens = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

const usageErrorCode = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 120);
  }
  return "embedding_failed";
};

const buildUsageIdempotencyKey = (
  context: ModelCallUsageContext,
  provider: string,
  model: string,
  status: UsageEventStatus,
): string => [
  "embedding",
  context.surface,
  context.operation,
  context.conversationId ?? `request:${context.requestId ?? "none"}`,
  context.messageId ?? "none",
  context.attemptKey,
  provider,
  model,
  status,
].join(":");

const providerTraceAttributes = (
  metadata: LlmProviderMetadata,
  input: EmbeddingInferenceRequest,
): Record<string, unknown> => ({
  "llm.provider": metadata.provider,
  "llm.model": input.model ?? metadata.model,
  "llm.operation": input.operation.operation,
  "llm.embedding.vector.count": input.texts.length,
  "radioso.account_id": input.operation.accountId,
  "radioso.conversation_id": input.operation.conversationId,
  "radioso.document_id": input.documentId,
  "radioso.job_id": input.jobId,
  "radioso.message_id": input.operation.messageId,
  "radioso.request_id": input.operation.requestId,
  "radioso.workspace_id": input.operation.workspaceId,
});

export class EmbeddingInferencePipelineService implements EmbeddingInferencePipeline {
  readonly metadata;

  constructor(
    private readonly delegate: EmbeddingClient,
    private readonly usageEventRecorder: UsageEventRecorder = new NoopUsageEventRecorder(),
    private readonly identifyModel?: (
      model: string,
      provider?: EmbeddingProviderImplementation,
    ) => LlmProviderMetadata,
  ) {
    this.metadata = delegate.metadata;
  }

  async embedTexts(input: EmbeddingInferenceRequest): Promise<EmbeddingResult> {
    const identity = this.identityFor(input);
    return traceOperation({
      name: "llm.provider.embedding",
      attributes: providerTraceAttributes(identity, input),
      run: () => this.embedTextsWithinTrace(input),
    });
  }

  private async embedTextsWithinTrace(input: EmbeddingInferenceRequest): Promise<EmbeddingResult> {
    try {
      const result = await this.delegate.embedTexts(input.texts, {
        model: input.model,
        dimensions: input.dimensions,
        purpose: input.purpose,
        provider: input.provider,
        endpointScopeFingerprint: input.endpointScopeFingerprint,
      });
      await this.recordUsage(input, "succeeded", result.usage);
      setTraceAttributes({ "llm.provider.outcome": "succeeded" });
      return result;
    } catch (error) {
      await this.recordUsage(input, "failed", undefined, error);
      setTraceAttributes({ "llm.provider.outcome": "failed" });
      throw error;
    }
  }

  private async recordUsage(
    input: EmbeddingInferenceRequest,
    status: UsageEventStatus,
    providerUsage?: ProviderUsage,
    error?: unknown,
  ): Promise<void> {
    const model = input.model ?? this.delegate.metadata.model;
    const identity = this.identifyModel?.(model, input.provider) ?? {
      ...this.delegate.metadata,
      model,
    };
    const inputBytes = input.texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    const estimatedInputTokens = input.items?.reduce(
      (sum, item) => sum + (item.estimatedTokens ?? estimateTokens(item.contentBytes)),
      0,
    ) ?? estimateTokens(inputBytes);
    const inputTokens = providerUsage?.inputTokens ?? providerUsage?.totalTokens ?? estimatedInputTokens;

    await this.usageEventRecorder.recordEmbedding({
      idempotencyKey: buildUsageIdempotencyKey(input.operation, identity.provider, identity.model, status),
      accountId: input.operation.accountId ?? null,
      workspaceId: input.operation.workspaceId,
      conversationId: input.operation.conversationId ?? null,
      messageId: input.operation.messageId ?? null,
      surface: input.operation.surface,
      operation: input.operation.operation,
      sourceId: input.sourceId ?? null,
      documentId: input.documentId ?? null,
      documentRevision: input.documentRevision ?? null,
      jobId: input.jobId ?? null,
      provider: identity.provider,
      model: identity.model,
      inputTokens,
      outputTokens: providerUsage?.outputTokens ?? null,
      inputBytes,
      vectorCount: input.texts.length,
      status,
      usageQuality: providerUsage?.quality ?? "estimated",
      providerRequestId: providerUsage?.providerRequestId ?? null,
      errorCode: error ? usageErrorCode(error) : null,
      chunks: input.items,
    }).catch(() => {
      // Usage accounting is observational; embedding results remain authoritative.
    });
  }

  private identityFor(input: EmbeddingInferenceRequest): LlmProviderMetadata {
    const model = input.model ?? this.delegate.metadata.model;
    return this.identifyModel?.(model, input.provider) ?? {
      ...this.delegate.metadata,
      ...(input.provider ? { provider: input.provider } : {}),
      model,
    };
  }
}
