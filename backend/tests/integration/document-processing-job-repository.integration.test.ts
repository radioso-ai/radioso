import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("DocumentProcessingJobRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new DocumentProcessingJobRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Processing Job Test Co", `job-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Processing Job Workspace", `job-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [otherWorkspaceId, accountId, "Other Processing Job Workspace", `job-route-${otherWorkspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = ANY($1::uuid[])", [[workspaceId, otherWorkspaceId]]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertDocument = async (
    revision = 1,
    targetWorkspaceId = workspaceId,
    status: "queued" | "ready" | "failed" = "queued",
  ): Promise<string> => {
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, $3, $4, $4, $5, $6, '{}'::jsonb)`,
      [documentId, targetWorkspaceId, "Queued Document", "Queued content", status, revision],
    );
    return documentId;
  };

  const insertFailedJob = async (input: {
    documentId: string;
    workspaceId?: string;
    revision?: number;
    kind?: "vectorize" | "enrich";
    errorCode?: string;
  }): Promise<string> => {
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status, last_error, last_error_code, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'failed', 'provider unavailable', $6, now())`,
      [
        jobId,
        input.documentId,
        input.workspaceId ?? workspaceId,
        input.revision ?? 1,
        input.kind ?? "vectorize",
        input.errorCode ?? "provider_misconfigured",
      ],
    );
    return jobId;
  };

  it("persists processing job options through lookup and claim paths", async () => {
    const documentId = await insertDocument();

    const enqueued = await repository.enqueue({
      documentId,
      workspaceId,
      documentRevision: 1,
      options: { documentEnrichmentOverride: "on" },
    });

    expect(enqueued.options).toEqual({ documentEnrichmentOverride: "on" });
    expect((await repository.findById(enqueued.id))?.options).toEqual({ documentEnrichmentOverride: "on" });
    expect(
      (await repository.findByDocumentRevision({ documentId, workspaceId, documentRevision: 1 }))?.options,
    ).toEqual({ documentEnrichmentOverride: "on" });

    const claimed = await repository.claimById(enqueued.id, new Date(Date.now() + 60_000));
    expect(claimed?.options).toEqual({ documentEnrichmentOverride: "on" });
  });

  it("preserves processing job options when rescheduled or released after timeout", async () => {
    const documentId = await insertDocument();
    const job = await repository.enqueue({
      documentId,
      workspaceId,
      documentRevision: 1,
      options: { documentEnrichmentOverride: "off" },
    });

    await repository.reschedule(job.id, new Date("2026-07-03T00:00:00.000Z"), "retry later");
    expect((await repository.findById(job.id))?.options).toEqual({ documentEnrichmentOverride: "off" });

    const claimed = await repository.claimById(job.id, new Date("2026-07-04T00:00:00.000Z"));
    expect(claimed?.options).toEqual({ documentEnrichmentOverride: "off" });

    const released = await repository.releaseTimedOutClaim(
      job.id,
      new Date("2026-07-04T00:00:00.000Z"),
      "timed out",
    );

    expect(released).toBe(true);
    expect((await repository.findById(job.id))?.options).toEqual({ documentEnrichmentOverride: "off" });
  });

  it("defaults job kind to vectorize and persists an explicit enrich kind", async () => {
    const vectorizeDocumentId = await insertDocument();
    const enrichDocumentId = await insertDocument();

    const vectorizeJob = await repository.enqueue({
      documentId: vectorizeDocumentId,
      workspaceId,
      documentRevision: 1,
    });
    const enrichJob = await repository.enqueue({
      documentId: enrichDocumentId,
      workspaceId,
      documentRevision: 1,
      kind: "enrich",
    });

    expect(vectorizeJob.kind).toBe("vectorize");
    expect(enrichJob.kind).toBe("enrich");
    expect((await repository.findById(enrichJob.id))?.kind).toBe("enrich");
  });

  it("claims vectorize jobs before enrich jobs even when the enrich job was queued first", async () => {
    const enrichDocumentId = await insertDocument();
    const vectorizeDocumentId = await insertDocument();

    // Enqueue the enrich job first so a naive created_at ordering would claim it first.
    const enrichJob = await repository.enqueue({
      documentId: enrichDocumentId,
      workspaceId,
      documentRevision: 1,
      kind: "enrich",
    });
    const vectorizeJob = await repository.enqueue({
      documentId: vectorizeDocumentId,
      workspaceId,
      documentRevision: 1,
      kind: "vectorize",
    });

    const claimFirst = await repository.claimNext(new Date(Date.now() + 60_000));
    expect(claimFirst?.id).toBe(vectorizeJob.id);

    const claimSecond = await repository.claimNext(new Date(Date.now() + 60_000));
    expect(claimSecond?.id).toBe(enrichJob.id);
  });

  it("allows a vectorize and an enrich job to coexist for the same document revision", async () => {
    const documentId = await insertDocument();

    const vectorizeJob = await repository.enqueue({ documentId, workspaceId, documentRevision: 1 });
    const enrichJob = await repository.enqueue({ documentId, workspaceId, documentRevision: 1, kind: "enrich" });

    expect(vectorizeJob.id).not.toBe(enrichJob.id);
    expect(vectorizeJob.kind).toBe("vectorize");
    expect(enrichJob.kind).toBe("enrich");
  });

  it("ensureEnrichJob is idempotent for a revision and never violates the unique constraint", async () => {
    const documentId = await insertDocument();

    const first = await repository.ensureEnrichJob({
      documentId,
      workspaceId,
      documentRevision: 1,
      options: { documentEnrichmentOverride: "on" },
    });
    // A vectorize retry re-runs the follow-up creation; it must return the same
    // row rather than throwing on (document_id, document_revision, kind='enrich').
    const second = await repository.ensureEnrichJob({ documentId, workspaceId, documentRevision: 1 });

    expect(first.kind).toBe("enrich");
    expect(second.id).toBe(first.id);
    expect(second.options).toEqual({ documentEnrichmentOverride: "on" });
  });

  it("maps missing and unrecognized options to null", async () => {
    const documentWithoutOptions = await insertDocument();
    const documentWithUnknownOptions = await insertDocument();

    const noOptions = await repository.enqueue({
      documentId: documentWithoutOptions,
      workspaceId,
      documentRevision: 1,
    });
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, status, options)
       VALUES ($1, $2, $3, 1, 'queued', $4::jsonb)`,
      [randomUUID(), documentWithUnknownOptions, workspaceId, JSON.stringify({ documentEnrichmentOverride: "inherit" })],
    );

    expect((await repository.findById(noOptions.id))?.options).toBeNull();
    expect(
      (await repository.findByDocumentRevision({
        documentId: documentWithUnknownOptions,
        workspaceId,
        documentRevision: 1,
      }))?.options,
    ).toBeNull();
  });

  it("requeues credential failures in bounded batches and is idempotent once drained", async () => {
    const documentIds = await Promise.all([
      insertDocument(1, workspaceId, "failed"),
      insertDocument(1, workspaceId, "failed"),
      insertDocument(1, workspaceId, "failed"),
    ]);
    await Promise.all(documentIds.map((documentId) => insertFailedJob({ documentId })));

    await expect(repository.requeueProviderCredentialFailures(workspaceId, 2)).resolves.toBe(2);
    const afterFirstBatch = await database.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM document_processing_jobs
       WHERE workspace_id = $1
       GROUP BY status`,
      [workspaceId],
    );
    expect(Object.fromEntries(afterFirstBatch.map((row) => [row.status, Number(row.count)]))).toEqual({
      failed: 1,
      queued: 2,
    });

    await expect(repository.requeueProviderCredentialFailures(workspaceId, 2)).resolves.toBe(1);
    await expect(repository.requeueProviderCredentialFailures(workspaceId, 2)).resolves.toBe(0);
    const documents = await database.query<{ status: string }>(
      `SELECT status FROM documents WHERE id = ANY($1::uuid[])`,
      [documentIds],
    );
    expect(documents).toHaveLength(3);
    expect(documents.every((row) => row.status === "queued")).toBe(true);
  });

  it("ignores stale revisions and credential failures from another workspace", async () => {
    const currentDocumentId = await insertDocument(1, workspaceId, "failed");
    const staleDocumentId = await insertDocument(2, workspaceId, "failed");
    const otherDocumentId = await insertDocument(1, otherWorkspaceId, "failed");
    const currentJobId = await insertFailedJob({ documentId: currentDocumentId });
    const staleJobId = await insertFailedJob({ documentId: staleDocumentId, revision: 1 });
    const otherJobId = await insertFailedJob({ documentId: otherDocumentId, workspaceId: otherWorkspaceId });

    await expect(repository.requeueProviderCredentialFailures(workspaceId, 100)).resolves.toBe(1);

    const jobs = await database.query<{ id: string; status: string }>(
      `SELECT id, status FROM document_processing_jobs WHERE id = ANY($1::uuid[])`,
      [[currentJobId, staleJobId, otherJobId]],
    );
    expect(Object.fromEntries(jobs.map((row) => [row.id, row.status]))).toEqual({
      [currentJobId]: "queued",
      [staleJobId]: "failed",
      [otherJobId]: "failed",
    });
    const untouchedDocuments = await database.query<{ id: string; status: string }>(
      `SELECT id, status FROM documents WHERE id = ANY($1::uuid[])`,
      [[staleDocumentId, otherDocumentId]],
    );
    expect(Object.fromEntries(untouchedDocuments.map((row) => [row.id, row.status]))).toEqual({
      [staleDocumentId]: "failed",
      [otherDocumentId]: "failed",
    });
  });

  it("matches the stored provider failure code instead of error message text", async () => {
    const credentialDocumentId = await insertDocument(1, workspaceId, "failed");
    const transientDocumentId = await insertDocument(1, workspaceId, "failed");
    const credentialJobId = await insertFailedJob({ documentId: credentialDocumentId });
    const transientJobId = await insertFailedJob({
      documentId: transientDocumentId,
      errorCode: "provider_transient",
    });

    await expect(repository.requeueProviderCredentialFailures(workspaceId, 100)).resolves.toBe(1);

    const jobs = await database.query<{ id: string; status: string }>(
      `SELECT id, status FROM document_processing_jobs WHERE id = ANY($1::uuid[])`,
      [[credentialJobId, transientJobId]],
    );
    expect(Object.fromEntries(jobs.map((row) => [row.id, row.status]))).toEqual({
      [credentialJobId]: "queued",
      [transientJobId]: "failed",
    });
  });

  it("restores document state only for current-revision vectorize jobs", async () => {
    const vectorizeDocumentId = await insertDocument(1, workspaceId, "failed");
    const enrichDocumentId = await insertDocument(1, workspaceId, "ready");
    await insertFailedJob({ documentId: vectorizeDocumentId, kind: "vectorize" });
    await insertFailedJob({ documentId: enrichDocumentId, kind: "enrich" });

    await expect(repository.requeueProviderCredentialFailures(workspaceId, 100)).resolves.toBe(2);

    const documents = await database.query<{ id: string; status: string }>(
      `SELECT id, status FROM documents WHERE id = ANY($1::uuid[])`,
      [[vectorizeDocumentId, enrichDocumentId]],
    );
    expect(Object.fromEntries(documents.map((row) => [row.id, row.status]))).toEqual({
      [vectorizeDocumentId]: "queued",
      [enrichDocumentId]: "ready",
    });
  });
});
