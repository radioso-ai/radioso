import { describe, expect, it, vi } from "vitest";

import { WebsiteCrawlJobRepository } from "../../../src/db/repositories/websiteCrawlJobRepository.js";

const sampleRow = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  account_id: null,
  workspace_id: "22222222-2222-4222-8222-222222222222",
  source_id: null,
  requested_url: "https://example.com",
  crawl_limit: 5,
  status: "queued" as const,
  attempt_count: 0,
  result_json: null,
  last_error: null,
  available_at: new Date("2026-05-11T10:00:00.000Z"),
  claimed_at: null,
  completed_at: null,
  created_at: new Date("2026-05-11T10:00:00.000Z"),
  updated_at: new Date("2026-05-11T10:00:00.000Z"),
  ...overrides,
});

describe("WebsiteCrawlJobRepository.create", () => {
  it("persists crawler policy and initial checkpoint JSON", async () => {
    const row = sampleRow({
      policy_json: {
        includeUrlPatterns: ["/docs"],
        excludeUrlPatterns: ["/tag"],
        preserveContentLinks: false,
      },
      checkpoint_json: {
        discoveredUrls: ["https://example.com"],
        queuedUrls: ["https://example.com/docs"],
        processingUrls: [],
        processedCanonicalUrls: [],
        accepted: 1,
        skipped: 2,
        failed: 3,
        lastProcessedAt: "2026-05-11T10:00:00.000Z",
      },
    });
    const query = vi.fn().mockResolvedValue([row]);
    const repository = new WebsiteCrawlJobRepository({ query } as never);

    const result = await repository.create({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      requestedUrl: "https://example.com",
      limit: 5,
      policy: {
        includeUrlPatterns: ["/docs"],
        excludeUrlPatterns: ["/tag"],
        preserveContentLinks: false,
      },
      checkpoint: {
        discoveredUrls: ["https://example.com"],
        queuedUrls: ["https://example.com/docs"],
        processingUrls: [],
        processedCanonicalUrls: [],
        accepted: 1,
        skipped: 2,
        failed: 3,
        lastProcessedAt: "2026-05-11T10:00:00.000Z",
      },
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([
      expect.any(String),
      "account-1",
      "workspace-1",
      "source-1",
      "https://example.com",
      5,
      JSON.stringify({
        includeUrlPatterns: ["/docs"],
        excludeUrlPatterns: ["/tag"],
        preserveContentLinks: false,
      }),
      JSON.stringify({
        discoveredUrls: ["https://example.com"],
        queuedUrls: ["https://example.com/docs"],
        processingUrls: [],
        processedCanonicalUrls: [],
        accepted: 1,
        skipped: 2,
        failed: 3,
        lastProcessedAt: "2026-05-11T10:00:00.000Z",
      }),
    ]);
    expect(result.policy).toEqual({
      includeUrlPatterns: ["/docs"],
      excludeUrlPatterns: ["/tag"],
      preserveContentLinks: false,
    });
    expect(result.checkpoint).toEqual(expect.objectContaining({
      queuedUrls: ["https://example.com/docs"],
      accepted: 1,
      skipped: 2,
      failed: 3,
    }));
  });
});

describe("WebsiteCrawlJobRepository.listForWorkspace", () => {
  it("filters recent jobs by updated_at so resumed old jobs stay visible", async () => {
    const query = vi.fn().mockResolvedValue([sampleRow()]);
    const repository = new WebsiteCrawlJobRepository({ query } as never);
    const since = new Date("2026-05-11T09:30:00.000Z");

    const result = await repository.listForWorkspace("workspace-1", {
      status: "processing",
      since,
      limit: 25,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /WHERE workspace_id = \$1\s+AND \(\$2::text IS NULL OR status = \$2\)\s+AND \(\$3::timestamptz IS NULL OR updated_at >= \$3\)\s+AND \(\$5::uuid IS NULL OR source_id = \$5\)\s+ORDER BY updated_at DESC\s+LIMIT \$4/,
    );
    expect(params).toEqual(["workspace-1", "processing", since, 25, null]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", status: "queued" });
  });

  it("defaults limit to 50 and passes nulls when status/since are omitted", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const repository = new WebsiteCrawlJobRepository({ query } as never);

    await repository.listForWorkspace("workspace-1");

    expect(query.mock.calls[0][1]).toEqual(["workspace-1", null, null, 50, null]);
  });

  it("clamps limit to the [1, 200] range", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const repository = new WebsiteCrawlJobRepository({ query } as never);

    await repository.listForWorkspace("workspace-1", { limit: 999 });
    await repository.listForWorkspace("workspace-1", { limit: 0 });

    expect(query.mock.calls[0][1][3]).toBe(200);
    expect(query.mock.calls[1][1][3]).toBe(1);
  });
});

describe("WebsiteCrawlJobRepository.pauseBySourceId/resumePausedBySourceId", () => {
  it("marks active source jobs paused and resumes only unclaimed paused jobs immediately", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([sampleRow({ status: "paused" })])
      .mockResolvedValueOnce([
        { ...sampleRow({ status: "queued", claimed_at: null }), resume_pending: false },
        { ...sampleRow({ status: "paused", claimed_at: new Date("2026-05-11T10:00:30.000Z") }), resume_pending: true },
      ]);
    const repository = new WebsiteCrawlJobRepository({ query } as never);

    await expect(repository.pauseBySourceId("source-1", "workspace-1")).resolves.toHaveLength(1);
    await expect(repository.resumePausedBySourceId("source-1", "workspace-1")).resolves.toMatchObject({
      resumedJobs: [expect.objectContaining({ status: "queued" })],
      pendingResumeJobCount: 1,
    });

    const pauseSql = query.mock.calls[0][0].replace(/\s+/g, " ");
    expect(pauseSql).toMatch(
      /SET status = 'paused'.*claimed_at = CASE WHEN status = 'queued' THEN NULL ELSE claimed_at END.*resume_requested_at = NULL.*WHERE source_id = \$1\s+AND workspace_id = \$2\s+AND \(\s+status IN \('queued', 'processing'\)\s+OR \(status = 'paused' AND resume_requested_at IS NOT NULL\)\s+\).*RETURNING/s,
    );
    expect(query.mock.calls[0][1]).toEqual(["source-1", "workspace-1"]);
    expect(query.mock.calls[1][0].replace(/\s+/g, " ")).toMatch(
      /WITH updated AS \(.*SET status = CASE WHEN claimed_at IS NULL THEN 'queued' ELSE status END,.*available_at = CASE WHEN claimed_at IS NULL THEN NOW\(\) ELSE available_at END,.*resume_requested_at = CASE WHEN claimed_at IS NULL THEN NULL ELSE NOW\(\) END,.*WHERE source_id = \$1\s+AND workspace_id = \$2\s+AND status = 'paused'.*RETURNING.*status = 'paused' AS resume_pending/s,
    );
    expect(query.mock.calls[1][1]).toEqual(["source-1", "workspace-1"]);
  });
});

describe("WebsiteCrawlJobRepository.updateCheckpoint", () => {
  it("updates checkpoint JSON without moving terminal jobs", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);
    const checkpoint = {
      discoveredUrls: ["https://example.com"],
      queuedUrls: [],
      processingUrls: [],
      processedCanonicalUrls: ["https://example.com"],
      accepted: 1,
      skipped: 0,
      failed: 0,
      lastProcessedAt: "2026-05-11T10:00:00.000Z",
    };

    await repository.updateCheckpoint("job-1", checkpoint);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].replace(/\s+/g, " ")).toMatch(
      /SET checkpoint_json = \$2::jsonb.*WHERE id = \$1\s+AND status IN \('processing', 'paused'\)/s,
    );
    expect(execute.mock.calls[0][1]).toEqual(["job-1", JSON.stringify(checkpoint)]);
  });
});

