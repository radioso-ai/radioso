import type { QueryResultRow } from "pg";

import type { ApplicationDatabasePort } from "../../app/composition/applicationModule.js";
import { badRequest } from "../../shared/domain/errors.js";
import type {
  UsageTrendAggregateRow,
  UsageTrendsInput,
  UsageTrendsResponse,
  UsageTrendsServicePort,
} from "./contracts/index.js";
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

type ExistsRow = QueryResultRow & {
  exists: boolean;
};

export class UsageTrendsService implements UsageTrendsServicePort {
  constructor(
    private readonly database: ApplicationDatabasePort,
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
      const [row] = await this.database.query<ExistsRow>(query.text, query.params);
      if (!row?.exists) {
        throw badRequest("Workspace filter does not belong to the current account");
      }
    }

    if (input.agentId) {
      const query = buildAgentOwnershipQuery(input.accountId, input.agentId);
      const [row] = await this.database.query<ExistsRow>(query.text, query.params);
      if (!row?.exists) {
        throw badRequest("Agent filter does not belong to the current account");
      }
    }
  }

  private async runAggregateQuery(query: { text: string; params: unknown[] }): Promise<UsageTrendAggregateRow[]> {
    return this.database.query<UsageTrendAggregateRow & QueryResultRow>(query.text, query.params);
  }
}
