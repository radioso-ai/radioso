import { describe, expect, it } from "vitest";

import { UsageSummaryService } from "../../src/modules/usage/services/usageSummaryService.js";
import {
  InMemoryAccountDailyUsageSummaryRepository,
  InMemoryUsageEventRepository,
} from "../support/fakes.js";

describe("usage summary service", () => {
  it("aggregates turn usage by assistant message id", async () => {
    const summaryRepository = new InMemoryAccountDailyUsageSummaryRepository();
    const usageEventRepository = new InMemoryUsageEventRepository(summaryRepository);
    const service = new UsageSummaryService(usageEventRepository, summaryRepository);

    await usageEventRepository.record({
      operationKey: "turn-1-rewrite",
      accountId: "account-1",
      workspaceId: "workspace-1",
      assistantMessageId: "assistant-1",
      sourceArea: "retrieval",
      operationType: "query_rewrite",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      occurredAt: new Date("2026-03-19T12:00:00.000Z"),
    });
    await usageEventRepository.record({
      operationKey: "turn-1-answer",
      accountId: "account-1",
      workspaceId: "workspace-1",
      assistantMessageId: "assistant-1",
      sourceArea: "chat",
      operationType: "chat_answer",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
      occurredAt: new Date("2026-03-19T12:00:01.000Z"),
    });

    const byTurn = await service.listTurnUsageByAssistantMessageIds(["assistant-1"]);
    const turn = byTurn.get("assistant-1");

    expect(turn?.usageTotals).toEqual({
      promptTokens: 25,
      completionTokens: 10,
      totalTokens: 35,
    });
    expect(turn?.usageBreakdown).toHaveLength(2);
  });

  it("rebuilds daily summaries from the usage ledger", async () => {
    const summaryRepository = new InMemoryAccountDailyUsageSummaryRepository();
    const usageEventRepository = new InMemoryUsageEventRepository(summaryRepository);
    const service = new UsageSummaryService(usageEventRepository, summaryRepository);

    await usageEventRepository.record({
      operationKey: "day-1",
      accountId: "account-2",
      workspaceId: "workspace-a",
      sourceArea: "chat",
      operationType: "chat_answer",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 11,
      completionTokens: 9,
      totalTokens: 20,
      occurredAt: new Date("2026-03-01T10:00:00.000Z"),
    });
    await usageEventRepository.record({
      operationKey: "day-2",
      accountId: "account-2",
      workspaceId: "workspace-b",
      sourceArea: "retrieval",
      operationType: "embedding",
      model: "text-embedding-3-small",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 15,
      completionTokens: 0,
      totalTokens: 15,
      occurredAt: new Date("2026-03-02T10:00:00.000Z"),
    });

    await summaryRepository.replaceAllForAccount({ accountId: "account-2", rows: [] });
    await service.rebuildAccountDailySummaries("account-2");

    const summary = await service.getAccountUsageSummary({ accountId: "account-2", days: 10, months: 12 });

    expect(summary.daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-03-01", totals: expect.objectContaining({ totalTokens: 20 }) }),
        expect.objectContaining({ date: "2026-03-02", totals: expect.objectContaining({ totalTokens: 15 }) }),
      ]),
    );
    expect(summary.monthly[0]?.totals.totalTokens).toBe(35);
  });
});
