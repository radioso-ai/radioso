import { sql } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import { OPERATOR_TEST_SOURCE_CHANNELS } from "../../shared/domain/conversationSource.js";
import type {
  InternalUsageCursor,
  InternalUsageEventRecord,
  MessageUsageCursor,
  MessageUsageSummaryRecord,
  UsageDetailsReadInput,
  UsageDetailsReportingRepositoryPort,
  UsageEventKind,
  UsageOperationAttribution,
} from "../../modules/reporting/contracts/index.js";

type DateValue = Date | string;

type MessageCandidateRow = {
  message_id: string | null;
  conversation_id: string | null;
  last_occurred_at: DateValue | null;
  last_occurred_at_cursor: string | null;
};

type MessageEventRow = {
  message_id: string | null;
  workspace_id: string | null;
  conversation_agent_id: string | null;
  occurred_at: DateValue;
  provider: string;
  model: string;
  surface: string;
  operation: string;
  input_tokens: string | number;
  output_tokens: string | number;
  reasoning_tokens: string | number | null;
  total_tokens: string | number;
  vector_count: number;
  event_kind: string;
  status: string;
  usage_quality: string;
};

type InternalEventRow = {
  event_id: string;
  workspace_id: string | null;
  event_agent_id: string | null;
  conversation_agent_id: string | null;
  conversation_source_channel: string | null;
  occurred_at: DateValue;
  occurred_at_cursor: string;
  provider: string;
  model: string;
  surface: string;
  operation: string;
  input_tokens: string | number;
  output_tokens: string | number;
  reasoning_tokens: string | number | null;
  total_tokens: string | number;
  vector_count: number;
  event_kind: string;
  status: string;
  usage_quality: string;
};

type MessageAccumulator = {
  messageId: string;
  conversationId: string;
  workspaceId: string;
  agentId: string | null;
  lastOccurredAt: Date;
  providers: Set<string>;
  models: Set<string>;
  operations: Map<string, UsageOperationAttribution>;
  attempts: { total: number; succeeded: number; failed: number };
  quality: { actual: number; estimated: number };
  model: {
    attempts: number;
    knownReasoningAttempts: number;
    input: number;
    completion: number;
    reasoning: number;
    total: number;
  };
  embedding: { attempts: number; input: number; total: number; vectors: number };
  unknown: { attempts: number; total: number };
};

const toNumber = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toDate = (value: DateValue): Date => value instanceof Date ? value : new Date(value);

