import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { WebsiteCrawlJobRepository } from "../../src/db/repositories/websiteCrawlJobRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("WebsiteCrawlJobRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new WebsiteCrawlJobRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Website Crawl Test Co", `crawl-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Website Crawl Workspace", `crawl-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, config, metadata) VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb)`,
      [sourceId, workspaceId, "website", "Docs Site"],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM website_crawl_jobs WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("creates, finds, lists, checkpoints, completes, and deletes terminal jobs", async () => {
    const job = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/docs",
      limit: 10,
      policy: {
        includeUrlPatterns: ["/docs"],
        excludeUrlPatterns: ["/archive"],
        preserveContentLinks: false,
      },
      checkpoint: {
        discoveredUrls: ["https://example.com/docs"],
        queuedUrls: ["https://example.com/docs"],
        processingUrls: [],
        processedCanonicalUrls: [],
        accepted: 0,
        skipped: 0,
        failed: 0,
        lastProcessedAt: null,
      },
    });

    expect(job.status).toBe("queued");
    expect(job.policy.includeUrlPatterns).toEqual(["/docs"]);

    // create() stamps available_at = now(); pin it so the fixed claim time is valid.
    await database.query("UPDATE website_crawl_jobs SET available_at = $2 WHERE id = $1", [
      job.id,
      new Date("2026-05-11T10:00:00.000Z"),
    ]);
    const claimed = await repository.claimById(job.id, new Date("2026-05-11T10:01:00.000Z"));
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attemptCount).toBe(1);

    // updateCheckpoint only applies to processing/paused jobs, so it must run after the claim.
    await repository.updateCheckpoint(job.id, {
      discoveredUrls: ["https://example.com/docs"],
      queuedUrls: [],
      processingUrls: ["https://example.com/docs"],
      processedCanonicalUrls: [],
      accepted: 1,
      skipped: 0,
      failed: 0,
      lastProcessedAt: "2026-05-11T10:00:00.000Z",
    });

    await repository.markCompleted(job.id, { accepted: 1 });
    const found = await repository.findByIdAndWorkspaceId(job.id, workspaceId);
    expect(found).toMatchObject({
      id: job.id,
      workspaceId,
      status: "completed",
      result: { accepted: 1 },
    });
    expect(found?.checkpoint.accepted).toBe(1);

    const listed = await repository.listForWorkspace(workspaceId, { status: "completed", sourceId, limit: 500 });
    expect(listed.map((item) => item.id)).toEqual([job.id]);

    await expect(repository.deleteById(job.id, randomUUID())).resolves.toBe(false);
    await expect(repository.deleteById(job.id, workspaceId)).resolves.toBe(true);
    await expect(repository.findById(job.id)).resolves.toBeNull();
  });

  it("requeues a yielded claim only when the caller still owns that claim", async () => {
    const job = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/yielded",
      limit: 100,
    });
    await database.query("UPDATE website_crawl_jobs SET available_at = $2 WHERE id = $1", [
      job.id,
      new Date("2026-05-11T10:00:00.000Z"),
    ]);
    const claimedAt = new Date("2026-05-11T10:01:00.000Z");
    await repository.claimById(job.id, claimedAt);

    await expect(
      repository.releaseForContinuation(job.id, new Date("2026-05-11T10:00:59.000Z")),
    ).resolves.toBe(false);
    await expect(repository.releaseForContinuation(job.id, claimedAt)).resolves.toBe(true);

    const yielded = await repository.findById(job.id);
    expect(yielded).toMatchObject({
      status: "queued",
      claimedAt: null,
      lastError: null,
    });
    await expect(repository.claimById(job.id, new Date("2026-05-11T10:02:00.000Z"))).resolves.toMatchObject({
      status: "processing",
      attemptCount: 2,
    });
  });

  it("pauses active source jobs, resumes unclaimed jobs, and releases paused claims", async () => {
    const claimedJob = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/a",
      limit: 5,
    });
    const queuedJob = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/b",
      limit: 5,
    });

    await database.query("UPDATE website_crawl_jobs SET available_at = $1 WHERE workspace_id = $2", [
      new Date("2026-05-11T09:00:00.000Z"),
      workspaceId,
    ]);
    await repository.claimById(claimedJob.id, new Date("2026-05-11T10:00:00.000Z"));

    const paused = await repository.pauseBySourceId(sourceId, workspaceId);
    expect(paused.map((job) => job.id).sort()).toEqual([claimedJob.id, queuedJob.id].sort());
    expect(paused.every((job) => job.status === "paused")).toBe(true);

    const resumed = await repository.resumePausedBySourceId(sourceId, workspaceId);
    expect(resumed.resumedJobs.map((job) => job.id)).toEqual([queuedJob.id]);
    expect(resumed.pendingResumeJobCount).toBe(1);

    await repository.releasePausedClaim(claimedJob.id);
    const released = await repository.findById(claimedJob.id);
    expect(released?.status).toBe("queued");
    expect(released?.claimedAt).toBeNull();
  });

  it("claims the oldest available job, releases timed-out claims, fails jobs, and cancels by source", async () => {
    const older = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/old",
      limit: 5,
    });
    const future = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/future",
      limit: 5,
    });
    await database.query("UPDATE website_crawl_jobs SET available_at = $2 WHERE id = $1", [
      older.id,
      new Date("2026-05-11T09:00:00.000Z"),
    ]);
    await database.query("UPDATE website_crawl_jobs SET available_at = $2 WHERE id = $1", [
      future.id,
      new Date("2026-05-11T12:00:00.000Z"),
    ]);

    const claimed = await repository.claimNext(new Date("2026-05-11T10:00:00.000Z"));
    expect(claimed?.id).toBe(older.id);
    expect(await repository.claimNext(new Date("2026-05-11T10:00:00.000Z"))).toBeNull();

    await expect(
      repository.releaseTimedOutClaim(older.id, new Date("2026-05-11T09:59:00.000Z"), "too early"),
    ).resolves.toBe(false);
    await expect(
      repository.releaseTimedOutClaim(older.id, new Date("2026-05-11T10:00:00.000Z"), "claim expired"),
    ).resolves.toBe(true);

    await repository.claimById(older.id, new Date("2026-05-11T10:02:00.000Z"));
    await repository.markFailed(older.id, "crawl failed");
    expect((await repository.findById(older.id))?.status).toBe("failed");

    await expect(repository.cancelBySourceId(sourceId, workspaceId)).resolves.toBe(2);
    await expect(repository.listForWorkspace(workspaceId)).resolves.toEqual([]);
  });

  it("bulk releases expired processing and paused claims", async () => {
    const processing = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/processing",
      limit: 5,
    });
    const paused = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/paused",
      limit: 5,
    });
    const pausedResume = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/resume",
      limit: 5,
    });

    await database.query(
      `UPDATE website_crawl_jobs
       SET status = 'processing', claimed_at = $2
       WHERE id = $1`,
      [processing.id, new Date("2026-05-11T09:00:00.000Z")],
    );
    await database.query(
      `UPDATE website_crawl_jobs
       SET status = 'paused', claimed_at = $2
       WHERE id = $1`,
      [paused.id, new Date("2026-05-11T09:00:00.000Z")],
    );
    await database.query(
      `UPDATE website_crawl_jobs
       SET status = 'paused', claimed_at = $2, resume_requested_at = $2
       WHERE id = $1`,
      [pausedResume.id, new Date("2026-05-11T09:00:00.000Z")],
    );

    await expect(
      repository.releaseAllTimedOutClaims(new Date("2026-05-11T10:00:00.000Z"), "expired"),
    ).resolves.toBe(3);

    const rows = await database.query<{ id: string; status: string; claimed_at: Date | null; last_error: string | null }>(
      `SELECT id, status, claimed_at, last_error FROM website_crawl_jobs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(processing.id)).toMatchObject({ status: "queued", claimed_at: null, last_error: "expired" });
    expect(byId.get(paused.id)).toMatchObject({ status: "paused", claimed_at: null });
    expect(byId.get(pausedResume.id)).toMatchObject({ status: "queued", claimed_at: null });
  });
});
