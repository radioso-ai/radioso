/**
 * Canonical usage-event recorder contract shared by OSS and Enterprise.
 *
 * This package owns the single source of truth for the recorder port and its
 * event shapes so OSS (`backend`) and EE (`@radioso/enterprise-backend-module`)
 * cannot drift. EE never imports OSS source directly; both import this
 * types-only contract instead — mirroring `@radioso/skill-contract`.
 *
 * Pricing, cost, and summary read-models are deliberately NOT modelled here;
 * this contract describes only the work performed (the immutable ledger input).
 */

export type UsageEventStatus = "succeeded" | "failed";
export type UsageEventQuality = "actual" | "estimated";
export type UsageEventKind = "model" | "embedding" | "unknown";

export interface EmbeddingUsageEvent {
  idempotencyKey: string;
  accountId?: string | null;
  workspaceId: string;
  agentId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  surface?: string;
  operation?: string;
  sourceId?: string | null;
  documentId?: string | null;
  documentRevision?: number | null;
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
  agentId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  surface: string;
  operation: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
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
