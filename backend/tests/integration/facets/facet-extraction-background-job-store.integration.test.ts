import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FacetExtractionJobRepository } from "../../../src/db/repositories/facetExtractionJobRepository.js";
import type { FacetExtractionOutcome, FacetExtractionPort } from "../../../src/modules/facets/contracts.js";
import {
  createFacetExtractionBackgroundJobRuntime,
} from "../../../src/modules/facets/composition.js";
import {
  FACET_EXTRACTION_JOB,
  FacetExtractionBackgroundJobStore,
} from "../../../src/modules/facets/infra/facetExtractionBackgroundJobStore.js";
import { Database } from "../../../src/shared/infra/database.js";
import type { TelemetryEventInput, TelemetryService } from "../../../src/shared/observability/telemetry/telemetryService.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();
const silentLogger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined };
const JOB_LEASE_MS = 300_000;

/** A `FacetExtractionPort` whose next `extract()` call is set per test, including throwing. */
const buildStubExtraction = (): { port: FacetExtractionPort; next(behavior: () => Promise<FacetExtractionOutcome>): void } => {
  let behavior: () => Promise<FacetExtractionOutcome> = () => Promise.resolve({ status: "extracted" });
  return {
    port: { extract: () => behavior() },
    next(nextBehavior) {
      behavior = nextBehavior;
    },
  };
};

const buildRecordingTelemetry = (): { telemetryService: Pick<TelemetryService, "emit">; events: TelemetryEventInput[] } => {
  const events: TelemetryEventInput[] = [];
  return {
    telemetryService: {
      emit: async (event) => {
        events.push(event);
        return null;
      },
    },
    events,
  };
};

/**
 * Exercises `FacetExtractionBackgroundJobStore` against real Postgres: the generic runtime's
 * claim/lease/complete/retry/dead-letter contract, run over the pre-existing
 * `facet_extraction_jobs` table instead of `background_jobs`.
 */
