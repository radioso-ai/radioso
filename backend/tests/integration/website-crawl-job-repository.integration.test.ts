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
  const otherWorkspaceId = randomUUID();
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
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [otherWorkspaceId, accountId, "Other Website Crawl Workspace", `crawl-route-${otherWorkspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, config, metadata) VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb)`,
      [sourceId, workspaceId, "website", "Docs Site"],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM website_crawl_jobs WHERE workspace_id = ANY($1::uuid[])", [[workspaceId, otherWorkspaceId]]);
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
    await expect(repository.updateCheckpoint(job.id, claimed!.attemptCount, {
      discoveredUrls: ["https://example.com/docs"],
      queuedUrls: [],
      processingUrls: ["https://example.com/docs"],
      processedCanonicalUrls: [],
      accepted: 1,
      skipped: 0,
      failed: 0,
      lastProcessedAt: "2026-05-11T10:00:00.000Z",
    })).resolves.toBe(true);

    await expect(repository.markCompleted(job.id, claimed!.attemptCount, { accepted: 1 })).resolves.toBe(true);
    await expect(repository.updateCheckpoint(job.id, claimed!.attemptCount, job.checkpoint)).resolves.toBe(false);
    await expect(repository.markCompleted(job.id, claimed!.attemptCount, { accepted: 2 })).resolves.toBe(false);
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

  it("atomically creates source-bound jobs only when the source belongs to the workspace", async () => {
    const valid = await repository.createForSource({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/valid-source",
      limit: 5,
    });
    const wrongWorkspace = await repository.createForSource({
      accountId,
      workspaceId: otherWorkspaceId,
      sourceId,
      requestedUrl: "https://example.com/wrong-workspace",
      limit: 5,
    });
    const missingSource = await repository.createForSource({
      accountId,
      workspaceId,
      sourceId: randomUUID(),
      requestedUrl: "https://example.com/missing-source",
      limit: 5,
    });

    expect(valid).toMatchObject({ workspaceId, sourceId, status: "queued" });
    expect(wrongWorkspace).toBeNull();
    expect(missingSource).toBeNull();
    await expect(repository.listForWorkspace(workspaceId)).resolves.toEqual([
      expect.objectContaining({ id: valid?.id, sourceId }),
    ]);
    await expect(repository.listForWorkspace(otherWorkspaceId)).resolves.toEqual([]);
  });

  it("requeues a yielded claim only when the caller still owns that claim", async () => {
    const job = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/yielded",
      limit: 100,
    });
    const claimedAt = new Date(job.createdAt.getTime() + 60_000);
    const claimed = await repository.claimById(job.id, claimedAt);

    await expect(repository.releaseForContinuation(job.id, claimed!.attemptCount - 1)).resolves.toBe(false);
    await expect(repository.releaseForContinuation(job.id, claimed!.attemptCount)).resolves.toBe(true);

    const yielded = await repository.findById(job.id);
    expect(yielded).toMatchObject({
      status: "queued",
      claimedAt: null,
      lastError: null,
    });
    await expect(repository.claimById(job.id, new Date(claimedAt.getTime() + 60_000))).resolves.toMatchObject({
      status: "processing",
      attemptCount: 2,
    });
  });

  it("round-trips the generation from a database-clock claim through fenced writes", async () => {
    const job = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/database-clock-claim",
      limit: 5,
    });
    await database.query(
      `UPDATE website_crawl_jobs
       SET available_at = '2000-01-01T00:00:00.000Z'::timestamptz,
           created_at = '2000-01-01T00:00:00.000Z'::timestamptz
       WHERE id = $1`,
      [job.id],
    );

    const claimed = await repository.claimNext();

    expect(claimed).toMatchObject({ id: job.id, status: "processing", attemptCount: 1 });
    await expect(repository.updateCheckpoint(job.id, claimed!.attemptCount, {
      ...claimed!.checkpoint,
      accepted: 1,
    })).resolves.toBe(true);
    await expect(repository.markCompleted(job.id, claimed!.attemptCount, { accepted: 1 }))
      .resolves.toBe(true);
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

    await expect(repository.releasePausedClaim(claimedJob.id, paused.find((job) => job.id === claimedJob.id)!.attemptCount))
      .resolves.toBe(true);
    await expect(repository.releasePausedClaim(claimedJob.id, paused.find((job) => job.id === claimedJob.id)!.attemptCount))
      .resolves.toBe(false);
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

    const reclaimed = await repository.claimById(older.id, new Date("2026-05-11T10:02:00.000Z"));
    await expect(repository.markFailed(older.id, reclaimed!.attemptCount, "crawl failed")).resolves.toBe(true);
    await expect(repository.markFailed(older.id, reclaimed!.attemptCount, "crawl failed again")).resolves.toBe(false);
    expect((await repository.findById(older.id))?.status).toBe("failed");

    await expect(repository.cancelBySourceId(sourceId, workspaceId)).resolves.toBe(2);
    await expect(repository.listForWorkspace(workspaceId)).resolves.toEqual([]);
  });

  it("releases expired processing and paused claims in bounded committed batches", async () => {
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
      workspaceId: otherWorkspaceId,
      requestedUrl: "https://example.com/resume",
      limit: 5,
    });
    const otherProcessing = await repository.create({
      accountId,
      workspaceId: otherWorkspaceId,
      requestedUrl: "https://example.com/other-processing",
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
    await database.query(
      `UPDATE website_crawl_jobs
       SET status = 'processing', claimed_at = $2
       WHERE id = $1`,
      [otherProcessing.id, new Date("2026-05-11T09:00:00.000Z")],
    );
    await database.query(
      `UPDATE website_crawl_jobs
       SET updated_at = CASE id
         WHEN $1 THEN '2026-05-11T08:00:00.000Z'::timestamptz
         WHEN $2 THEN '2026-05-11T08:01:00.000Z'::timestamptz
         WHEN $3 THEN '2026-05-11T08:02:00.000Z'::timestamptz
         WHEN $4 THEN '2026-05-11T08:03:00.000Z'::timestamptz
         ELSE updated_at
       END
       WHERE id = ANY($5::uuid[])`,
      [processing.id, paused.id, pausedResume.id, otherProcessing.id, [processing.id, paused.id, pausedResume.id, otherProcessing.id]],
    );

    await expect(
      repository.releaseTimedOutClaimsBatch(new Date("2026-05-11T10:00:00.000Z"), "expired", 2),
    ).resolves.toEqual({ releasedCount: 2, workspaceIds: [workspaceId], hasMore: true });
    await expect(
      repository.releaseTimedOutClaimsBatch(new Date("2026-05-11T10:00:00.000Z"), "expired", 2),
    ).resolves.toEqual({ releasedCount: 2, workspaceIds: [otherWorkspaceId], hasMore: false });

    const rows = await database.query<{ id: string; status: string; claimed_at: Date | null; last_error: string | null }>(
      `SELECT id, status, claimed_at, last_error
       FROM website_crawl_jobs
       WHERE workspace_id = ANY($1::uuid[])`,
      [[workspaceId, otherWorkspaceId]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(processing.id)).toMatchObject({ status: "queued", claimed_at: null, last_error: "expired" });
    expect(byId.get(paused.id)).toMatchObject({ status: "paused", claimed_at: null });
    expect(byId.get(pausedResume.id)).toMatchObject({ status: "queued", claimed_at: null });
    expect(byId.get(otherProcessing.id)).toMatchObject({ status: "queued", claimed_at: null, last_error: "expired" });
  });

  it("does not report the same stale row from concurrent recovery workers", async () => {
    const jobs = await Promise.all([0, 1].map((index) => repository.create({
      accountId,
      workspaceId,
      requestedUrl: `https://example.com/concurrent-${index}`,
      limit: 5,
    })));
    await database.query(
      `UPDATE website_crawl_jobs
       SET status = 'processing', claimed_at = $2, updated_at = $2
       WHERE id = ANY($1::uuid[])`,
      [jobs.map((job) => job.id), new Date("2026-05-11T09:00:00.000Z")],
    );

    const initialBatches = await Promise.all([
      repository.releaseTimedOutClaimsBatch(new Date("2026-05-11T10:00:00.000Z"), "expired", 1),
      repository.releaseTimedOutClaimsBatch(new Date("2026-05-11T10:00:00.000Z"), "expired", 1),
    ]);
    const queuedAfterConcurrentRecovery = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM website_crawl_jobs
       WHERE id = ANY($1::uuid[]) AND status = 'queued'`,
      [jobs.map((job) => job.id)],
    );

    expect(initialBatches.reduce((sum, batch) => sum + batch.releasedCount, 0))
      .toBe(Number(queuedAfterConcurrentRecovery[0]?.count ?? 0));
    expect(initialBatches.every((batch) => batch.releasedCount <= 1)).toBe(true);

    await repository.releaseTimedOutClaimsBatch(new Date("2026-05-11T10:00:00.000Z"), "expired", 1);
    const terminalRows = await Promise.all(jobs.map((job) => repository.findById(job.id)));
    expect(terminalRows.every((job) => job?.status === "queued")).toBe(true);
  });

  it("rejects every mutation from an expired worker after a newer reclaim", async () => {
    const created = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/generation-fence",
      limit: 5,
    });
    await database.query("UPDATE website_crawl_jobs SET available_at = $2 WHERE id = $1", [
      created.id,
      new Date("2026-05-11T09:00:00.000Z"),
    ]);
    const oldClaim = await repository.claimById(created.id, new Date("2026-05-11T10:00:00.000Z"));
    await expect(
      repository.releaseTimedOutClaim(created.id, oldClaim!.claimedAt!, "claim_expired"),
    ).resolves.toBe(true);
    const newClaim = await repository.claimById(created.id, new Date("2026-05-11T10:06:00.000Z"));
    const staleCheckpoint = { ...oldClaim!.checkpoint, accepted: 99 };

    await expect(repository.updateCheckpoint(created.id, oldClaim!.attemptCount, staleCheckpoint))
      .resolves.toBe(false);
    await expect(repository.markCompleted(created.id, oldClaim!.attemptCount, { accepted: 99 }))
      .resolves.toBe(false);
    await expect(repository.markFailed(created.id, oldClaim!.attemptCount, "stale worker failed"))
      .resolves.toBe(false);
    expect(await repository.findById(created.id)).toMatchObject({
      status: "processing",
      claimedAt: newClaim!.claimedAt,
      checkpoint: expect.objectContaining({ accepted: 0 }),
    });

    await repository.pauseBySourceId(sourceId, workspaceId);
    await expect(repository.releasePausedClaim(created.id, oldClaim!.attemptCount)).resolves.toBe(false);
    expect(await repository.findById(created.id)).toMatchObject({
      status: "paused",
      claimedAt: newClaim!.claimedAt,
    });
    await expect(repository.releasePausedClaim(created.id, newClaim!.attemptCount)).resolves.toBe(true);
  });

  it("installs seekable partial indexes for every stale-claim predicate", async () => {
    const rows = await database.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'website_crawl_jobs'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[
        "idx_website_crawl_jobs_stale_processing",
        "idx_website_crawl_jobs_stale_paused_claim",
        "idx_website_crawl_jobs_stale_paused_resume",
      ]],
    );

    expect(rows.map((row) => row.indexname)).toEqual([
      "idx_website_crawl_jobs_stale_paused_claim",
      "idx_website_crawl_jobs_stale_paused_resume",
      "idx_website_crawl_jobs_stale_processing",
    ]);
    expect(rows.find((row) => row.indexname.endsWith("processing"))?.indexdef)
      .toContain("(claimed_at, updated_at, id)");
    expect(rows.find((row) => row.indexname.endsWith("paused_claim"))?.indexdef)
      .toContain("(claimed_at, updated_at, id)");
    expect(rows.find((row) => row.indexname.endsWith("paused_resume"))?.indexdef)
      .toContain("(resume_requested_at, updated_at, id)");
  });

  it("plans bounded stale recovery through the predicate-specific indexes", async () => {
    const job = await repository.create({
      accountId,
      workspaceId,
      sourceId,
      requestedUrl: "https://example.com/explain-stale-recovery",
      limit: 5,
    });
    await database.query(
      `UPDATE website_crawl_jobs
       SET status = 'processing', claimed_at = $2, updated_at = $2
       WHERE id = $1`,
      [job.id, new Date("2026-05-11T09:00:00.000Z")],
    );

    const plan = await database.withTransaction(async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         SELECT id, workspace_id
         FROM website_crawl_jobs
         WHERE (
             (status = 'processing' AND claimed_at <= $1)
             OR (status = 'paused' AND resume_requested_at IS NULL AND claimed_at <= $1)
             OR (status = 'paused' AND resume_requested_at IS NOT NULL AND resume_requested_at <= $1)
           )
         ORDER BY updated_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 101`,
        [new Date("2026-05-11T10:00:00.000Z")],
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toMatch(/idx_website_crawl_jobs_stale_(processing|paused_claim|paused_resume)/);
  });
});