describe("WebsiteCrawlJobRepository.markCompleted", () => {
  it("completes jobs that are still processing or paused after a successful crawl", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);

    await repository.markCompleted("job-1", { accepted: 3 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].replace(/\s+/g, " ")).toMatch(
      /SET status = 'completed'.*WHERE id = \$1\s+AND status IN \('processing', 'paused'\)/s,
    );
    expect(execute.mock.calls[0][1]).toEqual(["job-1", { accepted: 3 }]);
  });
});

describe("WebsiteCrawlJobRepository.releasePausedClaim", () => {
  it("clears the claim only after a paused processing worker stops", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);

    await repository.releasePausedClaim("job-1");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].replace(/\s+/g, " ")).toMatch(
      /SET status = CASE WHEN resume_requested_at IS NULL THEN 'paused' ELSE 'queued' END,.*available_at = CASE WHEN resume_requested_at IS NULL THEN available_at ELSE NOW\(\) END,.*claimed_at = NULL,.*resume_requested_at = NULL.*WHERE id = \$1\s+AND status = 'paused'/s,
    );
    expect(execute.mock.calls[0][1]).toEqual(["job-1"]);
  });
});

describe("WebsiteCrawlJobRepository.releaseAllTimedOutClaims", () => {
  it("requeues expired processing claims and expired paused resume requests", async () => {
    const execute = vi.fn().mockResolvedValue(2);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);
    const cutoff = new Date("2026-05-11T19:30:00.000Z");

    await expect(repository.releaseAllTimedOutClaims(cutoff, "claim_expired")).resolves.toBe(2);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].replace(/\s+/g, " ")).toMatch(
      /SET status = CASE\s+WHEN status = 'processing' THEN 'queued'\s+WHEN status = 'paused' AND resume_requested_at IS NOT NULL THEN 'queued'\s+ELSE status\s+END,\s+available_at = CASE\s+WHEN status = 'processing' OR resume_requested_at IS NOT NULL THEN NOW\(\)\s+ELSE available_at\s+END,\s+claimed_at = NULL,\s+resume_requested_at = NULL,\s+last_error = CASE WHEN status = 'processing' THEN \$2 ELSE last_error END.*WHERE status IN \('processing', 'paused'\)\s+AND \(\s+\(status = 'processing' AND claimed_at <= \$1\)\s+OR \(status = 'paused' AND resume_requested_at IS NULL AND claimed_at <= \$1\)\s+OR \(status = 'paused' AND resume_requested_at IS NOT NULL AND resume_requested_at <= \$1\)\s+\)/s,
    );
    expect(execute.mock.calls[0][1]).toEqual([cutoff, "claim_expired"]);
  });
});