describeIntegration("FacetExtractionBackgroundJobStore (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new FacetExtractionJobRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();

  const resetWorkspace = async (): Promise<void> => {
    await database.query("DELETE FROM workspaces WHERE account_id = $1", [accountId]);
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Facet Background Job Store Workspace", `facet-bg-job-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
  };

  const createMessage = async (): Promise<string> => {
    const messageId = randomUUID();
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES ($1, $2, $3, 'user', 'facet background job test message', now())`,
      [messageId, conversationId, workspaceId],
    );
    return messageId;
  };

  const enqueueOne = async (): Promise<{ jobId: string; messageId: string }> => {
    const messageId = await createMessage();
    const { id: jobId } = await repository.enqueue({ messageId, workspaceId });
    return { jobId, messageId };
  };

  const readRow = async (jobId: string) => {
    const rows = await database.query<{
      status: string;
      message_id: string;
      workspace_id: string;
      attempt_count: number;
      claimed_at: Date | null;
      scheduled_at: Date;
      last_error: string | null;
    }>(
      `SELECT status, message_id, workspace_id, attempt_count, claimed_at, scheduled_at, last_error
       FROM facet_extraction_jobs WHERE id = $1`,
      [jobId],
    );
    return rows[0];
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Facet Background Job Store Test", `facet-bg-job-${accountId}@example.com`, "hash"],
    );
    await resetWorkspace();
  });

  beforeEach(async () => {
    await resetWorkspace();
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("claims the oldest due job and completes it, keeping its identifiers for coverage reads", async () => {
    const { jobId, messageId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);

    const claim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(claim).not.toBeNull();
    expect(claim).toMatchObject({ id: jobId, payload: { messageId, workspaceId } });

    await expect(store.complete(claim!)).resolves.toBe("deleted");

    const row = await readRow(jobId);
    expect(row.status).toBe("completed");
    expect(row.claimed_at).toBeNull();
    // Unlike the generic `background_jobs` store, completion never deletes the row or its
    // identifiers: Audience Pulse's coverage reads and `restartTerminal` backfills need them.
    expect(row.message_id).toBe(messageId);
    expect(row.workspace_id).toBe(workspaceId);
  });

  it("marks a skipped outcome with its reason instead of completed", async () => {
    const { jobId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const claim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });

    await store.complete(claim!, { skipped: "empty_message" });

    const row = await readRow(jobId);
    expect(row.status).toBe("skipped");
    expect(row.last_error).toBe("empty_message");
  });

  it("schedules a retry at the delay the runtime computed, and the job is claimable again once due", async () => {
    const { jobId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const claim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });

    const availableAt = await store.retry(claim!, { error: "Error [provider_unavailable]", delaySeconds: 0 });
    expect(availableAt).toBeInstanceOf(Date);

    const row = await readRow(jobId);
    expect(row.status).toBe("queued");
    expect(row.last_error).toBe("Error [provider_unavailable]");

    const reclaimed = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(reclaimed).toMatchObject({ id: jobId, attempt: 2 });
  });

  it("dead-letters a job terminally, keeping its identifiers unlike the generic store's dropped payload", async () => {
    const { jobId, messageId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const claim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });

    await expect(store.deadLetter(claim!, { error: "NonRetryableBackgroundJobError" })).resolves.toBe(true);

    const row = await readRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.message_id).toBe(messageId);
    expect(row.claimed_at).toBeNull();

    const reclaimAttempt = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(reclaimAttempt).toBeNull();
  });

  it("fences every write back to a claim that another worker has already taken over (attempt and claimed_at both move)", async () => {
    const { jobId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const staleClaim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });

    // Simulate a second worker reclaiming the same row after the lease lapsed: a fresh
    // `claimed_at` and attempt, exactly what `claimNext`'s own stale-claim sweep would do.
    await database.query(
      `UPDATE facet_extraction_jobs SET claimed_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`,
      [jobId],
    );

    await expect(store.complete(staleClaim!)).resolves.toBe("superseded");
    await expect(store.retry(staleClaim!, { error: "Error", delaySeconds: 10 })).resolves.toBeNull();
    await expect(store.deadLetter(staleClaim!, { error: "Error" })).resolves.toBe(false);

    const row = await readRow(jobId);
    expect(row.status).toBe("processing");
  });

  it("fences a write back to a claim whose claimed_at alone moved, attempt_count unchanged", async () => {
    const { jobId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const staleClaim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });

    // Only claimed_at moves — attempt_count stays put. The fence must still catch this: it
    // matches on both columns, not attempt_count alone.
    await database.query(`UPDATE facet_extraction_jobs SET claimed_at = now() WHERE id = $1`, [jobId]);
    const rowBefore = await readRow(jobId);
    expect(rowBefore.attempt_count).toBe(staleClaim!.attempt);

    await expect(store.complete(staleClaim!)).resolves.toBe("superseded");

    const row = await readRow(jobId);
    expect(row.status).toBe("processing");
  });

  it("returns nothing once the queue is empty", async () => {
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const claim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(claim).toBeNull();
  });

  it("excludeIds keeps a due, queued row this same drain already retried out of the next claim", async () => {
    const { jobId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const firstClaim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(firstClaim?.id).toBe(jobId);

    // Back to queued and due immediately — exactly what a same-drain retry with a 1s delay looks
    // like once that second has passed. Without excludeIds this row is claimable again.
    await store.retry(firstClaim!, { error: "Error", delaySeconds: 0 });
    expect((await readRow(jobId)).status).toBe("queued");

    const excluded = await store.claimNext({
      kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }],
      excludeIds: [jobId],
    });
    expect(excluded).toBeNull();

    const reclaimed = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(reclaimed?.id).toBe(jobId);
  });

  /**
   * The real composition factory end to end, with a stub extractor standing in for the model
   * and embedding calls `FacetExtractionService` would otherwise make. Ports the pre-existing
   * worker's permanent-failure, 429-retry, credential, and attempt-budget behaviour onto this
   * path, plus the telemetry each outcome emits.
   */
  describe("createFacetExtractionBackgroundJobRuntime (real factory, stub extractor)", () => {
    it("extracts, marks the row completed, and emits completed telemetry", async () => {
      const { jobId } = await enqueueOne();
      const extraction = buildStubExtraction();
      const { telemetryService, events } = buildRecordingTelemetry();
      const runtime = createFacetExtractionBackgroundJobRuntime({
        jobs: repository, extraction: extraction.port, logger: silentLogger, telemetryService, jobLeaseMs: JOB_LEASE_MS,
      })!;

      await runtime.drain({ maxJobs: 1 });

      expect((await readRow(jobId)).status).toBe("completed");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: "facet.extraction.job_completed", tags: { outcome: "completed" } });
      expect(events[0].metrics?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("skips, marks the row skipped with the reason, and emits skipped telemetry", async () => {
      const { jobId } = await enqueueOne();
      const extraction = buildStubExtraction();
      extraction.next(() => Promise.resolve({ status: "skipped", reason: "empty_message" }));
      const { telemetryService, events } = buildRecordingTelemetry();
      const runtime = createFacetExtractionBackgroundJobRuntime({
        jobs: repository, extraction: extraction.port, logger: silentLogger, telemetryService, jobLeaseMs: JOB_LEASE_MS,
      })!;

      await runtime.drain({ maxJobs: 1 });

      const row = await readRow(jobId);
      expect(row.status).toBe("skipped");
      expect(row.last_error).toBe("empty_message");
      expect(events[0]).toMatchObject({
        eventType: "facet.extraction.job_skipped",
        tags: { outcome: "skipped" },
        metadata: { reason: "empty_message" },
      });
    });

    it("dead-letters a permanent (credential, 401) failure immediately and tags it failed_permanent", async () => {
      const { jobId } = await enqueueOne();
      const extraction = buildStubExtraction();
      extraction.next(() => Promise.reject(Object.assign(new Error("bad key"), { status: 401 })));
      const { telemetryService, events } = buildRecordingTelemetry();
      const runtime = createFacetExtractionBackgroundJobRuntime({
        jobs: repository, extraction: extraction.port, logger: silentLogger, telemetryService, jobLeaseMs: JOB_LEASE_MS,
      })!;

      await runtime.drain({ maxJobs: 1 });

      const row = await readRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.attempt_count).toBe(1);
      expect(events[0]).toMatchObject({ eventType: "facet.extraction.job_failed", tags: { outcome: "failed_permanent" } });
    });

    it("dead-letters a permanent (400) failure immediately without spending the retry budget", async () => {
      const { jobId } = await enqueueOne();
      const extraction = buildStubExtraction();
      extraction.next(() => Promise.reject(Object.assign(new Error("invalid request"), { status: 400 })));
      const { telemetryService } = buildRecordingTelemetry();
      const runtime = createFacetExtractionBackgroundJobRuntime({
        jobs: repository, extraction: extraction.port, logger: silentLogger, telemetryService, jobLeaseMs: JOB_LEASE_MS,
      })!;

      await runtime.drain({ maxJobs: 1 });

      const row = await readRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.attempt_count).toBe(1);
    });

    it("retries a rate-limited (429) failure using the first step of the exact old schedule (1s), then succeeds", async () => {
      const { jobId } = await enqueueOne();
      const extraction = buildStubExtraction();
      extraction.next(() => Promise.reject(Object.assign(new Error("rate limited"), { status: 429 })));
      const { telemetryService, events } = buildRecordingTelemetry();
      const runtime = createFacetExtractionBackgroundJobRuntime({
        jobs: repository, extraction: extraction.port, logger: silentLogger, telemetryService, jobLeaseMs: JOB_LEASE_MS,
      })!;

      await runtime.drain({ maxJobs: 1 });

      const retriedRow = await readRow(jobId);
      expect(retriedRow.status).toBe("queued");
      expect(retriedRow.attempt_count).toBe(1);
      const scheduledInMs = retriedRow.scheduled_at.getTime() - Date.now();
      // The exact pre-existing first step (1s), not the port's doubling default.
      expect(scheduledInMs).toBeGreaterThan(0);
      expect(scheduledInMs).toBeLessThanOrEqual(1_500);
      expect(events[0]).toMatchObject({ eventType: "facet.extraction.job_failed", tags: { outcome: "retry_scheduled" } });

      extraction.next(() => Promise.resolve({ status: "extracted" }));
      await database.query(`UPDATE facet_extraction_jobs SET scheduled_at = now() WHERE id = $1`, [jobId]);
      await runtime.drain({ maxJobs: 1 });
      expect((await readRow(jobId)).status).toBe("completed");
    });

    it("dead-letters once the attempt budget is spent on an ordinary (non-permanent) failure, tagged failed (not failed_permanent)", async () => {
      const { jobId } = await enqueueOne();
      const extraction = buildStubExtraction();
      extraction.next(() => Promise.reject(new Error("still failing")));
      const { telemetryService, events } = buildRecordingTelemetry();
      const runtime = createFacetExtractionBackgroundJobRuntime({
        jobs: repository, extraction: extraction.port, logger: silentLogger, telemetryService, jobLeaseMs: JOB_LEASE_MS,
      })!;

      for (let attempt = 0; attempt < FACET_EXTRACTION_JOB.policy.maxAttempts; attempt += 1) {
        await runtime.drain({ maxJobs: 1 });
        if (attempt < FACET_EXTRACTION_JOB.policy.maxAttempts - 1) {
          await database.query(`UPDATE facet_extraction_jobs SET scheduled_at = now() WHERE id = $1`, [jobId]);
        }
      }

      const row = await readRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.attempt_count).toBe(FACET_EXTRACTION_JOB.policy.maxAttempts);
      const failureEvents = events.filter((event) => event.eventType === "facet.extraction.job_failed");
      expect(failureEvents.at(-1)).toMatchObject({ tags: { outcome: "failed" } });
    });
  });
});
