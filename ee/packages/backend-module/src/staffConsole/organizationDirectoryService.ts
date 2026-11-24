import { sql } from "kysely";

import { createEeKysely, type EeDb } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { currentPeriodStart } from "../usageLimits/period.js";
import { TENTHS_PER_CONVERSATION } from "../usageLimits/usageLimitService.js";
import { meteredInAnswers } from "../usageLimits/usageMeter.js";

export interface OrganizationDirectoryRow {
  accountId: string;
  name: string;
  ownerEmail: string | null;
  ownerCount: number;
  profileKey: string | null;
  profileDisplayName: string | null;
  monthlyAnswers: {
    used: number;
    limit: number | null;
  };
  /** Present unless the tier caps answers, in which case it is null and `monthlyAnswers`
   *  is the headline meter. `limit` is null for an account without a conversation limit,
   *  untiered included. Values are conversations to one decimal: the counter is kept in
   *  tenths so the catalog's fractional per-surface weights stay integer math. */
  monthlyConversations: {
    used: number;
    limit: number | null;
  } | null;
}

export interface OrganizationDirectoryPage {
  rows: OrganizationDirectoryRow[];
  pageInfo: {
    limit: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
    total: number;
  };
}

interface OrganizationDirectoryListInput {
  limit: number;
  offset?: number;
  cursor?: string;
  search?: string;
}

interface OrganizationDirectoryServiceConfig {
  now?: () => Date;
}

interface OrganizationDirectoryQueryRow {
  account_id: string;
  name: string;
  owner_email: string | null;
  owner_count: number | string | bigint | null;
  profile_key: string | null;
  profile_display_name: string | null;
  monthly_answer_used: number | string | bigint | null;
  monthly_answer_limit: number | string | bigint | null;
  monthly_conversation_used_tenths: number | string | bigint | null;
  monthly_usage_tenths: number | string | bigint | null;
  monthly_conversation_limit: number | string | bigint | null;
  total_count: number | string | bigint | null;
}

const defaultLimit = 25;
const maxLimit = 100;

const toNumber = (value: number | string | bigint | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
};

