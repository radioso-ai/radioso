export type UsageEventStatus = "succeeded" | "failed";
export type UsageEventQuality = "actual" | "estimated";

export interface EmbeddingUsageEvent {
  idempotencyKey: string;
  accountId?: string | null;
  workspaceId: string;
  sourceId?: string | null;
  documentId: string;
  documentRevision: number;
  jobId?: string | null;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputBytes: number;
  vectorCount: number;
  status: UsageEventStatus;
  usageQuality: UsageEventQuality;
  providerRequestId?: string | null;
  errorCode?: string | null;
  occurredAt?: Date;
  chunks?: Array<{
    chunkIndex: number;
    chunkId?: string | null;
    contentBytes: number;
    estimatedTokens?: number | null;
  }>;
}

export interface ModelUsageEvent {
  idempotencyKey: string;
  accountId?: string | null;
  workspaceId: string;
  conversationId?: string | null;
  messageId?: string | null;
  surface: string;
  operation: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  status: UsageEventStatus;
  usageQuality: UsageEventQuality;
  providerRequestId?: string | null;
  errorCode?: string | null;
  occurredAt?: Date;
}

export interface UsageEventRecorder {
  recordEmbedding(event: EmbeddingUsageEvent): Promise<void>;
  recordModelCall(event: ModelUsageEvent): Promise<void>;
}

export class NoopUsageEventRecorder implements UsageEventRecorder {
  async recordEmbedding(_event: EmbeddingUsageEvent): Promise<void> {}
  async recordModelCall(_event: ModelUsageEvent): Promise<void> {}
}
