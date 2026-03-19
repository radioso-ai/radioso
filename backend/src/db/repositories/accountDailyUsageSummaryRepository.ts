import type { Database } from "../../shared/infra/database.js";

export interface AccountDailyUsageSummaryRecord {
  accountId: string;
  usageDate: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageEventCount: number;
  unavailableEventCount: number;
  updatedAt: Date;
}

export interface AccountMonthlyUsageSummaryRecord {
  month: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageEventCount: number;
  unavailableEventCount: number;
}

export interface AccountDailyUsageSummaryRepositoryPort {
  findByAccountIdAndDate(accountId: string, usageDate: string): Promise<AccountDailyUsageSummaryRecord | null>;
  listRecentByAccountId(accountId: string, days: number): Promise<AccountDailyUsageSummaryRecord[]>;
  listRecentMonthsByAccountId(accountId: string, months: number): Promise<AccountMonthlyUsageSummaryRecord[]>;
  replaceAllForAccount(input: {
    accountId: string;
    rows: Array<{
      usageDate: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      usageEventCount: number;
      unavailableEventCount: number;
    }>;
  }): Promise<void>;
}

interface AccountDailyUsageSummaryRow {
  account_id: string;
  usage_date: string;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  total_tokens: number | string;
  usage_event_count: number | string;
  unavailable_event_count: number | string;
  updated_at: Date;
}

interface AccountMonthlyUsageSummaryRow {
  month: string;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  total_tokens: number | string;
  usage_event_count: number | string;
  unavailable_event_count: number | string;
}

const toNumber = (value: number | string | null | undefined): number => Number(value ?? 0);

const mapDaily = (row: AccountDailyUsageSummaryRow): AccountDailyUsageSummaryRecord => ({
  accountId: row.account_id,
  usageDate: row.usage_date,
  promptTokens: toNumber(row.prompt_tokens),
  completionTokens: toNumber(row.completion_tokens),
  totalTokens: toNumber(row.total_tokens),
  usageEventCount: toNumber(row.usage_event_count),
  unavailableEventCount: toNumber(row.unavailable_event_count),
  updatedAt: new Date(row.updated_at),
});

const mapMonthly = (row: AccountMonthlyUsageSummaryRow): AccountMonthlyUsageSummaryRecord => ({
  month: row.month,
  promptTokens: toNumber(row.prompt_tokens),
  completionTokens: toNumber(row.completion_tokens),
  totalTokens: toNumber(row.total_tokens),
  usageEventCount: toNumber(row.usage_event_count),
  unavailableEventCount: toNumber(row.unavailable_event_count),
});

export class AccountDailyUsageSummaryRepository implements AccountDailyUsageSummaryRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByAccountIdAndDate(accountId: string, usageDate: string): Promise<AccountDailyUsageSummaryRecord | null> {
    const [row] = await this.database.query<AccountDailyUsageSummaryRow>(
      `SELECT account_id, usage_date::text, prompt_tokens, completion_tokens, total_tokens,
              usage_event_count, unavailable_event_count, updated_at
       FROM account_daily_usage_summaries
       WHERE account_id = $1 AND usage_date = $2::date`,
      [accountId, usageDate],
    );

    return row ? mapDaily(row) : null;
  }

  async listRecentByAccountId(accountId: string, days: number): Promise<AccountDailyUsageSummaryRecord[]> {
    const rows = await this.database.query<AccountDailyUsageSummaryRow>(
      `SELECT account_id, usage_date::text, prompt_tokens, completion_tokens, total_tokens,
              usage_event_count, unavailable_event_count, updated_at
       FROM account_daily_usage_summaries
       WHERE account_id = $1
       ORDER BY usage_date DESC
       LIMIT $2`,
      [accountId, days],
    );

    return rows.map(mapDaily);
  }

  async listRecentMonthsByAccountId(accountId: string, months: number): Promise<AccountMonthlyUsageSummaryRecord[]> {
    const rows = await this.database.query<AccountMonthlyUsageSummaryRow>(
      `SELECT to_char(date_trunc('month', usage_date::timestamp), 'YYYY-MM') AS month,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens) AS total_tokens,
              SUM(usage_event_count) AS usage_event_count,
              SUM(unavailable_event_count) AS unavailable_event_count
       FROM account_daily_usage_summaries
       WHERE account_id = $1
       GROUP BY 1
       ORDER BY month DESC
       LIMIT $2`,
      [accountId, months],
    );

    return rows.map(mapMonthly);
  }

  async replaceAllForAccount(input: {
    accountId: string;
    rows: Array<{
      usageDate: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      usageEventCount: number;
      unavailableEventCount: number;
    }>;
  }): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ["account_usage_summary", input.accountId],
      );

      await client.query(`DELETE FROM account_daily_usage_summaries WHERE account_id = $1`, [input.accountId]);

      for (const row of input.rows) {
        await client.query(
          `INSERT INTO account_daily_usage_summaries (
             account_id, usage_date, prompt_tokens, completion_tokens, total_tokens,
             usage_event_count, unavailable_event_count, updated_at
           )
           VALUES ($1, $2::date, $3, $4, $5, $6, $7, NOW())`,
          [
            input.accountId,
            row.usageDate,
            row.promptTokens,
            row.completionTokens,
            row.totalTokens,
            row.usageEventCount,
            row.unavailableEventCount,
          ],
        );
      }
    });
  }
}
