import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Coverage reconciliation runs only when a document is ingested, so a workspace that
// has not ingested since canonical embeddings shipped can have retrievable chunks with
// no active canonical projection. This query is how an operator sees that backlog
// before running the one-time backfill.

describeIntegration("canonical embedding coverage gaps (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new DocumentProcessingJobRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const spaceId = randomUUID();
  const staleSpaceId = randomUUID();
  let documentId: string;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Coverage Gap Co", `gap-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Coverage Gap Workspace", `gap-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces
         (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
       VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', 1536, 'cosine', 'none', 'active')`,
      [spaceId, `gap-fp-${spaceId}`, `gap-scope-${spaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces
         (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
       VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', 1536, 'cosine', 'none', 'active')`,
      [staleSpaceId, `gap-fp-${staleSpaceId}`, `gap-scope-${staleSpaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Doc', 'content', 'content', 'ready', 1, '{}'::jsonb)`,
      [documentId, workspaceId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM chunk_embeddings WHERE workspace_id = $1", [workspaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM embedding_spaces WHERE id = ANY($1)", [[spaceId, staleSpaceId]])
      .catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertChunk = async (chunkIndex: number): Promise<string> => {
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, $4, 'chunk text', 'chunk text', 0, 10, '{}'::jsonb)`,
      [chunkId, documentId, workspaceId, chunkIndex],
    );
    return chunkId;
  };

  const gapFor = async (): Promise<number> => {
    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    return gaps.find((gap) => gap.workspaceId === workspaceId)?.missingChunks ?? 0;
  };

  const bindProfile = async (pendingSpaceId?: string): Promise<void> => {
    await database.query(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id, pending_embedding_space_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE
         SET active_embedding_space_id = EXCLUDED.active_embedding_space_id,
             pending_embedding_space_id = EXCLUDED.pending_embedding_space_id`,
      [workspaceId, spaceId, pendingSpaceId ?? null],
    );
  };

  const insertCanonical = async (
    chunkId: string,
    options: { spaceId?: string; revision?: number } = {},
  ): Promise<void> => {
    await database.query(
      `INSERT INTO chunk_embeddings
         (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
       VALUES ($1, $2, $3, $4, 1, 1536,
               (SELECT array_agg(0.1)::vector FROM generate_series(1, 1536)), 'hash')`,
      [workspaceId, chunkId, options.spaceId ?? spaceId, options.revision ?? 1],
    );
  };

  it("counts chunks that have no canonical embedding row", async () => {
    await insertChunk(0);
    await insertChunk(1);

    expect(await gapFor()).toBe(2);
  });

  it("stops counting a chunk once it is projected into chunk_embeddings", async () => {
    const chunkId = await insertChunk(0);
    await insertChunk(1);
    // The profile is what makes projection meaningful: a canonical row only counts as
    // coverage when it belongs to a space the workspace targets.
    await bindProfile();
    await insertCanonical(chunkId);

    expect(await gapFor()).toBe(1);

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("still counts a chunk whose only canonical row belongs to another space", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile();
    await insertCanonical(chunkId, { spaceId: staleSpaceId });

    // Coverage means a row for the active or pending space; a leftover row from a
    // space the workspace has moved off is a gap, not coverage.
    expect(await gapFor()).toBe(1);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("does not count pending-space coverage as active retrieval coverage", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile(staleSpaceId);
    await insertCanonical(chunkId, { spaceId: staleSpaceId });

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    expect(coverage).toMatchObject({
      eligibleChunks: 1,
      coveredChunks: 0,
      missingChunks: 1,
    });

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  // The gap report schedules work; the coverage status describes what search can
  // already answer. During a transition those are different questions, so the two
  // numbers disagree on purpose. Pinning it here keeps a later "make these agree"
  // change from silently hiding pending-space work or reporting a searchable
  // workspace as broken.
  it("keeps backfill scheduling and active coverage deliberately out of step", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile(staleSpaceId);
    await insertCanonical(chunkId, { spaceId: spaceId });

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    // Active space is covered, so retrieval finds the chunk.
    expect(coverage).toMatchObject({ eligibleChunks: 1, coveredChunks: 1, missingChunks: 0 });
    // The pending space still has no row, so the backfill has work left to enqueue.
    expect(await gapFor()).toBe(1);

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  // Everything in one coverage response has to answer the same question. The chunk
  // counts describe the active space, so the job counts beside them must too: a
  // response reading "nothing missing, one job failed" cannot be acted on, and the
  // dashboard reads it as complete before it ever looks at the failure.
  it("counts jobs for the active space alone, matching what it counts as missing", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile(staleSpaceId);
    await insertCanonical(chunkId, { spaceId: spaceId });
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status, embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 1, 'embedding_profile', 'failed', $4, 1)`,
      [randomUUID(), documentId, workspaceId, staleSpaceId],
    );

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    expect(coverage).toMatchObject({ missingChunks: 0, failedJobs: 0, queuedJobs: 0 });
    // The backfill still owns the pending-space gap and reports it.
    expect(await gapFor()).toBe(1);

    await database.query("DELETE FROM document_processing_jobs WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("still counts a chunk whose canonical row is for an older document revision", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile();
    await database.query("UPDATE documents SET revision = 2 WHERE id = $1", [documentId]);
    await insertCanonical(chunkId, { revision: 1 });

    expect(await gapFor()).toBe(1);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("ignores chunks in documents the reconciler would not serve", async () => {
    await insertChunk(0);
    await bindProfile();
    await database.query("UPDATE documents SET retrieval_enabled = FALSE WHERE id = $1", [documentId]);

    expect(await gapFor()).toBe(0);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("flags a workspace with no embedding profile as not actionable", async () => {
    await insertChunk(0);

    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    const gap = gaps.find((entry) => entry.workspaceId === workspaceId);

    // Coverage enqueueing joins workspace_embedding_profiles, so without that row the
    // backfill produces no jobs. The flag is what stops that looking like success.
    expect(gap?.hasEmbeddingProfile).toBe(false);
  });

  it("does not let a canonical row stand in for coverage when no profile exists", async () => {
    const chunkId = await insertChunk(0);
    await insertCanonical(chunkId, { spaceId: staleSpaceId });

    // Coverage means a row for a space the workspace actually targets. Without a
    // profile there are no target spaces, so a leftover row proves nothing: retrieval
    // has no space to search and the backfill cannot enqueue anything. Reporting this
    // as covered showed the dashboard "all chunks indexed" for a workspace whose
    // documents were unreachable.
    expect(await gapFor()).toBe(1);

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
    expect(coverage).toMatchObject({
      eligibleChunks: 1,
      coveredChunks: 0,
      missingChunks: 1,
      hasEmbeddingProfile: false,
    });
  });

  it("keeps a no-profile workspace visible to the backfill's blocked report", async () => {
    const chunkId = await insertChunk(0);
    await insertCanonical(chunkId, { spaceId: staleSpaceId });

    // backfillEmbeddingCoverage reads this list to name workspaces it cannot repair.
    // A workspace that drops out of it is not reported as blocked — it is reported as
    // nothing at all, and the script exits zero claiming coverage is complete.
    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    const gap = gaps.find((entry) => entry.workspaceId === workspaceId);

    expect(gap).toBeDefined();
    expect(gap?.hasEmbeddingProfile).toBe(false);
  });

  it("marks a workspace actionable once it has an embedding profile", async () => {
    await insertChunk(0);
    await database.query(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO UPDATE SET active_embedding_space_id = EXCLUDED.active_embedding_space_id`,
      [workspaceId, spaceId],
    );

    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    const gap = gaps.find((entry) => entry.workspaceId === workspaceId);

    expect(gap?.hasEmbeddingProfile).toBe(true);
    expect(gap?.missingChunks).toBe(1);

    await database.query(
      "DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1",
      [workspaceId],
    );
  });

  it("reports coverage with a denominator for one workspace", async () => {
    const covered = await insertChunk(0);
    await insertChunk(1);
    await bindProfile();
    await insertCanonical(covered);

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    // The gap list has no denominator, so "4,329 outstanding" reads the same whether
    // the workspace is nearly done or has not started. Progress needs both numbers.
    expect(coverage).toMatchObject({
      workspaceId,
      eligibleChunks: 2,
      coveredChunks: 1,
      missingChunks: 1,
      hasEmbeddingProfile: true,
    });

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("agrees with the gap report on what counts as covered", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile();
    await insertCanonical(chunkId, { spaceId: staleSpaceId });

    // Both reads must apply the same rule — a row for a space the workspace has moved
    // off is not coverage — or the dashboard would show work the backfill still has to do.
    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
    expect(coverage.missingChunks).toBe(await gapFor());
    expect(coverage.coveredChunks).toBe(0);

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("reports complete coverage rather than an empty result once nothing is missing", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile();
    await insertCanonical(chunkId);

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    expect(coverage.eligibleChunks).toBe(1);
    expect(coverage.coveredChunks).toBe(1);
    expect(coverage.missingChunks).toBe(0);

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("reports zeroes for a workspace with no retrievable chunks at all", async () => {
    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    expect(coverage).toMatchObject({
      workspaceId,
      eligibleChunks: 0,
      coveredChunks: 0,
      missingChunks: 0,
      hasEmbeddingProfile: false,
    });
  });

  it("counts the embedding_profile jobs still in flight for the workspace", async () => {
    await insertChunk(0);
    await bindProfile();
    // The two jobs sit on different documents: the profile-job key is
    // (document, revision, kind, space, generation), so a queued and a failed job for
    // the same document and space cannot coexist — that collision is the very reason a
    // failed job blocks its gap from being re-enqueued.
    const secondDocumentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Doc 2', 'content', 'content', 'ready', 1, '{}'::jsonb)`,
      [secondDocumentId, workspaceId],
    );
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, 0, 'chunk text', 'chunk text', 0, 10, '{}'::jsonb)`,
      [randomUUID(), secondDocumentId, workspaceId],
    );
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status, embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 1, 'embedding_profile', 'queued', $4, 1),
              ($5, $6, $3, 1, 'embedding_profile', 'failed', $4, 1)`,
      [randomUUID(), documentId, workspaceId, spaceId, randomUUID(), secondDocumentId],
    );

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);

    // A failed job holds the profile-job unique key, so its gap can never be
    // re-enqueued. Surfacing the count is what separates "still working" from "stuck".
    expect(coverage.queuedJobs).toBe(1);
    expect(coverage.failedJobs).toBe(1);

    await database.query("DELETE FROM document_processing_jobs WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("does not count stale embedding_profile jobs as blocking current coverage", async () => {
    await insertChunk(0);
    await bindProfile();
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status, embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 1, 'embedding_profile', 'failed', $4, 1),
              ($5, $2, $3, 1, 'embedding_profile', 'failed', $6, 1),
              ($7, $2, $3, 1, 'embedding_profile', 'queued', $4, 2)`,
      [
        randomUUID(),
        documentId,
        workspaceId,
        spaceId,
        randomUUID(),
        staleSpaceId,
        randomUUID(),
      ],
    );

    const coverage = await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();

    expect(coverage.failedJobs).toBe(1);
    expect(coverage.queuedJobs).toBe(0);
    expect(gaps.find((gap) => gap.workspaceId === workspaceId)?.failedJobs).toBe(1);

    await database.query("DELETE FROM document_processing_jobs WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  it("omits a workspace entirely once every chunk is projected", async () => {
    const chunkId = await insertChunk(0);
    await bindProfile();
    await insertCanonical(chunkId);

    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    expect(gaps.some((gap) => gap.workspaceId === workspaceId)).toBe(false);

    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });
});
