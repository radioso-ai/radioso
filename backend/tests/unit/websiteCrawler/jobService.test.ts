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

  it("lists workspace jobs as summaries with documentCount derived from result_json", async () => {
    const baseRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      accountId: null,
      workspaceId: "ws-1",
      sourceId: "src-1",
      requestedUrl: "https://example.com",
      limit: 10,
      status: "completed" as const,
      attemptCount: 1,
      lastError: null,
      availableAt: new Date("2026-05-11T10:00:00.000Z"),
      claimedAt: null,
      completedAt: new Date("2026-05-11T10:05:00.000Z"),
      createdAt: new Date("2026-05-11T10:00:00.000Z"),
      updatedAt: new Date("2026-05-11T10:05:00.000Z"),
    };

    const records = [
      { ...baseRecord, id: "j-1", result: { documentCount: 3, accepted: 5 } },
      { ...baseRecord, id: "j-2", result: { accepted: 7 } },
      { ...baseRecord, id: "j-3", status: "failed" as const, lastError: "boom", result: null, completedAt: null },
      { ...baseRecord, id: "j-4", status: "queued" as const, result: null, completedAt: null },
    ];
    const listForWorkspace = vi.fn().mockResolvedValue(records);

    const service = new WebsiteCrawlJobService({
      repository: { listForWorkspace } as never,
      dispatcher: { dispatch: vi.fn() },
      documentIngestionService: {} as never,
    });

    const summaries = await service.listForWorkspace("ws-1", { sinceMinutes: 15, status: "completed", limit: 4 });

    expect(listForWorkspace).toHaveBeenCalledWith("ws-1", expect.objectContaining({
      status: "completed",
      limit: 4,
    }));
    const sinceArg = listForWorkspace.mock.calls[0][1].since as Date;
    expect(sinceArg).toBeInstanceOf(Date);
    expect(Date.now() - sinceArg.getTime()).toBeGreaterThanOrEqual(15 * 60_000 - 5_000);

    expect(summaries.map((job) => ({ id: job.id, documentCount: job.documentCount, status: job.status, lastError: job.lastError }))).toEqual([
      { id: "j-1", documentCount: 3, status: "completed", lastError: null },
      { id: "j-2", documentCount: 7, status: "completed", lastError: null },
      { id: "j-3", documentCount: null, status: "failed", lastError: "boom" },
      { id: "j-4", documentCount: null, status: "queued", lastError: null },
    ]);
    expect(summaries[0].createdAt).toBe("2026-05-11T10:00:00.000Z");
    expect(summaries[2].completedAt).toBeNull();
  });

  it("lists without a since filter when sinceMinutes is omitted", async () => {
    const listForWorkspace = vi.fn().mockResolvedValue([]);
    const service = new WebsiteCrawlJobService({
      repository: { listForWorkspace } as never,
      dispatcher: { dispatch: vi.fn() },
      documentIngestionService: {} as never,
    });

    await service.listForWorkspace("ws-1");

    expect(listForWorkspace.mock.calls[0][1]).toEqual({ status: undefined, since: undefined, limit: undefined });
  });

  it("deleteJob removes a terminal job after confirming workspace ownership", async () => {
    const findById = vi.fn().mockResolvedValue({
      id: "job-1",
      workspaceId: "ws-1",
      status: "completed",
    });
    const deleteById = vi.fn().mockResolvedValue(true);

    const service = new WebsiteCrawlJobService({
      repository: { findById, deleteById } as never,
      dispatcher: { dispatch: vi.fn() },
      documentIngestionService: {} as never,
    });

    await service.deleteJob({ workspaceId: "ws-1", jobId: "job-1" });

    expect(findById).toHaveBeenCalledWith("job-1");
    expect(deleteById).toHaveBeenCalledWith("job-1", "ws-1");
  });

  it("deleteJob throws notFound when the job is missing", async () => {
    const findById = vi.fn().mockResolvedValue(null);
    const service = new WebsiteCrawlJobService({
      repository: { findById, deleteById: vi.fn() } as never,
      dispatcher: { dispatch: vi.fn() },
      documentIngestionService: {} as never,
    });

    await expect(service.deleteJob({ workspaceId: "ws-1", jobId: "missing" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("deleteJob throws notFound when the job belongs to another workspace", async () => {
    const findById = vi.fn().mockResolvedValue({
      id: "job-1",
      workspaceId: "ws-2",
      status: "completed",
    });
    const deleteById = vi.fn();
    const service = new WebsiteCrawlJobService({
      repository: { findById, deleteById } as never,
      dispatcher: { dispatch: vi.fn() },
      documentIngestionService: {} as never,
    });

    await expect(service.deleteJob({ workspaceId: "ws-1", jobId: "job-1" })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(deleteById).not.toHaveBeenCalled();
  });

  it("deleteJob throws conflict when the job is still in flight", async () => {
    const findById = vi.fn().mockResolvedValue({
      id: "job-1",
      workspaceId: "ws-1",
      status: "processing",
    });
    const deleteById = vi.fn();
    const service = new WebsiteCrawlJobService({
      repository: { findById, deleteById } as never,
      dispatcher: { dispatch: vi.fn() },
      documentIngestionService: {} as never,
    });

    await expect(service.deleteJob({ workspaceId: "ws-1", jobId: "job-1" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deleteById).not.toHaveBeenCalled();
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
