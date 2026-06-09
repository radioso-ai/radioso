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
