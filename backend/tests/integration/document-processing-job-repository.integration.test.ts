import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("DocumentProcessingJobRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new DocumentProcessingJobRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Processing Job Test Co", `job-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Processing Job Workspace", `job-route-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertDocument = async (revision = 1): Promise<string> => {
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, $3, $4, $4, 'queued', $5, '{}'::jsonb)`,
      [documentId, workspaceId, "Queued Document", "Queued content", revision],
    );
    return documentId;
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
});
