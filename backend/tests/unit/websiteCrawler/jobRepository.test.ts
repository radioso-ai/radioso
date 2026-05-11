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

describe("WebsiteCrawlJobRepository.listForWorkspace", () => {
  it("filters by workspace, status, and since with a default limit cap", async () => {
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
      /WHERE workspace_id = \$1\s+AND \(\$2::text IS NULL OR status = \$2\)\s+AND \(\$3::timestamptz IS NULL OR created_at >= \$3\)\s+ORDER BY created_at DESC\s+LIMIT \$4/,
    );
    expect(params).toEqual(["workspace-1", "processing", since, 25]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", status: "queued" });
  });

  it("defaults limit to 50 and passes nulls when status/since are omitted", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const repository = new WebsiteCrawlJobRepository({ query } as never);

    await repository.listForWorkspace("workspace-1");

    expect(query.mock.calls[0][1]).toEqual(["workspace-1", null, null, 50]);
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
