export type UsageTrendGranularity = "day" | "week" | "month";

export interface UsageTrendsInput {
  accountId: string;
  userId: string;
  from: string;
  to: string;
  granularity: UsageTrendGranularity;
  workspaceId?: string;
  agentId?: string;
}

export interface UsageTrendBucket {
  periodStart: string;
  periodEnd: string;
  conversationsCreated: number;
  messages: {
    total: number;
    user: number;
    assistant: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
}

export interface UsageTrendsResponse {
  granularity: UsageTrendGranularity;
  from: string;
  to: string;
  filters: {
    workspaceId: string | null;
    agentId: string | null;
  };
  buckets: UsageTrendBucket[];
}

export interface UsageTrendAggregateRow {
  bucket_start: Date | string;
  conversations_created?: number | string | null;
  user_messages?: number | string | null;
  assistant_messages?: number | string | null;
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
  total_tokens?: number | string | null;
}

export interface UsageTrendsServicePort {
  getUsageTrends(input: UsageTrendsInput): Promise<UsageTrendsResponse>;
}

export type UsageEventKind = "model" | "embedding" | "unknown";
export type ReasoningCoverage = "complete" | "partial" | "unavailable";

export interface UsageDetailsInput {
  accountId: string;
  userId: string;
  from: string;
  to: string;
  workspaceId?: string;
  limit: number;
  cursor?: string;
}

export interface UsageDetailsRange {
  from: string;
  to: string;
  queryStart: Date;
  queryEnd: Date;
}

export interface MessageUsageCursor {
  /**
   * UTC timestamp formatted with six fractional digits. This is a lossless
   * keyset value, distinct from the millisecond-precision display timestamp.
   */
  lastOccurredAt: string;
  messageId: string;
}

export interface InternalUsageCursor {
  /** UTC timestamp formatted with six fractional digits for keyset paging. */
  occurredAt: string;
  eventId: string;
}

export interface UsageOperationAttribution {
  surface: string;
  name: string;
}

export interface UsageOperation extends UsageOperationAttribution {
  label: string;
}

export interface UsageAttempts {
  total: number;
  succeeded: number;
  failed: number;
}

export interface UsageQualityCounts {
  actual: number;
  estimated: number;
}

export interface MessageModelTokens {
  input: number;
  completion: number;
  reasoning: {
    tokens: number | null;
    coverage: ReasoningCoverage;
  };
  visibleOutput: number | null;
  total: number;
}

export interface MessageEmbeddingTokens {
  input: number;
  total: number;
  vectors: number;
  attempts: number;
}

export interface UnknownHistoricalTokens {
  total: number;
  attempts: number;
}

export interface MessageUsageSummaryRecord {
  messageId: string;
  conversationId: string;
  workspaceId: string;
  agentId: string | null;
  lastOccurredAt: Date;
  providers: string[];
  models: string[];
  operations: UsageOperationAttribution[];
  attempts: UsageAttempts;
  quality: UsageQualityCounts;
  modelTokens: MessageModelTokens;
  embeddingTokens: MessageEmbeddingTokens;
  unknownHistorical: UnknownHistoricalTokens;
}

export interface MessageUsageSummary extends Omit<MessageUsageSummaryRecord, "lastOccurredAt" | "operations"> {
  lastOccurredAt: string;
  operations: UsageOperation[];
}

export interface MessageUsageResponse {
  from: string;
  to: string;
  filters: { workspaceId: string | null };
  items: MessageUsageSummary[];
  nextCursor: string | null;
}

export interface InternalUsageEventRecord {
  eventId: string;
  workspaceId: string | null;
  agentId: string | null;
  conversationSourceChannel?: string | null;
  occurredAt: Date;
  kind: UsageEventKind;
  operation: UsageOperationAttribution;
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  usageQuality: "actual" | "estimated";
  inputTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number;
  vectorCount: number | null;
}

export interface InternalUsageEvent extends Omit<
  InternalUsageEventRecord,
  "occurredAt" | "operation" | "inputTokens" | "completionTokens" | "reasoningTokens" | "totalTokens"
> {
  occurredAt: string;
  operation: UsageOperation;
  tokens: {
    input: number | null;
    completion: number | null;
    reasoning: number | null;
    visibleOutput: number | null;
    total: number;
  };
}

export interface InternalUsageResponse {
  from: string;
  to: string;
  filters: { workspaceId: string | null };
  items: InternalUsageEvent[];
  nextCursor: string | null;
}

export interface UsageDetailsReadInput {
  accountId: string;
  range: UsageDetailsRange;
  workspaceId?: string;
  limit: number;
}

export interface UsageDetailsReportingRepositoryPort {
  workspaceBelongsToAccount(accountId: string, workspaceId: string): Promise<boolean>;
  listMessageUsage(input: UsageDetailsReadInput & { cursor?: MessageUsageCursor }): Promise<{
    items: MessageUsageSummaryRecord[];
    nextCursor: MessageUsageCursor | null;
  }>;
  listInternalUsage(input: UsageDetailsReadInput & { cursor?: InternalUsageCursor }): Promise<{
    items: InternalUsageEventRecord[];
    nextCursor: InternalUsageCursor | null;
  }>;
}

export interface UsageDetailsServicePort {
  getMessageUsage(input: UsageDetailsInput): Promise<MessageUsageResponse>;
  getInternalUsage(input: UsageDetailsInput): Promise<InternalUsageResponse>;
}
