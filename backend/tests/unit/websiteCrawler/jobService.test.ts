import { describe, expect, it, vi } from "vitest";

import { WebsiteCrawlJobService } from "../../../src/modules/websiteCrawler/jobService.js";

describe("website crawl job service", () => {
  it("creates a durable job before dispatching a crawl notification", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      requestedUrl: "https://example.com",
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const resolveSource = vi.fn().mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
    const service = new WebsiteCrawlJobService({
      repository: { create } as never,
      dispatcher: { dispatch },
      documentIngestionService: { resolveSource } as never,
      assertCrawlUrlAllowed: vi.fn().mockResolvedValue(undefined),
    });

    const result = await service.enqueue({
      accountId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      url: "https://example.com/",
      limit: 3,
    });

    expect(create).toHaveBeenCalledWith({
      accountId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      requestedUrl: "https://example.com",
      limit: 3,
    });
    expect(dispatch).toHaveBeenCalledWith({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    });
    expect(result).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      sourceId: "33333333-3333-4333-8333-333333333333",
      requestedUrl: "https://example.com",
      status: "queued",
    });
  });

  it("still returns the durable job when dispatch notification fails", async () => {
    const warn = vi.fn();
    const service = new WebsiteCrawlJobService({
      repository: {
        create: vi.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          sourceId: null,
          requestedUrl: "https://example.com",
        }),
      } as never,
      dispatcher: { dispatch: vi.fn().mockRejectedValue(new Error("queue offline")) },
      documentIngestionService: {} as never,
      logger: { warn } as never,
      assertCrawlUrlAllowed: vi.fn().mockResolvedValue(undefined),
    });

    await expect(service.enqueue({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      url: "https://example.com",
      limit: 1,
    })).resolves.toMatchObject({
      jobId: "11111111-1111-4111-8111-111111111111",
      status: "queued",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
