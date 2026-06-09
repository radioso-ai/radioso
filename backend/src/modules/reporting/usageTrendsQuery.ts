import type { QueryResultRow } from "pg";

import { badRequest } from "../../shared/domain/errors.js";
import type { UsageTrendAggregateRow, UsageTrendBucket, UsageTrendGranularity } from "./contracts/index.js";

export const MAX_USAGE_TREND_BUCKETS = 366;

export interface NormalizedUsageTrendRange {
  from: string;
  to: string;
  granularity: UsageTrendGranularity;
  queryStart: Date;
  queryEnd: Date;
  firstBucketStart: Date;
  lastBucketStart: Date;
  bucketCount: number;
}

interface QueryBuildInput {
  accountId: string;
  range: NormalizedUsageTrendRange;
  workspaceId?: string;
  agentId?: string;
}

interface SqlQuery {
  text: string;
  params: unknown[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const parseUtcDateOnly = (value: string): Date | null => {
  if (!DATE_ONLY.test(value)) {
    return null;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

const formatDateOnly = (date: Date): string => date.toISOString().slice(0, 10);

const addBucket = (date: Date, granularity: UsageTrendGranularity): Date => {
  const next = new Date(date.getTime());
  if (granularity === "day") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (granularity === "week") {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
};

const truncateToBucketStart = (date: Date, granularity: UsageTrendGranularity): Date => {
  const truncated = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (granularity === "week") {
    const day = truncated.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    truncated.setUTCDate(truncated.getUTCDate() - daysSinceMonday);
  } else if (granularity === "month") {
    truncated.setUTCDate(1);
  }
  return truncated;
};

export const normalizeUsageTrendRange = (input: {
  from: string;
  to: string;
  granularity: UsageTrendGranularity;
  maxBuckets?: number;
}): NormalizedUsageTrendRange => {
  const fromDate = parseUtcDateOnly(input.from);
  const toDate = parseUtcDateOnly(input.to);
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) {
    throw badRequest("Invalid usage trends date range");
  }

  const queryEnd = new Date(toDate.getTime() + DAY_MS);
  const firstBucketStart = truncateToBucketStart(fromDate, input.granularity);
  const lastBucketStart = truncateToBucketStart(toDate, input.granularity);
  const buckets = buildBucketStarts(firstBucketStart, lastBucketStart, input.granularity);
  const maxBuckets = input.maxBuckets ?? MAX_USAGE_TREND_BUCKETS;
  if (buckets.length > maxBuckets) {
    throw badRequest(`Usage trends range exceeds the maximum of ${maxBuckets} buckets`);
  }

  return {
    from: formatDateOnly(fromDate),
    to: formatDateOnly(toDate),
    granularity: input.granularity,
    queryStart: fromDate,
    queryEnd,
    firstBucketStart,
    lastBucketStart,
    bucketCount: buckets.length,
  };
};

const buildBucketStarts = (first: Date, last: Date, granularity: UsageTrendGranularity): Date[] => {
  const starts: Date[] = [];
  for (let cursor = new Date(first.getTime()); cursor.getTime() <= last.getTime(); cursor = addBucket(cursor, granularity)) {
    starts.push(cursor);
  }
  return starts;
};

export const buildUsageTrendBuckets = (range: NormalizedUsageTrendRange): UsageTrendBucket[] =>
  buildBucketStarts(range.firstBucketStart, range.lastBucketStart, range.granularity).map((start) => ({
    periodStart: start.toISOString(),
    periodEnd: addBucket(start, range.granularity).toISOString(),
    conversationsCreated: 0,
    messages: { total: 0, user: 0, assistant: 0 },
    tokens: { input: 0, output: 0, total: 0 },
  }));

const toNumber = (value: number | string | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const serializeBucketStart = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const mergeUsageTrendRows = (
  buckets: UsageTrendBucket[],
  rows: UsageTrendAggregateRow[],
): UsageTrendBucket[] => {
  const byStart = new Map(buckets.map((bucket) => [bucket.periodStart, { ...bucket, messages: { ...bucket.messages }, tokens: { ...bucket.tokens } }]));

  for (const row of rows) {
    const bucket = byStart.get(serializeBucketStart(row.bucket_start));
    if (!bucket) {
      continue;
    }
    bucket.conversationsCreated += toNumber(row.conversations_created);
    bucket.messages.user += toNumber(row.user_messages);
    bucket.messages.assistant += toNumber(row.assistant_messages);
    bucket.messages.total = bucket.messages.user + bucket.messages.assistant;
    bucket.tokens.input += toNumber(row.input_tokens);
    bucket.tokens.output += toNumber(row.output_tokens);
    bucket.tokens.total += toNumber(row.total_tokens);
  }

  return buckets.map((bucket) => byStart.get(bucket.periodStart)!);
};

const pushOptionalFilters = (
  input: QueryBuildInput,
  params: unknown[],
  filters: string[],
  aliases: { workspace: string; agentConversation?: string },
): void => {
  if (input.workspaceId) {
    params.push(input.workspaceId);
    filters.push(`${aliases.workspace}.workspace_id = $${params.length}`);
  }
  if (input.agentId && aliases.agentConversation) {
    params.push(input.agentId);
    filters.push(`${aliases.agentConversation}.agent_id = $${params.length}`);
  }
};

const baseParams = (input: QueryBuildInput): unknown[] => [
  input.accountId,
  input.range.queryStart.toISOString(),
  input.range.queryEnd.toISOString(),
  input.range.granularity,
];

const bucketExpression = (alias: string, column: string): string =>
  `date_trunc($4::text, ${alias}.${column} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

export const buildWorkspaceOwnershipQuery = (accountId: string, workspaceId: string): SqlQuery => ({
  text: `SELECT EXISTS (
           SELECT 1
           FROM workspaces w
           WHERE w.account_id = $1 AND w.id = $2
         ) AS exists`,
  params: [accountId, workspaceId],
});

export const buildAgentOwnershipQuery = (accountId: string, agentId: string): SqlQuery => ({
  text: `SELECT EXISTS (
           SELECT 1
           FROM agents a
           JOIN workspaces w ON w.id = a.workspace_id
           WHERE w.account_id = $1 AND a.id = $2
         ) AS exists`,
  params: [accountId, agentId],
});

export const buildConversationTrendsQuery = (input: QueryBuildInput): SqlQuery => {
  const params = baseParams(input);
  const filters = [
    "w.account_id = $1",
    "c.created_at >= $2::timestamptz",
    "c.created_at < $3::timestamptz",
  ];
  pushOptionalFilters(input, params, filters, { workspace: "c", agentConversation: "c" });

  return {
    text: `SELECT
             ${bucketExpression("c", "created_at")} AS bucket_start,
             COUNT(*)::text AS conversations_created,
             0::text AS user_messages,
             0::text AS assistant_messages,
             0::text AS input_tokens,
             0::text AS output_tokens,
             0::text AS total_tokens
           FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
           WHERE ${filters.join(" AND ")}
           GROUP BY bucket_start
           ORDER BY bucket_start ASC`,
    params,
  };
};

export const buildMessageTrendsQuery = (input: QueryBuildInput): SqlQuery => {
  const params = baseParams(input);
  const filters = [
    "w.account_id = $1",
    "m.created_at >= $2::timestamptz",
    "m.created_at < $3::timestamptz",
  ];
  pushOptionalFilters(input, params, filters, { workspace: "m", agentConversation: "c" });

  return {
    text: `SELECT
             ${bucketExpression("m", "created_at")} AS bucket_start,
             0::text AS conversations_created,
             COUNT(*) FILTER (WHERE m.role = 'user')::text AS user_messages,
             COUNT(*) FILTER (WHERE m.role = 'assistant')::text AS assistant_messages,
             0::text AS input_tokens,
             0::text AS output_tokens,
             0::text AS total_tokens
           FROM messages m
           JOIN workspaces w ON w.id = m.workspace_id
           JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
           WHERE ${filters.join(" AND ")}
             AND m.role IN ('user', 'assistant')
           GROUP BY bucket_start
           ORDER BY bucket_start ASC`,
    params,
  };
};

export const buildTokenTrendsQuery = (input: QueryBuildInput): SqlQuery => {
  const params = baseParams(input);
  const filters = [
    "ue.account_id = $1",
    "ue.occurred_at >= $2::timestamptz",
    "ue.occurred_at < $3::timestamptz",
    "ue.status = 'succeeded'",
  ];
  let conversationJoin = "";
  if (input.workspaceId) {
    params.push(input.workspaceId);
    filters.push(`ue.workspace_id = $${params.length}`);
  }
  if (input.agentId) {
    // Agent attribution for token events is only possible through conversation
    // lineage. Events without a conversation are intentionally excluded here.
    conversationJoin = "JOIN conversations c ON c.id = ue.conversation_id";
    params.push(input.agentId);
    filters.push(`c.agent_id = $${params.length}`);
  }

  return {
    text: `SELECT
             ${bucketExpression("ue", "occurred_at")} AS bucket_start,
             0::text AS conversations_created,
             0::text AS user_messages,
             0::text AS assistant_messages,
             COALESCE(SUM(ue.input_tokens), 0)::text AS input_tokens,
             COALESCE(SUM(ue.output_tokens), 0)::text AS output_tokens,
             COALESCE(SUM(ue.total_tokens), 0)::text AS total_tokens
           FROM usage_events ue
           ${conversationJoin}
           WHERE ${filters.join(" AND ")}
           GROUP BY bucket_start
           ORDER BY bucket_start ASC`,
    params,
  };
};

export type UsageTrendDatabaseRow = QueryResultRow & UsageTrendAggregateRow;
