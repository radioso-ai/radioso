import { CompiledQuery } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import { badRequest } from "../../shared/domain/errors.js";
import type {
  InternalUsageEvent,
  InternalUsageResponse,
  MessageUsageResponse,
  MessageUsageSummary,
  UsageDetailsInput,
  UsageDetailsReportingRepositoryPort,
  UsageDetailsServicePort,
  UsageTrendAggregateRow,
  UsageTrendsInput,
  UsageTrendsResponse,
  UsageTrendsServicePort,
} from "./contracts/index.js";
import {
  decodeInternalUsageCursor,
  decodeMessageUsageCursor,
  encodeInternalUsageCursor,
  encodeMessageUsageCursor,
} from "./usageDetailsCursor.js";
import { labelUsageOperation } from "./usageDetailsLabels.js";
import {
  MAX_USAGE_DETAILS_LIMIT,
  normalizeUsageDetailsRange,
} from "./usageDetailsQuery.js";
import {
  buildAgentOwnershipQuery,
  buildConversationTrendsQuery,
  buildMessageTrendsQuery,
  buildTokenTrendsQuery,
  buildUsageTrendBuckets,
  buildWorkspaceOwnershipQuery,
  mergeUsageTrendRows,
  normalizeUsageTrendRange,
} from "./usageTrendsQuery.js";

interface AccountAccessPort {
  requireActiveMembership(accountId: string, userId: string): Promise<unknown>;
}

type ExistsRow = {
  exists: boolean;
};

export class UsageTrendsService implements UsageTrendsServicePort {
  constructor(
    private readonly db: Db,
    private readonly accountAccessService: AccountAccessPort,
  ) {}

  async getUsageTrends(input: UsageTrendsInput): Promise<UsageTrendsResponse> {
    await this.accountAccessService.requireActiveMembership(input.accountId, input.userId);
    const range = normalizeUsageTrendRange(input);

    await this.validateFilters(input);

    const baseBuckets = buildUsageTrendBuckets(range);
    const queryInput = {
      accountId: input.accountId,
      range,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    };
    const rows = await Promise.all([
      this.runAggregateQuery(buildConversationTrendsQuery(queryInput)),
      this.runAggregateQuery(buildMessageTrendsQuery(queryInput)),
      this.runAggregateQuery(buildTokenTrendsQuery(queryInput)),
    ]);

    return {
      granularity: input.granularity,
      from: range.from,
      to: range.to,
      filters: {
        workspaceId: input.workspaceId ?? null,
        agentId: input.agentId ?? null,
      },
      buckets: mergeUsageTrendRows(baseBuckets, rows.flat()),
    };
  }

  private async validateFilters(input: UsageTrendsInput): Promise<void> {
    if (input.workspaceId) {
      const query = buildWorkspaceOwnershipQuery(input.accountId, input.workspaceId);
      const result = await this.db.executeQuery<ExistsRow>(
        CompiledQuery.raw(query.text, query.params),
      );
      if (!result.rows[0]?.exists) {
        throw badRequest("Workspace filter does not belong to the current account");
      }
    }

    if (input.agentId) {
      const query = buildAgentOwnershipQuery(input.accountId, input.agentId);
      const result = await this.db.executeQuery<ExistsRow>(
        CompiledQuery.raw(query.text, query.params),
      );
      if (!result.rows[0]?.exists) {
        throw badRequest("Agent filter does not belong to the current account");
      }
    }
  }

  private async runAggregateQuery(query: { text: string; params: unknown[] }): Promise<UsageTrendAggregateRow[]> {
    const result = await this.db.executeQuery<UsageTrendAggregateRow>(
      CompiledQuery.raw(query.text, query.params),
    );
    return result.rows;
  }
}

export class UsageDetailsService implements UsageDetailsServicePort {
  constructor(
    private readonly repository: UsageDetailsReportingRepositoryPort,
    private readonly accountAccessService: AccountAccessPort,
  ) {}

  async getMessageUsage(input: UsageDetailsInput): Promise<MessageUsageResponse> {
    await this.accountAccessService.requireActiveMembership(input.accountId, input.userId);
    const range = normalizeUsageDetailsRange(input);
    this.validateLimit(input.limit);
    await this.validateWorkspace(input);
    const page = await this.repository.listMessageUsage({
      accountId: input.accountId,
      range,
      workspaceId: input.workspaceId,
      limit: input.limit,
      cursor: decodeMessageUsageCursor(input.cursor),
    });
    return {
      from: range.from,
      to: range.to,
      filters: { workspaceId: input.workspaceId ?? null },
      items: page.items.map((item): MessageUsageSummary => ({
        ...item,
        lastOccurredAt: item.lastOccurredAt.toISOString(),
        operations: item.operations.map((operation) => labelUsageOperation(operation)),
      })),
      nextCursor: page.nextCursor ? encodeMessageUsageCursor(page.nextCursor) : null,
    };
  }

  async getInternalUsage(input: UsageDetailsInput): Promise<InternalUsageResponse> {
    await this.accountAccessService.requireActiveMembership(input.accountId, input.userId);
    const range = normalizeUsageDetailsRange(input);
    this.validateLimit(input.limit);
    await this.validateWorkspace(input);
    const page = await this.repository.listInternalUsage({
      accountId: input.accountId,
      range,
      workspaceId: input.workspaceId,
      limit: input.limit,
      cursor: decodeInternalUsageCursor(input.cursor),
    });
    return {
      from: range.from,
      to: range.to,
      filters: { workspaceId: input.workspaceId ?? null },
      items: page.items.map((item): InternalUsageEvent => ({
        eventId: item.eventId,
        workspaceId: item.workspaceId,
        agentId: item.agentId,
        occurredAt: item.occurredAt.toISOString(),
        kind: item.kind,
        operation: labelUsageOperation(item.operation, {
          conversationSourceChannel: item.conversationSourceChannel,
        }),
        provider: item.provider,
        model: item.model,
        status: item.status,
        usageQuality: item.usageQuality,
        tokens: {
          input: item.inputTokens,
          completion: item.completionTokens,
          reasoning: item.reasoningTokens,
          visibleOutput: item.kind === "model" && item.reasoningTokens !== null && item.completionTokens !== null
            ? Math.max(0, item.completionTokens - item.reasoningTokens)
            : null,
          total: item.totalTokens,
        },
        vectorCount: item.vectorCount,
      })),
      nextCursor: page.nextCursor ? encodeInternalUsageCursor(page.nextCursor) : null,
    };
  }

  private validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_USAGE_DETAILS_LIMIT) {
      throw badRequest(`Detailed usage page limit must be between 1 and ${MAX_USAGE_DETAILS_LIMIT}`);
    }
  }

  private async validateWorkspace(input: UsageDetailsInput): Promise<void> {
    if (!input.workspaceId) return;
    if (!await this.repository.workspaceBelongsToAccount(input.accountId, input.workspaceId)) {
      throw badRequest("Workspace filter does not belong to the current account");
    }
  }
}
