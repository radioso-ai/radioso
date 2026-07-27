import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  DocumentProcessingJobRepository,
  insertEmbeddingProfileJobsForDocumentRevision,
} from "../../src/db/repositories/documentProcessingJobRepository.js";
import { EmbeddingProfileJobRepository } from "../../src/db/repositories/embeddingProfileJobRepository.js";
import { EmbeddingProfileRepository } from "../../src/db/repositories/embeddingProfileRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("document job queue embedding profiles (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const profiles = new EmbeddingProfileRepository(database.kysely);
  const jobs = new DocumentProcessingJobRepository(database.kysely);
  const persistence = new EmbeddingProfileJobRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Profile Job Test", `profile-jobs-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Profile Job Workspace", `profile-jobs-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_transitions WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createSpace = (name: string, dimensions: number) =>
    profiles.createEmbeddingSpace({
      identityFingerprint: `profile-job-${workspaceId}-${name}`,
      provider: "openai",
      endpointScopeFingerprint: "profile-job-endpoint",
      model: name,
      dimensions,
      distanceMetric: "cosine",
      normalization: "provider",
      documentTask: "document",
      queryTask: "query",
      vectorOptions: {},
      modelVersion: null,
    });

  const insertDocument = async () => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO documents
         (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Document', 'Content', 'Content', 'ready', 3, '{}'::jsonb)`,
      [documentId, workspaceId],
    );
    await database.query(
      `INSERT INTO chunks
         (id, document_id, workspace_id, chunk_index, content, search_text,
          start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, 0, 'Content', 'Search content', 0, 7, '{}'::jsonb)`,
      [chunkId, documentId, workspaceId],
    );
    return { documentId, chunkId };
  };

  it("atomically creates idempotent active and pending jobs for canonical publication", async () => {
    const active = await createSpace("active", 3);
    const pending = await createSpace("pending", 4);
    await profiles.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    await profiles.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });
    const { documentId } = await insertDocument();

    await database.withTransaction(async (client) => {
      expect(await insertEmbeddingProfileJobsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 3,
        activeEmbeddingSpaceId: active.id,
      })).toBe(2);
      expect(await insertEmbeddingProfileJobsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 3,
        activeEmbeddingSpaceId: active.id,
      })).toBe(0);
    });

    const rows = await database.query<{
      embedding_space_id: string;
      workspace_profile_generation: string;
    }>(
      `SELECT embedding_space_id, workspace_profile_generation
       FROM document_processing_jobs
       WHERE document_id = $1 AND kind = 'embedding_profile'
       ORDER BY embedding_space_id`,
      [documentId],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.embedding_space_id))).toEqual(
      new Set([active.id, pending.id]),
    );
    expect(rows.every((row) => String(row.workspace_profile_generation) === "2")).toBe(true);
  });

  it("loads missing chunks and commits only under the pinned generation", async () => {
    const active = await createSpace("commit-active", 3);
    const pending = await createSpace("commit-pending", 4);
    await profiles.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    await profiles.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });
    const { documentId, chunkId } = await insertDocument();
    const job = await database.withTransaction(async (client) => {
      await insertEmbeddingProfileJobsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 3,
        activeEmbeddingSpaceId: active.id,
      });
      const profileJob = (await client.query<{
        id: string;
      }>(
        `SELECT id FROM document_processing_jobs
         WHERE document_id = $1 AND embedding_space_id = $2`,
        [documentId, pending.id],
      )).rows[0];
      return profileJob!;
    });

    await expect(persistence.load({
      jobId: job.id,
      workspaceId,
      documentId,
      documentRevision: 3,
      embeddingSpaceId: pending.id,
      expectedWorkspaceProfileGeneration: "2",
    })).resolves.toMatchObject({
      outcome: "ready",
      chunks: [{ id: chunkId, text: "Search content" }],
    });

    await expect(persistence.commit({
      jobId: job.id,
      workspaceId,
      documentId,
      documentRevision: 3,
      embeddingSpaceId: pending.id,
      expectedWorkspaceProfileGeneration: "2",
      canonicalVersion: "3",
      space: {
        id: pending.id,
        dimensions: 4,
        distanceMetric: "cosine",
      },
      embeddings: [{
        chunkId,
        chunkIndex: 0,
        contentHash: "hash",
        embedding: [0.1, 0.2, 0.3, 0.4],
      }],
    })).resolves.toBe("completed");

    await profiles.cancelTransition({
      workspaceId,
      transitionId: (await profiles.findWorkspaceProfile(workspaceId))!.transition!.id,
      expectedGeneration: "2",
    });
    await expect(persistence.load({
      jobId: job.id,
      workspaceId,
      documentId,
      documentRevision: 3,
      embeddingSpaceId: pending.id,
      expectedWorkspaceProfileGeneration: "2",
    })).resolves.toEqual({ outcome: "superseded" });
  });

  it("claims duplicate deliveries at most once within a live lease", async () => {
    const active = await createSpace("lease-active", 3);
    await profiles.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    const { documentId } = await insertDocument();
    await database.withTransaction((client) =>
      insertEmbeddingProfileJobsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 3,
        activeEmbeddingSpaceId: active.id,
      }),
    );
    const row = (await database.query<{ id: string }>(
      "SELECT id FROM document_processing_jobs WHERE document_id = $1",
      [documentId],
    ))[0]!;

    const [first, second] = await Promise.all([
      jobs.claimById(row.id),
      jobs.claimById(row.id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("creates fresh work when a cancelled target is selected again at a new generation", async () => {
    const active = await createSpace("repeat-active", 3);
    const pending = await createSpace("repeat-pending", 4);
    await profiles.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    const firstTransition = await profiles.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });
    const { documentId } = await insertDocument();
    await database.withTransaction((client) =>
      insertEmbeddingProfileJobsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 3,
        activeEmbeddingSpaceId: active.id,
      }),
    );
    await profiles.cancelTransition({
      workspaceId,
      transitionId: firstTransition.transition.id,
      expectedGeneration: "2",
    });
    await jobs.cancelEmbeddingProfileJobsForTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      generation: "2",
    });
    await profiles.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "3",
    });

    await expect(jobs.ensureEmbeddingProfileJobsForTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      generation: "4",
    })).resolves.toBe(1);

    const rows = await database.query<{ workspace_profile_generation: string }>(
      `SELECT workspace_profile_generation
       FROM document_processing_jobs
       WHERE document_id = $1 AND embedding_space_id = $2
       ORDER BY workspace_profile_generation`,
      [documentId, pending.id],
    );
    expect(rows.map((row) => String(row.workspace_profile_generation))).toEqual(["2", "4"]);
  });
});
