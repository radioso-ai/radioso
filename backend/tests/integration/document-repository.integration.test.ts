import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import type { DocumentCreateInput } from "../../src/modules/documents/contracts/index.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of DocumentRepository. The unit/service tests use fakes,
// so this is the only coverage that exercises the actual SQL (now Kysely). Behaviour here —
// ON CONFLICT targets, COALESCE-merge updates, NOW() clock writes, jsonb round-trips,
// cursor/offset pagination, conflict error mapping, and transaction atomicity — is the spec
// the Kysely migration must preserve byte-for-byte.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("DocumentRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new DocumentRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Document Repo Test Co", `doc-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Document Repo Workspace", `doc-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, external_id, config, metadata)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb)`,
      [sourceId, workspaceId, "website", "Docs Site", "site-ext-1"],
    );
  });

  afterEach(async () => {
    // documents → document_processing_jobs cascade on delete.
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    // ON DELETE CASCADE on accounts removes workspace, sources, documents, jobs.
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const baseCreateInput = (overrides: Partial<DocumentCreateInput> = {}): DocumentCreateInput => ({
    workspaceId,
    title: "Title",
    sourceContent: "source body",
    markdownContent: "# markdown",
    metadata: { tag: "alpha" },
    ...overrides,
  });

  const countProcessingJobs = async (documentId: string): Promise<number> => {
    const [row] = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM document_processing_jobs WHERE document_id = $1`,
      [documentId],
    );
    return Number(row?.count ?? "0");
  };

  it("createAndQueue inserts a queued document, enqueues a processing job, and round-trips jsonb metadata", async () => {
    const document = await repository.createAndQueue(
      baseCreateInput({ metadata: { tag: "alpha", nested: { count: 2 } } }),
    );

    expect(document.id).toMatch(/[0-9a-f-]{36}/);
    expect(document.workspaceId).toBe(workspaceId);
    expect(document.status).toBe("queued");
    expect(document.revision).toBe(1);
    expect(document.sourceKind).toBe("inline_text");
    expect(document.metadata).toEqual({ tag: "alpha", nested: { count: 2 } });
    expect(document.createdAt).toBeInstanceOf(Date);
    expect(document.updatedAt).toBeInstanceOf(Date);
    expect(await countProcessingJobs(document.id)).toBe(1);
  });

  it("createAndQueue defaults metadata to {} and source kind to inline_text", async () => {
    const document = await repository.createAndQueue({
      workspaceId,
      title: "No metadata",
      sourceContent: "x",
      markdownContent: "x",
    });

    expect(document.metadata).toEqual({});
    expect(document.sourceKind).toBe("inline_text");
  });

  it("createAndQueue upserts on (workspace_id, external_document_id) for manual documents and bumps revision", async () => {
    const first = await repository.createAndQueue(
      baseCreateInput({ externalDocumentId: "ext-manual-1", title: "First", metadata: { v: 1 } }),
    );
    expect(first.revision).toBe(1);

    const second = await repository.createAndQueue(
      baseCreateInput({ externalDocumentId: "ext-manual-1", title: "Second", metadata: { v: 2 } }),
    );

    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.title).toBe("Second");
    expect(second.metadata).toEqual({ v: 2 });
    // Both the insert and the upsert enqueue a job.
    expect(await countProcessingJobs(first.id)).toBe(2);
  });

  it("createAndQueue upserts on (workspace_id, source_id, external_document_id) for sourced documents", async () => {
    const first = await repository.createAndQueue(
      baseCreateInput({ sourceId, externalDocumentId: "ext-sourced-1", title: "Page v1" }),
    );
    const second = await repository.createAndQueue(
      baseCreateInput({ sourceId, externalDocumentId: "ext-sourced-1", title: "Page v2" }),
    );

    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.title).toBe("Page v2");
    expect(second.source?.id).toBe(sourceId);
    expect(second.source?.externalId).toBe("site-ext-1");
  });

  it("createAndQueue throws conflict when the upsert WHERE guard (matching source_kind) excludes the row", async () => {
    await repository.createAndQueue(
      baseCreateInput({ externalDocumentId: "ext-kind-1", sourceKind: "inline_text" }),
    );

    // A differing source_kind makes the DO UPDATE ... WHERE predicate false, so RETURNING is
    // empty and the repository maps that to a conflict.
    await expect(
      repository.createAndQueue(
        baseCreateInput({ externalDocumentId: "ext-kind-1", sourceKind: "uploaded_file" }),
      ),
    ).rejects.toMatchObject({ message: "Imported documents cannot be updated through the inline document API" });
  });

  it("create inserts with the provided status and does not enqueue a job", async () => {
    const document = await repository.create({ ...baseCreateInput(), status: "ready" });

    expect(document.status).toBe("ready");
    expect(document.revision).toBe(1);
    expect(await countProcessingJobs(document.id)).toBe(0);
  });

  it("findByIdAndWorkspaceId and findByExternalDocumentId resolve documents and the source summary", async () => {
    const created = await repository.createAndQueue(
      baseCreateInput({ sourceId, externalDocumentId: "ext-find-1" }),
    );

    const byId = await repository.findByIdAndWorkspaceId(created.id, workspaceId);
    expect(byId?.id).toBe(created.id);
    expect(byId?.source).toEqual({ id: sourceId, kind: "website", name: "Docs Site", externalId: "site-ext-1" });

    const byExternal = await repository.findByExternalDocumentId(workspaceId, "ext-find-1");
    expect(byExternal?.id).toBe(created.id);

    expect(await repository.findByIdAndWorkspaceId(randomUUID(), workspaceId)).toBeNull();
    expect(await repository.findByExternalDocumentId(workspaceId, "missing")).toBeNull();
  });

  it("summarizeWorkspace counts statuses and aggregates sample document slugs", async () => {
    await repository.create({ ...baseCreateInput(), status: "ready" });
    await repository.create({ ...baseCreateInput(), status: "queued" });
    await repository.create({ ...baseCreateInput(), status: "processing" });
    await repository.create({
      ...baseCreateInput({ metadata: { sampleDocument: "true", sampleSlug: "welcome" } }),
      status: "ready",
    });

    const summary = await repository.summarizeWorkspace(workspaceId);

    expect(summary.documentCount).toBe(4);
    expect(summary.readyDocumentCount).toBe(2);
    expect(summary.pendingDocumentCount).toBe(2);
    expect(summary.sampleDocumentCount).toBe(1);
    expect(summary.sampleDocumentSlugs).toEqual(["welcome"]);
  });

  it("summarizeWorkspace returns zeros and an empty slug array for an empty workspace", async () => {
    const summary = await repository.summarizeWorkspace(workspaceId);
    expect(summary).toEqual({
      documentCount: 0,
      readyDocumentCount: 0,
      pendingDocumentCount: 0,
      sampleDocumentCount: 0,
      sampleDocumentSlugs: [],
    });
  });

  it("listByWorkspaceId returns documents ordered by created_at descending", async () => {
    const first = await repository.create({ ...baseCreateInput({ title: "A" }), status: "ready" });
    const second = await repository.create({ ...baseCreateInput({ title: "B" }), status: "ready" });
    const third = await repository.create({ ...baseCreateInput({ title: "C" }), status: "ready" });

    const all = await repository.listByWorkspaceId(workspaceId);
    const ids = all.map((d) => d.id);

    // created_at DESC — most recent first.
    expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(second.id));
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it("listSummariesByIdsAndWorkspaceId filters by id set and short-circuits on empty input", async () => {
    const a = await repository.create({ ...baseCreateInput(), status: "ready" });
    const b = await repository.create({ ...baseCreateInput(), status: "ready" });
    await repository.create({ ...baseCreateInput(), status: "ready" });

    const summaries = await repository.listSummariesByIdsAndWorkspaceId(workspaceId, [a.id, b.id]);
    expect(summaries.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

    expect(await repository.listSummariesByIdsAndWorkspaceId(workspaceId, [])).toEqual([]);
  });

  it("listSummaryPageByWorkspaceId paginates by offset and exposes total/hasMore", async () => {
    for (let index = 0; index < 3; index += 1) {
      await repository.create({ ...baseCreateInput({ title: `Doc ${index}` }), status: "ready" });
    }

    const firstPage = await repository.listSummaryPageByWorkspaceId(workspaceId, { limit: 2 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.documents).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const cursorPage = await repository.listSummaryPageByWorkspaceId(workspaceId, {
      limit: 2,
      cursor: firstPage.nextCursor as string,
    });
    expect(cursorPage.documents).toHaveLength(1);
    expect(cursorPage.hasMore).toBe(false);
    expect(cursorPage.nextCursor).toBeNull();

    const offsetPage = await repository.listSummaryPageByWorkspaceId(workspaceId, { limit: 2, offset: 2 });
    expect(offsetPage.documents).toHaveLength(1);
  });

  it("summary content_size falls back to OCTET_LENGTH(source_content) when no byte counts are set", async () => {
    const created = await repository.create({
      ...baseCreateInput({ sourceContent: "hello" }),
      status: "ready",
    });

    const [summary] = await repository.listSummariesByIdsAndWorkspaceId(workspaceId, [created.id]);
    expect(summary.contentSize).toBe("hello".length);
  });

  it("update merges fields with COALESCE, bumps revision, clears failure, and updates the clock", async () => {
    const created = await repository.create({
      ...baseCreateInput({ metadata: { keep: "me", externalDocumentId: undefined } }),
      status: "failed",
    });
    const before = await repository.findByIdAndWorkspaceId(created.id, workspaceId);

    const updated = await repository.update({
      documentId: created.id,
      workspaceId,
      title: "Updated title",
      sourceContent: "new source",
      markdownContent: "new markdown",
      status: "ready",
      // metadata omitted -> preserved via COALESCE
    });

    expect(updated.title).toBe("Updated title");
    expect(updated.status).toBe("ready");
    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.failureReason).toBeNull();
    expect(updated.metadata).toEqual({ keep: "me" });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it("update replaces metadata when provided", async () => {
    const created = await repository.create({ ...baseCreateInput({ metadata: { a: 1 } }), status: "ready" });

    const updated = await repository.update({
      documentId: created.id,
      workspaceId,
      title: created.title,
      sourceContent: created.sourceContent,
      markdownContent: created.markdownContent,
      status: "ready",
      metadata: { b: 2 },
    });

    expect(updated.metadata).toEqual({ b: 2 });
  });

  it("update maps the unique-violation on external_document_id to a conflict", async () => {
    await repository.createAndQueue(baseCreateInput({ externalDocumentId: "taken-1" }));
    const other = await repository.create({ ...baseCreateInput({ externalDocumentId: null }), status: "ready" });

    await expect(
      repository.update({
        documentId: other.id,
        workspaceId,
        title: other.title,
        sourceContent: other.sourceContent,
        markdownContent: other.markdownContent,
        status: "ready",
        externalDocumentId: "taken-1",
      }),
    ).rejects.toMatchObject({
      message: "externalDocumentId is already used by another document in this workspace",
    });
  });

  it("updateAndQueue updates, enqueues a job, returns notFound for a missing document", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "failed" });

    const updated = await repository.updateAndQueue({
      documentId: created.id,
      workspaceId,
      title: "Requeued",
      sourceContent: "s",
      markdownContent: "m",
    });

    expect(updated.status).toBe("queued");
    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.failureReason).toBeNull();
    expect(await countProcessingJobs(created.id)).toBe(1);

    await expect(
      repository.updateAndQueue({
        documentId: randomUUID(),
        workspaceId,
        title: "x",
        sourceContent: "x",
        markdownContent: "x",
      }),
    ).rejects.toMatchObject({ message: "Document not found" });
  });

  it("updateDerivedContentForRevision only updates when the revision matches", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "ready" });

    const matched = await repository.updateDerivedContentForRevision({
      documentId: created.id,
      workspaceId,
      revision: created.revision,
      sourceContent: "derived source",
      markdownContent: "derived markdown",
    });
    expect(matched?.sourceContent).toBe("derived source");
    expect(matched?.markdownContent).toBe("derived markdown");
    // Does not bump revision or change status.
    expect(matched?.revision).toBe(created.revision);
    expect(matched?.status).toBe("ready");

    const mismatch = await repository.updateDerivedContentForRevision({
      documentId: created.id,
      workspaceId,
      revision: created.revision + 99,
      sourceContent: "ignored",
      markdownContent: "ignored",
    });
    expect(mismatch).toBeNull();
  });

  it("requeue resets to queued and bumps revision", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "failed" });

    const requeued = await repository.requeue(created.id, workspaceId);

    expect(requeued.status).toBe("queued");
    expect(requeued.revision).toBe(created.revision + 1);
    expect(requeued.failureReason).toBeNull();
    // requeue (no Queue) does not enqueue a job.
    expect(await countProcessingJobs(created.id)).toBe(0);
  });

  it("requeueAndQueue resets, enqueues a job, and returns notFound for a missing document", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "failed" });

    const requeued = await repository.requeueAndQueue(created.id, workspaceId);
    expect(requeued.status).toBe("queued");
    expect(await countProcessingJobs(created.id)).toBe(1);

    await expect(repository.requeueAndQueue(randomUUID(), workspaceId)).rejects.toMatchObject({
      message: "Document not found",
    });
  });

  it("requeueAllEligibleAndQueue requeues only non-queued/non-processing documents and reports skipped counts", async () => {
    const ready = await repository.create({ ...baseCreateInput(), status: "ready" });
    const failed = await repository.create({ ...baseCreateInput(), status: "failed" });
    await repository.create({ ...baseCreateInput(), status: "queued" });
    await repository.create({ ...baseCreateInput(), status: "processing" });

    const result = await repository.requeueAllEligibleAndQueue(workspaceId);

    expect(result.queuedDocumentCount).toBe(2);
    expect(result.skippedDocumentCount).toBe(2);
    expect(result.queuedDocuments.map((d) => d.documentId).sort()).toEqual([ready.id, failed.id].sort());
    for (const queued of result.queuedDocuments) {
      expect(queued.revision).toBe(2);
      expect(await countProcessingJobs(queued.documentId)).toBe(1);
    }
  });

  it("setStatus sets failed_at and failure_reason only for the failed status", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "queued" });

    const failed = await repository.setStatus({
      documentId: created.id,
      workspaceId,
      status: "failed",
      failureReason: "boom",
    });
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("boom");

    const ready = await repository.setStatus({
      documentId: created.id,
      workspaceId,
      status: "ready",
      failureReason: "ignored",
    });
    expect(ready.status).toBe("ready");
    expect(ready.failureReason).toBeNull();
  });

  it("setStatusIfRevisionMatches only updates on a matching revision", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "queued" });

    const matched = await repository.setStatusIfRevisionMatches({
      documentId: created.id,
      workspaceId,
      revision: created.revision,
      status: "ready",
    });
    expect(matched?.status).toBe("ready");

    const mismatch = await repository.setStatusIfRevisionMatches({
      documentId: created.id,
      workspaceId,
      revision: created.revision + 99,
      status: "failed",
      failureReason: "no",
    });
    expect(mismatch).toBeNull();
  });

  it("deleteByIdAndWorkspaceId returns true when a row is removed and false otherwise", async () => {
    const created = await repository.create({ ...baseCreateInput(), status: "ready" });

    expect(await repository.deleteByIdAndWorkspaceId(created.id, workspaceId)).toBe(true);
    expect(await repository.deleteByIdAndWorkspaceId(created.id, workspaceId)).toBe(false);
  });

  it("listSummaryPageBySourceId scopes by source and by the manual (null source) bucket", async () => {
    const sourced = await repository.createAndQueue(
      baseCreateInput({ sourceId, externalDocumentId: "scoped-1" }),
    );
    const manual = await repository.create({ ...baseCreateInput({ sourceId: null }), status: "ready" });

    const bySource = await repository.listSummaryPageBySourceId(workspaceId, sourceId, { limit: 10 });
    expect(bySource.documents.map((d) => d.id)).toContain(sourced.id);
    expect(bySource.documents.map((d) => d.id)).not.toContain(manual.id);

    const byNull = await repository.listSummaryPageBySourceId(workspaceId, null, { limit: 10 });
    expect(byNull.documents.map((d) => d.id)).toContain(manual.id);
    expect(byNull.documents.map((d) => d.id)).not.toContain(sourced.id);
  });

  it("listSummaryPageBySourceId paginates with a cursor", async () => {
    for (let index = 0; index < 3; index += 1) {
      await repository.createAndQueue(baseCreateInput({ sourceId, externalDocumentId: `page-${index}` }));
    }

    const firstPage = await repository.listSummaryPageBySourceId(workspaceId, sourceId, { limit: 2 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const nextPage = await repository.listSummaryPageBySourceId(workspaceId, sourceId, {
      limit: 2,
      cursor: firstPage.nextCursor as string,
    });
    expect(nextPage.documents).toHaveLength(1);
    expect(nextPage.hasMore).toBe(false);
  });

  it("deleteBySourceIdAndWorkspaceId deletes by source and returns storage refs for uploaded files only", async () => {
    await repository.create({
      ...baseCreateInput({
        sourceId,
        externalDocumentId: "del-1",
        sourceKind: "uploaded_file",
        sourceStorageBucket: "bucket-a",
        sourceStorageObject: "path/a.pdf",
        sourceStorageGeneration: "gen-1",
      }),
      status: "ready",
    });
    await repository.create({
      ...baseCreateInput({ sourceId, externalDocumentId: "del-2", sourceKind: "inline_text" }),
      status: "ready",
    });

    const result = await repository.deleteBySourceIdAndWorkspaceId(sourceId, workspaceId);

    expect(result.count).toBe(2);
    expect(result.storageRefs).toEqual([
      { bucket: "bucket-a", objectPath: "path/a.pdf", generation: "gen-1" },
    ]);
  });

  it("findActivePageState returns the active page state and ignores failed documents", async () => {
    const created = await repository.create({
      ...baseCreateInput({
        sourceId,
        externalDocumentId: "active-1",
        contentSizeBytes: 4096,
        contentHash: "hash-abc",
      }),
      status: "ready",
    });

    const state = await repository.findActivePageState({
      workspaceId,
      sourceId,
      externalDocumentId: "active-1",
    });
    expect(state).toEqual({
      documentId: created.id,
      revision: created.revision,
      contentSizeBytes: 4096,
      contentHash: "hash-abc",
    });

    await repository.setStatus({ documentId: created.id, workspaceId, status: "failed", failureReason: "x" });
    expect(
      await repository.findActivePageState({ workspaceId, sourceId, externalDocumentId: "active-1" }),
    ).toBeNull();
  });

  it("findActivePageState scopes the manual bucket with source_id IS NULL", async () => {
    const created = await repository.create({
      ...baseCreateInput({ sourceId: null, externalDocumentId: "manual-active-1" }),
      status: "ready",
    });

    const state = await repository.findActivePageState({
      workspaceId,
      sourceId: null,
      externalDocumentId: "manual-active-1",
    });
    expect(state?.documentId).toBe(created.id);
  });

  it("deleteMissingPagesBySourceAndExternalIds deletes pages not in the keep set and sums freed bytes", async () => {
    const keep = await repository.create({
      ...baseCreateInput({ sourceId, externalDocumentId: "keep-1", contentSizeBytes: 100 }),
      status: "ready",
    });
    await repository.create({
      ...baseCreateInput({ sourceId, externalDocumentId: "drop-1", contentSizeBytes: 200 }),
      status: "ready",
    });
    await repository.create({
      ...baseCreateInput({ sourceId, externalDocumentId: "drop-2", contentSizeBytes: 300 }),
      status: "ready",
    });

    const result = await repository.deleteMissingPagesBySourceAndExternalIds({
      workspaceId,
      sourceId,
      keepExternalDocumentIds: ["keep-1"],
    });

    expect(result.deletedCount).toBe(2);
    expect(result.deletedContentBytes).toBe(500);
    expect(await repository.findByIdAndWorkspaceId(keep.id, workspaceId)).not.toBeNull();
  });

  it("deleteMissingPagesBySourceAndExternalIds deletes all sourced pages when the keep set is empty", async () => {
    await repository.create({
      ...baseCreateInput({ sourceId, externalDocumentId: "all-1", contentSizeBytes: 10 }),
      status: "ready",
    });
    await repository.create({
      ...baseCreateInput({ sourceId, externalDocumentId: "all-2", contentSizeBytes: 20 }),
      status: "ready",
    });

    const result = await repository.deleteMissingPagesBySourceAndExternalIds({
      workspaceId,
      sourceId,
      keepExternalDocumentIds: [],
    });

    expect(result.deletedCount).toBe(2);
    expect(result.deletedContentBytes).toBe(30);
  });
});
