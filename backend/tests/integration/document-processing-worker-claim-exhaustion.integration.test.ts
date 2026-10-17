import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { EmbeddingProfileJobFailureAdapter } from "../../src/app/composition/embeddingProfileJobFailureAdapter.js";
import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { EmbeddingProfileRepository } from "../../src/db/repositories/embeddingProfileRepository.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { EmbeddingTransitionCoordinator } from "../../src/modules/embeddingProfiles/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Matches MAX_ATTEMPTS / DEFAULT_JOB_LEASE_MS inside documentProcessingWorker.ts.
// The worker is constructed with this exact lease length below, so these
// tests' own lease math (afterLease) and the worker's internal cutoff
// computation always agree.
const MAX_ATTEMPTS = 3;
const JOB_LEASE_MS = 300_000;

const secondsFromNow = (seconds: number) => new Date(Date.now() + seconds * 1_000);
const afterLease = (claimedAt: Date) => new Date(claimedAt.getTime() + JOB_LEASE_MS + 1);

describeIntegration("DocumentProcessingWorker claim-expiry attempt exhaustion (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const jobs = new DocumentProcessingJobRepository(database.kysely);
  const documents = new DocumentRepository(database.kysely);
  const profiles = new EmbeddingProfileRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Claim Exhaustion Test Co", `claim-exhaustion-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Claim Exhaustion Workspace", `claim-exhaustion-route-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_transitions WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM embedding_spaces WHERE identity_fingerprint LIKE $1", [`claim-exhaustion-${workspaceId}-%`]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertDocument = async (status: string, revision = 1): Promise<string> => {
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Doc', 'Content', 'Content', $3, $4, '{}'::jsonb)`,
      [documentId, workspaceId, status, revision],
    );
    return documentId;
  };

  const buildWorker = (
    overrides: Partial<{
      telemetryService: { emit: ReturnType<typeof vi.fn> };
      auditService: { record: ReturnType<typeof vi.fn> };
      publisher: { enqueue: ReturnType<typeof vi.fn> };
      embeddingProfileTerminalFailures: unknown;
      processingService: unknown;
    }> = {},
  ) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return new DocumentProcessingWorker(
      documents,
      jobs,
      (overrides.processingService ?? { process: vi.fn() }) as never,
      (overrides.auditService ?? { record: vi.fn().mockResolvedValue(undefined) }) as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
      overrides.telemetryService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      overrides.embeddingProfileTerminalFailures as never,
      overrides.publisher as never,
    );
  };

  // Simulates a run that never returns, MAX_ATTEMPTS times: each round claims
  // the job (as the push worker's request-driven claim would) and abandons
  // it without ever calling back in — exactly what the platform's request
  // timeout does to a document too large to finish inside one request.
  // Returns the final claim's timestamp so the caller can expire that lease
  // too and trigger the worker's own exhausted-claim handling.
  const exhaustAttemptsAtRepositoryLayer = async (jobId: string): Promise<Date> => {
    let claimedAt = secondsFromNow(1);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claimed = await jobs.claimById(jobId, claimedAt);
      expect(claimed?.attemptCount).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        const outcome = await jobs.releaseOrFailExpiredClaim({
          jobId,
          claimedAtOrBefore: afterLease(claimedAt),
          maxAttempts: MAX_ATTEMPTS,
          releasedReason: "claim_expired",
          exhaustedReason: "claim_expired_attempts_exhausted",
        });
        expect(outcome).toEqual({ outcome: "released" });
        claimedAt = afterLease(claimedAt);
      }
    }
    return claimedAt;
  };

  it("fails a vectorize job and its document the same way the normal terminal path would", async () => {
    const documentId = await insertDocument("processing");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });

    const telemetryService = { emit: vi.fn().mockResolvedValue(null) };
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const publisher = { enqueue: vi.fn() };
    const worker = buildWorker({ telemetryService, auditService, publisher });

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);
    await expect(worker.runOnce(afterLease(lastClaimedAt))).resolves.toBe(false);

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({
      status: "failed",
      lastError: "claim_expired_attempts_exhausted",
      attemptCount: 3,
    });

    const finalDocumentRows = await database.query<{ status: string; failure_reason: string | null }>(
      "SELECT status, failure_reason FROM documents WHERE id = $1",
      [documentId],
    );
    expect(finalDocumentRows[0]).toEqual({
      status: "failed",
      failure_reason: "claim_expired_attempts_exhausted",
    });

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "document.process",
        eventStatus: "failure",
        metadata: expect.objectContaining({ retryScheduled: false, reason: "claim_expired_attempts_exhausted" }),
      }),
    );
    expect(telemetryService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "document.worker.claim_expired_attempts_exhausted" }),
    );
    expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["document.status_changed"]);

    // Never reclaimed again — checked by actual status, not just a claim no-op.
    expect(await jobs.claimNext(secondsFromNow(20))).toBeNull();
    const stillFailed = await jobs.findById(job.id);
    expect(stillFailed?.status).toBe("failed");
  });

  it("completes a vectorize job instead of failing it when the document already published before the lease ran out", async () => {
    const documentId = await insertDocument("ready");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });

    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const publisher = { enqueue: vi.fn() };
    const worker = buildWorker({ auditService, publisher });

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);
    await expect(worker.runOnce(afterLease(lastClaimedAt))).resolves.toBe(false);

    const finalJob = await jobs.findById(job.id);
    expect(finalJob?.status).toBe("completed");

    const finalDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    // Already serving retrieval at this revision — a recovery sweep catching
    // up on the job's own bookkeeping must not hide it.
    expect(finalDocumentRows[0]).toEqual({ status: "ready" });
    expect(auditService.record).not.toHaveBeenCalled();
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("skips rather than fails an exhausted vectorize job whose document moved to a newer revision", async () => {
    const documentId = await insertDocument("processing", 1);
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });
    // A newer edit landed while the stale claim was still outstanding.
    await database.query("UPDATE documents SET revision = 2 WHERE id = $1", [documentId]);

    const worker = buildWorker();

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);
    await expect(worker.runOnce(afterLease(lastClaimedAt))).resolves.toBe(false);

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({ status: "skipped", lastError: "stale_revision" });
  });

  it("leaves an already-ready document untouched when its enrich job's claim is exhausted", async () => {
    const documentId = await insertDocument("ready");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1, kind: "enrich" });

    const publisher = { enqueue: vi.fn() };
    const worker = buildWorker({ publisher });

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);
    await expect(worker.runOnce(afterLease(lastClaimedAt))).resolves.toBe(false);

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({ status: "failed", lastError: "claim_expired_attempts_exhausted" });

    const finalDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    expect(finalDocumentRows[0]).toEqual({ status: "ready" });
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("moves a real embedding-profile transition out of building when its job's claim is exhausted", async () => {
    const documentId = await insertDocument("ready", 7);
    const active = await profiles.createEmbeddingSpace({
      identityFingerprint: `claim-exhaustion-${workspaceId}-active`,
      provider: "openai",
      endpointScopeFingerprint: "claim-exhaustion-active-endpoint",
      model: "active",
      dimensions: 3,
      distanceMetric: "cosine",
      normalization: "provider",
      documentTask: "document",
      queryTask: "query",
      vectorOptions: {},
      modelVersion: null,
    });
    const pending = await profiles.createEmbeddingSpace({
      identityFingerprint: `claim-exhaustion-${workspaceId}-pending`,
      provider: "openai",
      endpointScopeFingerprint: "claim-exhaustion-pending-endpoint",
      model: "pending",
      dimensions: 4,
      distanceMetric: "cosine",
      normalization: "provider",
      documentTask: "document",
      queryTask: "query",
      vectorOptions: {},
      modelVersion: null,
    });
    await profiles.initializeWorkspaceProfile({ workspaceId, activeEmbeddingSpaceId: active.id });
    const started = await profiles.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });

    // enqueue()'s RevisionProcessingJobKind deliberately excludes
    // "embedding_profile" (it is never a plain revision job), so this kind
    // of job is inserted directly, the same way insertEmbeddingProfileJobsForDocumentRevision does.
    const embeddingProfileJobId = randomUUID();
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status,
          embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 7, 'embedding_profile', 'queued', $4, '2')`,
      [embeddingProfileJobId, documentId, workspaceId, pending.id],
    );
    const job = { id: embeddingProfileJobId };

    const coordinator = new EmbeddingTransitionCoordinator(
      profiles,
      { validateFixedInput: async () => undefined },
      { ensureTransitionWork: async () => undefined, cancelTransitionWork: async () => undefined },
      { backendKey: "pgvector" },
    );
    const embeddingProfileTerminalFailures = new EmbeddingProfileJobFailureAdapter(profiles, coordinator);
    const worker = buildWorker({ embeddingProfileTerminalFailures });

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);
    await expect(worker.runOnce(afterLease(lastClaimedAt))).resolves.toBe(false);

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({ status: "failed", lastError: "claim_expired_attempts_exhausted" });

    await expect(profiles.findWorkspaceProfile(workspaceId)).resolves.toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: pending.id,
      transition: {
        id: started.transition.id,
        status: "blocked",
        failureReason: "backfill_retry_exhausted",
      },
    });

    const finalDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    expect(finalDocumentRows[0]).toEqual({ status: "ready" });
  });

  it("releases (not fails) a job with attempts remaining through the push-worker recovery route, and runJobById reclaims it", async () => {
    const documentId = await insertDocument("processing");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });
    const claimedAt = secondsFromNow(1);
    await jobs.claimById(job.id, claimedAt);

    const worker = buildWorker({ processingService: { process: vi.fn().mockResolvedValue("completed") } });

    await expect(worker.runJobById(job.id, afterLease(claimedAt))).resolves.toBe("processed");

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({ status: "completed" });
  });

  it("does not strand the job or document when the terminal write throws once; the next sweep finishes it", async () => {
    const documentId = await insertDocument("processing");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });

    const worker = buildWorker();
    const markFailedIfDocumentMatches = vi
      .spyOn(jobs, "markFailedIfDocumentMatches")
      .mockImplementationOnce(() => {
        throw new Error("simulated crash mid terminal write");
      });

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);

    await expect(worker.runOnce(afterLease(lastClaimedAt))).rejects.toThrow("simulated crash mid terminal write");

    const strandedJob = await jobs.findById(job.id);
    expect(strandedJob?.status).toBe("processing");
    const strandedDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    expect(strandedDocumentRows[0]).toEqual({ status: "processing" });

    await expect(worker.runOnce(afterLease(strandedJob!.claimedAt!))).resolves.toBe(false);

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({ status: "failed", lastError: "claim_expired_attempts_exhausted" });
    const finalDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    expect(finalDocumentRows[0]).toEqual({ status: "failed" });
    expect(markFailedIfDocumentMatches).toHaveBeenCalledTimes(2);
  });

  it("keeps a vectorize job completed when the original run finishes between the sweep's decision and its terminal write", async () => {
    const documentId = await insertDocument("processing");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(job.id);

    const originalReleaseOrFailExpiredClaim = jobs.releaseOrFailExpiredClaim.bind(jobs);
    const releaseSpy = vi
      .spyOn(jobs, "releaseOrFailExpiredClaim")
      .mockImplementationOnce(async (releaseInput) => {
        const outcome = await originalReleaseOrFailExpiredClaim(releaseInput);
        if (outcome.outcome === "exhausted") {
          // The original run was not actually dead: it publishes the
          // document and completes the job in the window between this
          // sweep's exhausted decision (which just ran, above) and the
          // terminal write the sweep is about to make.
          await database.query("UPDATE documents SET status = 'ready' WHERE id = $1", [documentId]);
          await expect(jobs.markCompleted(job.id)).resolves.toBe(true);
        }
        return outcome;
      });

    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const worker = buildWorker({ auditService });
    await expect(worker.runOnce(afterLease(lastClaimedAt))).resolves.toBe(false);
    releaseSpy.mockRestore();

    const finalJob = await jobs.findById(job.id);
    expect(finalJob?.status).toBe("completed");
    const finalDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    expect(finalDocumentRows[0]).toEqual({ status: "ready" });
    // The sweep's terminal-failure path must never have run at all.
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it("applies the same exhausted decision at startup without letting one bad job block boot", async () => {
    const documentId = await insertDocument("processing");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });

    // Stays close to real time (unlike afterLease's multi-minute jumps):
    // start()'s own cutoff is always the real "now" at boot, not a
    // caller-supplied lease window.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claimedAt = new Date(Date.now() + 50 * attempt);
      const claimed = await jobs.claimById(job.id, claimedAt);
      expect(claimed?.attemptCount).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        const outcome = await jobs.releaseOrFailExpiredClaim({
          jobId: job.id,
          claimedAtOrBefore: new Date(claimedAt.getTime() + 1),
          maxAttempts: MAX_ATTEMPTS,
          releasedReason: "claim_expired",
          exhaustedReason: "claim_expired_attempts_exhausted",
        });
        expect(outcome).toEqual({ outcome: "released" });
      }
    }
    // Comfortably past the few hundred ms of forward inflation above, so
    // start()'s real "now" cutoff is strictly after the final claim.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const worker = buildWorker();
    await worker.start();
    await worker.stop();

    const finalJob = await jobs.findById(job.id);
    expect(finalJob).toMatchObject({ status: "failed", lastError: "claim_expired_attempts_exhausted" });
    const finalDocumentRows = await database.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );
    expect(finalDocumentRows[0]).toEqual({ status: "failed" });
  });

  it("keeps booting when startup reconciliation for one job always throws", async () => {
    const documentId = await insertDocument("processing");
    const job = await jobs.enqueue({ documentId, workspaceId, documentRevision: 1 });
    await jobs.claimById(job.id, new Date());

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.spyOn(documents, "findByIdAndWorkspaceId").mockRejectedValueOnce(new Error("db blip"));
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process: vi.fn() } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
    );

    await expect(worker.start()).resolves.toBeUndefined();
    await worker.stop();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ role: "worker", jobId: job.id, errorClass: "Error" }),
      expect.stringContaining("Startup reconciliation failed"),
    );
  });
});
