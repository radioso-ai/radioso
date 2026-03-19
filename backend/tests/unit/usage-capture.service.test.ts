import { describe, expect, it } from "vitest";

import { UsageCaptureService } from "../../src/modules/usage/services/usageCaptureService.js";
import {
  InMemoryAccountDailyUsageSummaryRepository,
  InMemoryUsageEventRepository,
} from "../support/fakes.js";

describe("usage capture service", () => {
  it("buffers observed operations until flush when scope defers persistence", async () => {
    const summaryRepository = new InMemoryAccountDailyUsageSummaryRepository();
    const usageEventRepository = new InMemoryUsageEventRepository(summaryRepository);
    const service = new UsageCaptureService(usageEventRepository);

    await service.runInScope(
      {
        accountId: "account-1",
        workspaceId: "workspace-1",
        deferPersistUntilFlush: true,
      },
      async () => {
        await service.observe({
          operationKey: "rewrite-1",
          sourceArea: "retrieval",
          operationType: "query_rewrite",
          model: "gpt-5-mini",
          eventStatus: "success",
          usageAvailable: true,
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        });

        expect(usageEventRepository.items).toHaveLength(0);

        await service.flushCurrentScope({
          conversationId: "conversation-1",
          assistantMessageId: "assistant-1",
        });
      },
    );

    expect(usageEventRepository.items).toHaveLength(1);
    expect(usageEventRepository.items[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      assistantMessageId: "assistant-1",
      totalTokens: 14,
    });
    expect(await summaryRepository.findByAccountIdAndDate("account-1", new Date().toISOString().slice(0, 10))).toMatchObject({
      totalTokens: 14,
      usageEventCount: 1,
    });
  });

  it("persists immediately when scope does not defer", async () => {
    const summaryRepository = new InMemoryAccountDailyUsageSummaryRepository();
    const usageEventRepository = new InMemoryUsageEventRepository(summaryRepository);
    const service = new UsageCaptureService(usageEventRepository);

    await service.runInScope(
      {
        accountId: "account-2",
        workspaceId: "workspace-2",
      },
      async () => {
        await service.observe({
          operationKey: "embedding-1",
          sourceArea: "document_processing",
          operationType: "embedding",
          model: "text-embedding-3-small",
          eventStatus: "success",
          usageAvailable: true,
          promptTokens: 20,
          completionTokens: 0,
          totalTokens: 20,
          documentId: "document-1",
        });
      },
    );

    expect(usageEventRepository.items).toHaveLength(1);
    expect(usageEventRepository.items[0]).toMatchObject({
      accountId: "account-2",
      documentId: "document-1",
      totalTokens: 20,
    });
  });
});
