import { describe, expect, it, vi } from "vitest";

import { DocumentSourceRecrawlService } from "../../src/modules/documents/services/documentSourceRecrawlService.js";

const sourceId = "22222222-2222-4222-8222-222222222222";

const websiteSource = (config: Record<string, unknown> = {}) => ({
  id: sourceId,
  workspaceId: "workspace-1",
  kind: "website" as const,
  name: "Help center",
  externalId: null,
  config: {
    url: "https://help.example.com",
    limit: 500,
    policy: { includeUrlPatterns: ["/docs/**"], preserveContentLinks: true },
    ...config,
  },
  metadata: {},
  lastSyncStatus: "completed",
  lastSyncedAt: new Date("2026-08-29T10:00:00.000Z"),
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-29T10:00:00.000Z"),
});

const dependencies = (source: ReturnType<typeof websiteSource> | null = websiteSource()) => {
  const findByIdAndWorkspaceId = vi.fn(async () => source);
  const enqueueForSource = vi.fn(async () => ({
    jobId: "44444444-4444-4444-8444-444444444444",
    sourceId,
    requestedUrl: "https://help.example.com",
    status: "queued" as const,
  }));
  return { findByIdAndWorkspaceId, enqueueForSource };
};

describe("DocumentSourceRecrawlService", () => {
  it("resolves stored crawl settings, caps the persisted limit, and forwards operator attribution", async () => {
    const deps = dependencies(websiteSource({ limit: 999 }));
    const service = new DocumentSourceRecrawlService({
      sourceRepository: deps,
      crawlJobs: deps,
      crawlerConfig: { defaultLimit: 25, maxLimit: 100 },
    });

    await expect(service.recrawlSource({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sourceId,
    })).resolves.toMatchObject({ sourceId, status: "queued" });

    expect(deps.findByIdAndWorkspaceId).toHaveBeenCalledWith(sourceId, "workspace-1");
    expect(deps.enqueueForSource).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sourceId,
      url: "https://help.example.com",
      limit: 100,
      policy: { includeUrlPatterns: ["/docs/**"], preserveContentLinks: true },
    });
  });

  it.each([
    ["a non-number", "untrusted"],
    ["zero", 0],
    ["a negative number", -1],
    ["a fractional number", 10.5],
  ])("uses the configured default when the stored limit is %s", async (_description, limit) => {
    const deps = dependencies(websiteSource({ limit }));
    const service = new DocumentSourceRecrawlService({
      sourceRepository: deps,
      crawlJobs: deps,
      crawlerConfig: { defaultLimit: 25, maxLimit: 100 },
    });

    await service.recrawlSource({ accountId: "account-1", workspaceId: "workspace-1", sourceId });

    expect(deps.enqueueForSource).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it("rejects a missing source, a non-website source, and a website source without a stored URL", async () => {
    const missing = dependencies(null);
    const missingService = new DocumentSourceRecrawlService({
      sourceRepository: missing,
      crawlJobs: missing,
      crawlerConfig: { defaultLimit: 25, maxLimit: 100 },
    });
    await expect(missingService.recrawlSource({ accountId: "account-1", workspaceId: "workspace-1", sourceId }))
      .rejects.toThrow("Source not found");

    const upload = dependencies({ ...websiteSource(), kind: "upload" as never });
    const uploadService = new DocumentSourceRecrawlService({
      sourceRepository: upload,
      crawlJobs: upload,
      crawlerConfig: { defaultLimit: 25, maxLimit: 100 },
    });
    await expect(uploadService.recrawlSource({ accountId: "account-1", workspaceId: "workspace-1", sourceId }))
      .rejects.toThrow("Only website sources can be recrawled");

    const urlMissing = dependencies(websiteSource({ url: null }));
    const urlMissingService = new DocumentSourceRecrawlService({
      sourceRepository: urlMissing,
      crawlJobs: urlMissing,
      crawlerConfig: { defaultLimit: 25, maxLimit: 100 },
    });
    await expect(urlMissingService.recrawlSource({ accountId: "account-1", workspaceId: "workspace-1", sourceId }))
      .rejects.toThrow("Source has no configured URL");
  });
});
