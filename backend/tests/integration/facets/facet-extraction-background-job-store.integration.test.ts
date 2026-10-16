import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { FacetExtractionJobRepository } from "../../../src/db/repositories/facetExtractionJobRepository.js";
import {
  FACET_EXTRACTION_JOB,
  FacetExtractionBackgroundJobStore,
} from "../../../src/modules/facets/infra/facetExtractionBackgroundJobStore.js";
import { Database } from "../../../src/shared/infra/database.js";
import {
  backgroundJobHandler,
  BackgroundJobRuntime,
  NonRetryableBackgroundJobError,
} from "../../../src/shared/background-jobs/index.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();
const silentLogger = { debug: () => undefined, warn: () => undefined, error: () => undefined };

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

    store.recordOutcome(claim!.id, { status: "extracted" });
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

    store.recordOutcome(claim!.id, { status: "skipped", reason: "empty_message" });
    await store.complete(claim!);

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

  it("fences every write back to a claim that another worker has already taken over", async () => {
    const { jobId } = await enqueueOne();
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const staleClaim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });

    // Simulate a second worker reclaiming the same row after the lease lapsed: a fresh
    // `claimed_at` and attempt, exactly what `claimNext`'s own stale-claim sweep would do.
    await database.query(
      `UPDATE facet_extraction_jobs SET claimed_at = now(), attempt_count = attempt_count + 1 WHERE id = $1`,
      [jobId],
    );

    store.recordOutcome(staleClaim!.id, { status: "extracted" });
    await expect(store.complete(staleClaim!)).resolves.toBe("superseded");
    await expect(store.retry(staleClaim!, { error: "Error", delaySeconds: 10 })).resolves.toBeNull();
    await expect(store.deadLetter(staleClaim!, { error: "Error" })).resolves.toBe(false);

    const row = await readRow(jobId);
    expect(row.status).toBe("processing");
  });

  it("runs end to end through the real BackgroundJobRuntime: success, a retried failure, then a dead letter", async () => {
    const store = new FacetExtractionBackgroundJobStore(repository, FACET_EXTRACTION_JOB.policy.maxAttempts);
    let behavior: "succeed" | "retryable" | "permanent" = "succeed";
    const handler = backgroundJobHandler(FACET_EXTRACTION_JOB, async (_payload, context) => {
      if (behavior === "succeed") {
        store.recordOutcome(context.jobId, { status: "extracted" });
        return;
      }
      if (behavior === "permanent") {
        throw new NonRetryableBackgroundJobError("permanent failure");
      }
      throw new Error("transient failure");
    });
    const runtime = new BackgroundJobRuntime({ store, handlers: [handler], logger: silentLogger });

    const succeeded = await enqueueOne();
    const retried = await enqueueOne();
    const deadLettered = await enqueueOne();

    behavior = "succeed";
    await runtime.drain({ maxJobs: 1 });
    expect((await readRow(succeeded.jobId)).status).toBe("completed");

    behavior = "retryable";
    await runtime.drain({ maxJobs: 1 });
    const retriedRow = await readRow(retried.jobId);
    expect(retriedRow.status).toBe("queued");
    expect(retriedRow.attempt_count).toBe(1);

    behavior = "permanent";
    await runtime.drain({ maxJobs: 1 });
    expect((await readRow(deadLettered.jobId)).status).toBe("failed");
  });

  it("returns nothing once the queue is empty", async () => {
    const store = new FacetExtractionBackgroundJobStore(repository, 3);
    const claim = await store.claimNext({ kinds: [{ kind: FACET_EXTRACTION_JOB.kind, leaseSeconds: 300 }] });
    expect(claim).toBeNull();
  });
});