const maxOccurredAtExpression = sql<Date>`max(${sql.ref("ue.occurred_at")})`;
const maxOccurredAtCursorExpression = sql<string>`to_char(
  max(${sql.ref("ue.occurred_at")}) AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;
const occurredAtCursorExpression = sql<string>`to_char(
  ${sql.ref("ue.occurred_at")} AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;

const asUsageKind = (value: string): UsageEventKind =>
  value === "model" || value === "embedding" ? value : "unknown";

const asStatus = (value: string): "succeeded" | "failed" => value === "succeeded" ? "succeeded" : "failed";

const asQuality = (value: string): "actual" | "estimated" => value === "actual" ? "actual" : "estimated";

const operationKey = (operation: UsageOperationAttribution): string => `${operation.surface}:${operation.name}`;

const compareOperation = (left: UsageOperationAttribution, right: UsageOperationAttribution): number =>
  operationKey(left).localeCompare(operationKey(right));

/**
 * Postgres read adapter for detailed ledger reporting. It intentionally selects
 * a narrow allowlist instead of usage-event rows wholesale: the ledger also
 * stores request/error identifiers which are not dashboard-safe.
 */
export class UsageDetailsReportingRepository implements UsageDetailsReportingRepositoryPort {
  constructor(private readonly db: Db) {}

  async workspaceBelongsToAccount(accountId: string, workspaceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("workspaces")
      .select("id")
      .where("account_id", "=", accountId)
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return Boolean(row);
  }

  async listMessageUsage(
    input: UsageDetailsReadInput & { cursor?: MessageUsageCursor },
  ): Promise<{ items: MessageUsageSummaryRecord[]; nextCursor: MessageUsageCursor | null }> {
    let candidatesQuery = this.db
      .selectFrom("usage_events as ue")
      .innerJoin("messages as m", (join) => join
        .onRef("m.id", "=", "ue.message_id")
        .onRef("m.workspace_id", "=", "ue.workspace_id"))
      .innerJoin("conversations as c", (join) => join
        .onRef("c.id", "=", "m.conversation_id")
        .onRef("c.workspace_id", "=", "m.workspace_id"))
      .select((eb) => [
        "ue.message_id as message_id",
        "m.conversation_id as conversation_id",
        eb.fn.max("ue.occurred_at").as("last_occurred_at"),
        maxOccurredAtCursorExpression.as("last_occurred_at_cursor"),
      ])
      .where("ue.account_id", "=", input.accountId)
      .where("ue.occurred_at", ">=", input.range.queryStart)
      .where("ue.occurred_at", "<", input.range.queryEnd)
      .where("m.role", "=", "user")
      .where("ue.surface", "!=", "eval")
      .where((eb) => eb.or([
        eb("c.source_channel", "is", null),
        eb("c.source_channel", "not in", OPERATOR_TEST_SOURCE_CHANNELS),
      ]));

    if (input.workspaceId) {
      candidatesQuery = candidatesQuery.where("ue.workspace_id", "=", input.workspaceId);
    }
    if (input.cursor) {
      const cursor = input.cursor;
      const cursorOccurredAt = sql<Date>`${cursor.lastOccurredAt}::timestamptz`;
      candidatesQuery = candidatesQuery.having((eb) => eb.or([
        eb(maxOccurredAtExpression, "<", cursorOccurredAt),
        eb.and([
          eb(maxOccurredAtExpression, "=", cursorOccurredAt),
          eb("ue.message_id", "<", sql<string>`${cursor.messageId}::uuid`),
        ]),
      ]));
    }

    const candidateRows = await candidatesQuery
      .groupBy("ue.message_id")
      .groupBy("m.conversation_id")
      .orderBy(maxOccurredAtExpression, "desc")
      .orderBy("ue.message_id", "desc")
      .limit(input.limit + 1)
      .execute() as MessageCandidateRow[];
    const validCandidates = candidateRows.filter((row): row is {
      message_id: string;
      conversation_id: string;
      last_occurred_at: DateValue;
      last_occurred_at_cursor: string;
    } =>
      row.message_id !== null && row.conversation_id !== null && row.last_occurred_at !== null && row.last_occurred_at_cursor !== null,
    );
    const pageCandidates = validCandidates.slice(0, input.limit);
    if (pageCandidates.length === 0) {
      return { items: [], nextCursor: null };
    }
    const messageIds = pageCandidates.map((row) => row.message_id);

    let eventsQuery = this.db
      .selectFrom("usage_events as ue")
      .innerJoin("messages as m", (join) => join
        .onRef("m.id", "=", "ue.message_id")
        .onRef("m.workspace_id", "=", "ue.workspace_id"))
      .innerJoin("conversations as c", (join) => join
        .onRef("c.id", "=", "m.conversation_id")
        .onRef("c.workspace_id", "=", "m.workspace_id"))
      .select([
        "ue.message_id as message_id",
        "ue.workspace_id as workspace_id",
        "c.agent_id as conversation_agent_id",
        "ue.occurred_at as occurred_at",
        "ue.provider as provider",
        "ue.model as model",
        "ue.surface as surface",
        "ue.operation as operation",
        "ue.input_tokens as input_tokens",
        "ue.output_tokens as output_tokens",
        "ue.reasoning_tokens as reasoning_tokens",
        "ue.total_tokens as total_tokens",
        "ue.vector_count as vector_count",
        "ue.event_kind as event_kind",
        "ue.status as status",
        "ue.usage_quality as usage_quality",
      ])
      .where("ue.account_id", "=", input.accountId)
      .where("ue.occurred_at", ">=", input.range.queryStart)
      .where("ue.occurred_at", "<", input.range.queryEnd)
      .where("ue.message_id", "in", messageIds)
      .where("m.role", "=", "user")
      .where("ue.surface", "!=", "eval")
      .where((eb) => eb.or([
        eb("c.source_channel", "is", null),
        eb("c.source_channel", "not in", OPERATOR_TEST_SOURCE_CHANNELS),
      ]));
    if (input.workspaceId) {
      eventsQuery = eventsQuery.where("ue.workspace_id", "=", input.workspaceId);
    }
    const eventRows = await eventsQuery.execute() as MessageEventRow[];

    const accumulatorByMessageId = new Map<string, MessageAccumulator>();
    for (const candidate of pageCandidates) {
      accumulatorByMessageId.set(candidate.message_id, {
        messageId: candidate.message_id,
        conversationId: candidate.conversation_id,
        workspaceId: "",
        agentId: null,
        lastOccurredAt: toDate(candidate.last_occurred_at),
        providers: new Set(),
        models: new Set(),
        operations: new Map(),
        attempts: { total: 0, succeeded: 0, failed: 0 },
        quality: { actual: 0, estimated: 0 },
        model: { attempts: 0, knownReasoningAttempts: 0, input: 0, completion: 0, reasoning: 0, total: 0 },
        embedding: { attempts: 0, input: 0, total: 0, vectors: 0 },
        unknown: { attempts: 0, total: 0 },
      });
    }

    for (const row of eventRows) {
      if (!row.message_id) continue;
      const accumulator = accumulatorByMessageId.get(row.message_id);
      if (!accumulator) continue;
      accumulator.workspaceId = row.workspace_id ?? accumulator.workspaceId;
      accumulator.agentId ??= row.conversation_agent_id;
      accumulator.providers.add(row.provider);
      accumulator.models.add(row.model);
      const operation = { surface: row.surface, name: row.operation };
      accumulator.operations.set(operationKey(operation), operation);
      accumulator.attempts.total += 1;
      accumulator.attempts[asStatus(row.status)] += 1;
      accumulator.quality[asQuality(row.usage_quality)] += 1;

      const kind = asUsageKind(row.event_kind);
      if (kind === "model") {
        accumulator.model.attempts += 1;
        accumulator.model.input += toNumber(row.input_tokens);
        accumulator.model.completion += toNumber(row.output_tokens);
        accumulator.model.total += toNumber(row.total_tokens);
        if (row.reasoning_tokens !== null) {
          accumulator.model.knownReasoningAttempts += 1;
          accumulator.model.reasoning += toNumber(row.reasoning_tokens);
        }
      } else if (kind === "embedding") {
        accumulator.embedding.attempts += 1;
        accumulator.embedding.input += toNumber(row.input_tokens);
        accumulator.embedding.total += toNumber(row.total_tokens);
        accumulator.embedding.vectors += toNumber(row.vector_count);
      } else {
        accumulator.unknown.attempts += 1;
        accumulator.unknown.total += toNumber(row.total_tokens);
      }
    }

    const items = pageCandidates.map((candidate) => this.toMessageSummary(accumulatorByMessageId.get(candidate.message_id)!));
    const lastCandidate = pageCandidates.at(-1)!;
    return {
      items,
      nextCursor: validCandidates.length > input.limit
        ? { lastOccurredAt: lastCandidate.last_occurred_at_cursor, messageId: lastCandidate.message_id }
        : null,
    };
  }

  async listInternalUsage(
    input: UsageDetailsReadInput & { cursor?: InternalUsageCursor },
  ): Promise<{ items: InternalUsageEventRecord[]; nextCursor: InternalUsageCursor | null }> {
    let query = this.db
      .selectFrom("usage_events as ue")
      .leftJoin("messages as m", (join) => join
        .onRef("m.id", "=", "ue.message_id")
        .onRef("m.workspace_id", "=", "ue.workspace_id"))
      .leftJoin("conversations as c", (join) => join
        .onRef("c.id", "=", "m.conversation_id")
        .onRef("c.workspace_id", "=", "m.workspace_id"))
      .select([
        "ue.id as event_id",
        "ue.workspace_id as workspace_id",
        "ue.agent_id as event_agent_id",
        "c.agent_id as conversation_agent_id",
        "c.source_channel as conversation_source_channel",
        "ue.occurred_at as occurred_at",
        occurredAtCursorExpression.as("occurred_at_cursor"),
        "ue.provider as provider",
        "ue.model as model",
        "ue.surface as surface",
        "ue.operation as operation",
        "ue.input_tokens as input_tokens",
        "ue.output_tokens as output_tokens",
        "ue.reasoning_tokens as reasoning_tokens",
        "ue.total_tokens as total_tokens",
        "ue.vector_count as vector_count",
        "ue.event_kind as event_kind",
        "ue.status as status",
        "ue.usage_quality as usage_quality",
      ])
      .where("ue.account_id", "=", input.accountId)
      .where("ue.occurred_at", ">=", input.range.queryStart)
      .where("ue.occurred_at", "<", input.range.queryEnd)
      .where((eb) => eb.or([
        eb("m.id", "is", null),
        eb("m.role", "!=", "user"),
        eb("c.id", "is", null),
        eb("c.source_channel", "in", OPERATOR_TEST_SOURCE_CHANNELS),
        eb("ue.surface", "=", "eval"),
      ]));
    if (input.workspaceId) {
      query = query.where("ue.workspace_id", "=", input.workspaceId);
    }
    if (input.cursor) {
      const cursor = input.cursor;
      const cursorOccurredAt = sql<Date>`${cursor.occurredAt}::timestamptz`;
      query = query.where((eb) => eb.or([
        eb("ue.occurred_at", "<", cursorOccurredAt),
        eb.and([
          eb("ue.occurred_at", "=", cursorOccurredAt),
          eb("ue.id", "<", sql<string>`${cursor.eventId}::uuid`),
        ]),
      ]));
    }

    const rows = await query
      .orderBy("ue.occurred_at", "desc")
      .orderBy("ue.id", "desc")
      .limit(input.limit + 1)
      .execute() as InternalEventRow[];
    const pageRows = rows.slice(0, input.limit);
    const lastRow = pageRows.at(-1);
    return {
      items: pageRows.map((row) => this.toInternalUsageEvent(row)),
      nextCursor: rows.length > input.limit && lastRow
        ? { occurredAt: lastRow.occurred_at_cursor, eventId: lastRow.event_id }
        : null,
    };
  }

  private toMessageSummary(accumulator: MessageAccumulator): MessageUsageSummaryRecord {
    const reasoningCoverage = accumulator.model.attempts === 0 || accumulator.model.knownReasoningAttempts === 0
      ? "unavailable"
      : accumulator.model.knownReasoningAttempts === accumulator.model.attempts
        ? "complete"
        : "partial";
    const visibleOutput = reasoningCoverage === "complete"
      ? Math.max(0, accumulator.model.completion - accumulator.model.reasoning)
      : null;
    return {
      messageId: accumulator.messageId,
      conversationId: accumulator.conversationId,
      workspaceId: accumulator.workspaceId,
      agentId: accumulator.agentId,
      lastOccurredAt: accumulator.lastOccurredAt,
      providers: [...accumulator.providers].sort(),
      models: [...accumulator.models].sort(),
      operations: [...accumulator.operations.values()].sort(compareOperation),
      attempts: accumulator.attempts,
      quality: accumulator.quality,
      modelTokens: {
        input: accumulator.model.input,
        completion: accumulator.model.completion,
        reasoning: {
          tokens: reasoningCoverage === "unavailable" ? null : accumulator.model.reasoning,
          coverage: reasoningCoverage,
        },
        visibleOutput,
        total: accumulator.model.total,
      },
      embeddingTokens: {
        input: accumulator.embedding.input,
        total: accumulator.embedding.total,
        vectors: accumulator.embedding.vectors,
        attempts: accumulator.embedding.attempts,
      },
      unknownHistorical: accumulator.unknown,
    };
  }

  private toInternalUsageEvent(row: InternalEventRow): InternalUsageEventRecord {
    const kind = asUsageKind(row.event_kind);
    const inputTokens = kind === "unknown" ? null : toNumber(row.input_tokens);
    const completionTokens = kind === "model" ? toNumber(row.output_tokens) : null;
    const reasoningTokens = kind === "model" && row.reasoning_tokens !== null
      ? toNumber(row.reasoning_tokens)
      : null;
    return {
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      agentId: row.event_agent_id ?? row.conversation_agent_id,
      conversationSourceChannel: row.conversation_source_channel,
      occurredAt: toDate(row.occurred_at),
      kind,
      operation: { surface: row.surface, name: row.operation },
      provider: row.provider,
      model: row.model,
      status: asStatus(row.status),
      usageQuality: asQuality(row.usage_quality),
      inputTokens,
      completionTokens,
      reasoningTokens,
      totalTokens: toNumber(row.total_tokens),
      vectorCount: kind === "embedding" ? toNumber(row.vector_count) : null,
    };
  }
}