const toNullableNumber = (value: number | string | bigint | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const headlineMeters = (
  row: OrganizationDirectoryQueryRow,
): Pick<OrganizationDirectoryRow, "monthlyAnswers" | "monthlyConversations"> => {
  const caps = row.profile_key === null
    ? null
    : {
      monthlyAnswerLimit: toNullableNumber(row.monthly_answer_limit),
      monthlyConversationLimit: toNullableNumber(row.monthly_conversation_limit),
    };
  if (meteredInAnswers(caps)) {
    return {
      monthlyAnswers: { used: toNumber(row.monthly_answer_used), limit: caps.monthlyAnswerLimit },
      monthlyConversations: null,
    };
  }
  const conversationLimit = caps?.monthlyConversationLimit ?? null;
  // A capped account reads the allowance it has spent. An uncapped one spends no allowance,
  // so it reads the month's recorded usage across every kind instead.
  const usedTenths = conversationLimit === null ? row.monthly_usage_tenths : row.monthly_conversation_used_tenths;
  return {
    // The meter is conversations, so any answer cap on the tier is not enforced and
    // must not be reported; getAccountUsage masks it too.
    monthlyAnswers: { used: toNumber(row.monthly_answer_used), limit: null },
    monthlyConversations: { used: toNumber(usedTenths) / TENTHS_PER_CONVERSATION, limit: conversationLimit },
  };
};

const normalizeLimit = (limit: number): number =>
  Math.min(maxLimit, Math.max(1, Math.floor(limit)));

export class OrganizationDirectoryService {
  private readonly db: EeDb;
  private readonly now: () => Date;

  constructor(
    private readonly database: UsageLimitDatabasePort,
    config: OrganizationDirectoryServiceConfig = {},
  ) {
    this.db = createEeKysely(this.database.pool);
    this.now = config.now ?? (() => new Date());
  }

  async listOrganizations(input: OrganizationDirectoryListInput): Promise<OrganizationDirectoryPage> {
    const limit = normalizeLimit(input.limit || defaultLimit);
    const offset = this.resolveOffset(input);
    const search = input.search?.trim() || null;
    const periodStart = currentPeriodStart(this.now());

    const result = await sql<OrganizationDirectoryQueryRow>`
      WITH active_owners AS (
        SELECT
          am.account_id,
          u.email,
          row_number() OVER (PARTITION BY am.account_id ORDER BY am.created_at ASC, u.id ASC) AS owner_rank,
          count(*) OVER (PARTITION BY am.account_id) AS owner_count
        FROM account_memberships am
        INNER JOIN users u ON u.id = am.user_id
        WHERE am.role = 'owner'
          AND am.status = 'active'
      )
      SELECT
        a.id AS account_id,
        a.name,
        primary_owner.email AS owner_email,
        coalesce(primary_owner.owner_count, 0) AS owner_count,
        p.key AS profile_key,
        p.display_name AS profile_display_name,
        coalesce(c.used_count, 0) AS monthly_answer_used,
        p.monthly_answer_limit AS monthly_answer_limit,
        coalesce(units.used_tenths, 0) AS monthly_conversation_used_tenths,
        coalesce(kinds.used_tenths, 0) AS monthly_usage_tenths,
        p.monthly_conversation_limit AS monthly_conversation_limit,
        count(*) OVER () AS total_count
      FROM accounts a
      LEFT JOIN active_owners primary_owner
        ON primary_owner.account_id = a.id
       AND primary_owner.owner_rank = 1
      LEFT JOIN ee_usage_limit_account_assignments assignment
        ON assignment.account_id = a.id
      LEFT JOIN ee_usage_limit_profiles p
        ON p.key = assignment.profile_key
      LEFT JOIN ee_usage_limit_answer_counters c
        ON c.account_id = a.id
       AND c.period_start = ${periodStart}::date
      LEFT JOIN ee_usage_limit_unit_counters units
        ON units.account_id = a.id
       AND units.period_start = ${periodStart}::date
      LEFT JOIN (
        SELECT account_id, sum(used_tenths) AS used_tenths
        FROM ee_usage_limit_unit_kind_counters
        WHERE period_start = ${periodStart}::date
        GROUP BY account_id
      ) kinds
        ON kinds.account_id = a.id
      WHERE ${search}::text IS NULL
         OR a.name ILIKE '%' || ${search}::text || '%'
         OR EXISTS (
           SELECT 1
           FROM active_owners owner_search
           WHERE owner_search.account_id = a.id
             AND owner_search.email ILIKE '%' || ${search}::text || '%'
         )
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `.execute(this.db);

    const fetchedRows = result.rows;
    const rows = fetchedRows.slice(0, limit).map((row): OrganizationDirectoryRow => ({
      accountId: row.account_id,
      name: row.name,
      ownerEmail: row.owner_email,
      ownerCount: toNumber(row.owner_count),
      profileKey: row.profile_key,
      profileDisplayName: row.profile_display_name,
      ...headlineMeters(row),
    }));
    const hasMore = fetchedRows.length > limit;
    const total = fetchedRows.length > 0 ? toNumber(fetchedRows[0].total_count) : 0;

    return {
      rows,
      pageInfo: {
        limit,
        offset,
        nextOffset: hasMore ? offset + limit : null,
        hasMore,
        total,
      },
    };
  }

  async getOrganizationName(accountId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("accounts")
      .select("name")
      .where("id", "=", accountId)
      .executeTakeFirst();
    return row?.name ?? null;
  }

  private resolveOffset(input: OrganizationDirectoryListInput): number {
    if (typeof input.offset === "number" && Number.isFinite(input.offset)) {
      return Math.max(0, Math.floor(input.offset));
    }
    if (input.cursor) {
      const parsed = Number(input.cursor);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    }
    return 0;
  }
}