describe("WebsiteCrawlJobRepository.deleteById", () => {
  it("only deletes terminal rows scoped to the workspace and reports whether a row was removed", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);

    const removed = await repository.deleteById("job-1", "workspace-1");

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /DELETE FROM website_crawl_jobs\s+WHERE id = \$1\s+AND workspace_id = \$2\s+AND status IN \('completed', 'failed'\)/,
    );
    expect(params).toEqual(["job-1", "workspace-1"]);
    expect(removed).toBe(true);
  });

  it("returns false when no row matched (missing job, wrong workspace, or non-terminal status)", async () => {
    const execute = vi.fn().mockResolvedValue(0);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);

    const removed = await repository.deleteById("job-1", "workspace-1");
    expect(removed).toBe(false);
  });
});

describe("WebsiteCrawlJobRepository.cancelBySourceId", () => {
  it("deletes every job for the source regardless of status", async () => {
    const execute = vi.fn().mockResolvedValue(4);
    const repository = new WebsiteCrawlJobRepository({ execute } as never);

    const removed = await repository.cancelBySourceId("source-1", "workspace-1");

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /DELETE FROM website_crawl_jobs\s+WHERE source_id = \$1\s+AND workspace_id = \$2/,
    );
    expect(sql).not.toContain("status IN");
    expect(params).toEqual(["source-1", "workspace-1"]);
    expect(removed).toBe(4);
  });
});

describe("WebsiteCrawlJobRepository.claimNext SQL", () => {
  it("qualifies RETURNING columns to avoid ambiguity with the next_job CTE", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const withTransaction = vi.fn().mockImplementation(async (fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    const repository = new WebsiteCrawlJobRepository({ withTransaction } as never);

    await repository.claimNext(new Date("2026-05-11T19:30:00.000Z"));

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    const returningClause = sql.split(/RETURNING/i)[1] ?? "";
    // Each column in the RETURNING list must be qualified with `jobs.` so it
    // unambiguously refers to the website_crawl_jobs target rather than the
    // next_job CTE that also exposes an `id` column.
    for (const column of [
      "id",
      "account_id",
      "workspace_id",
      "source_id",
      "requested_url",
      "crawl_limit",
      "status",
      "attempt_count",
      "result_json",
      "last_error",
      "available_at",
      "claimed_at",
      "completed_at",
      "created_at",
      "updated_at",
    ]) {
      expect(returningClause).toContain(`jobs.${column}`);
    }
  });
});
