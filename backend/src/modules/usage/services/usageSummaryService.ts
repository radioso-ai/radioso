import type {
  AccountDailyUsageSummaryRepositoryPort,
  AccountMonthlyUsageSummaryRecord,
} from "../../../db/repositories/accountDailyUsageSummaryRepository.js";
import type { UsageEventRecord, UsageEventRepositoryPort } from "../../../db/repositories/usageEventRepository.js";

export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageBreakdownItem {
  operationType: string;
  model: string;
  status: string;
  usageAvailable: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  recordedAt: string;
}

export interface TurnUsageDetail {
  usageTotals?: TokenUsageTotals;
  usageBreakdown: UsageBreakdownItem[];
}

export interface AccountUsageSummary {
  today: TokenUsageTotals;
  currentMonth: TokenUsageTotals;
  daily: Array<{ date: string; totals: TokenUsageTotals }>;
  monthly: Array<{ month: string; totals: TokenUsageTotals }>;
}

const zeroTotals = (): TokenUsageTotals => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const totalsFromDailyRecord = (row?: AccountDailyUsageSummaryRecord | null): TokenUsageTotals => ({
  promptTokens: row?.promptTokens ?? 0,
  completionTokens: row?.completionTokens ?? 0,
  totalTokens: row?.totalTokens ?? 0,
});

const totalsFromMonthlyRecord = (row?: AccountMonthlyUsageSummaryRecord | null): TokenUsageTotals => ({
  promptTokens: row?.promptTokens ?? 0,
  completionTokens: row?.completionTokens ?? 0,
  totalTokens: row?.totalTokens ?? 0,
});

const addUsage = (totals: TokenUsageTotals, event: UsageEventRecord): TokenUsageTotals => ({
  promptTokens: totals.promptTokens + (event.promptTokens ?? 0),
  completionTokens: totals.completionTokens + (event.completionTokens ?? 0),
  totalTokens: totals.totalTokens + (event.totalTokens ?? 0),
});

const toUtcDate = (value: Date): string => value.toISOString().slice(0, 10);
const toUtcMonth = (value: Date): string => value.toISOString().slice(0, 7);

export class UsageSummaryService {
  constructor(
    private readonly usageEventRepository: UsageEventRepositoryPort,
    private readonly accountDailyUsageSummaryRepository: AccountDailyUsageSummaryRepositoryPort,
  ) {}

  async getAccountUsageSummary(input: {
    accountId: string;
    days?: number;
    months?: number;
  }): Promise<AccountUsageSummary> {
    const days = input.days ?? 30;
    const months = input.months ?? 12;
    const [dailyRows, monthlyRows, todayRow] = await Promise.all([
      this.accountDailyUsageSummaryRepository.listRecentByAccountId(input.accountId, days),
      this.accountDailyUsageSummaryRepository.listRecentMonthsByAccountId(input.accountId, months),
      this.accountDailyUsageSummaryRepository.findByAccountIdAndDate(input.accountId, toUtcDate(new Date())),
    ]);

    const currentMonthKey = toUtcMonth(new Date());
    const currentMonthRow = monthlyRows.find((row) => row.month === currentMonthKey) ?? null;

    return {
      today: totalsFromDailyRecord(todayRow),
      currentMonth: totalsFromMonthlyRecord(currentMonthRow),
      daily: dailyRows.map((row) => ({
        date: row.usageDate,
        totals: totalsFromDailyRecord(row),
      })),
      monthly: monthlyRows.map((row) => ({
        month: row.month,
        totals: totalsFromMonthlyRecord(row),
      })),
    };
  }

  async listTurnUsageByAssistantMessageIds(assistantMessageIds: string[]): Promise<Map<string, TurnUsageDetail>> {
    const events = await this.usageEventRepository.listByAssistantMessageIds(assistantMessageIds);
    const grouped = new Map<string, TurnUsageDetail>();

    for (const event of events) {
      if (!event.assistantMessageId) {
        continue;
      }

      const current = grouped.get(event.assistantMessageId) ?? { usageBreakdown: [] };
      current.usageBreakdown.push({
        operationType: event.operationType,
        model: event.model,
        status: event.eventStatus,
        usageAvailable: event.usageAvailable,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        recordedAt: event.occurredAt.toISOString(),
      });

      if (event.usageAvailable) {
        current.usageTotals = addUsage(current.usageTotals ?? zeroTotals(), event);
      }

      grouped.set(event.assistantMessageId, current);
    }

    return grouped;
  }

  async rebuildAccountDailySummaries(accountId: string): Promise<void> {
    const grouped = await this.usageEventRepository.aggregateDailyByAccountId(accountId);

    await this.accountDailyUsageSummaryRepository.replaceAllForAccount({
      accountId,
      rows: grouped,
    });
  }
}
