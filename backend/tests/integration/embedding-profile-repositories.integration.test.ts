import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { ChunkEmbeddingRepository } from "../../src/db/repositories/chunkEmbeddingRepository.js";
import { EmbeddingProfileRepository } from "../../src/db/repositories/embeddingProfileRepository.js";
import { IngestionSettingsRepository } from "../../src/db/repositories/ingestionSettingsRepository.js";
import { VectorIndexWorkRepository } from "../../src/db/repositories/vectorIndexWorkRepository.js";
import { EmbeddingProfileJobFailureAdapter } from "../../src/app/composition/embeddingProfileJobFailureAdapter.js";
import { EmbeddingModelTransitionAdapter } from "../../src/app/composition/embeddingModelTransitionAdapter.js";
import { EmbeddingTransitionCoordinator } from "../../src/modules/embeddingProfiles/public.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("embedding profile repositories (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const profileRepository = new EmbeddingProfileRepository(database.kysely);
  const chunkEmbeddingRepository = new ChunkEmbeddingRepository(database.kysely);
  const ingestionSettingsRepository = new IngestionSettingsRepository(database.kysely);
  const vectorIndexWorkRepository = new VectorIndexWorkRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Embedding Profile Test Co", `embedding-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Embedding Profile Workspace", `embedding-route-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM ingestion_settings WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM vector_index_work WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM vector_index_checkpoints WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_transitions WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]);
    await database.query(
      `DELETE FROM embedding_spaces
       WHERE id NOT IN (
         SELECT active_embedding_space_id FROM workspace_embedding_profiles
         UNION
         SELECT pending_embedding_space_id FROM workspace_embedding_profiles
         WHERE pending_embedding_space_id IS NOT NULL
       )`,
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createSpace = async (suffix: string, dimensions = 1536) =>
    profileRepository.createEmbeddingSpace({
      identityFingerprint: `space-fingerprint-${workspaceId}-${suffix}`,
      provider: "openai",
      endpointScopeFingerprint: `endpoint-scope-${suffix}`,
      model: suffix,
      dimensions,
      distanceMetric: "cosine",
      normalization: "provider",
      documentTask: "document",
      queryTask: "query",
      vectorOptions: {},
      modelVersion: null,
    });

  const insertReadyDocumentWithChunk = async (): Promise<{
    documentId: string;
    chunkId: string;
  }> => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO documents
         (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, $3, $4, $4, 'ready', 7, '{}'::jsonb)`,
      [documentId, workspaceId, "Canonical document", "Canonical content"],
    );
    await database.query(
      `INSERT INTO chunks
         (id, document_id, workspace_id, chunk_index, content, search_text, start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, 0, $4, $4, 0, 17, '{}'::jsonb)`,
      [chunkId, documentId, workspaceId, "Canonical content"],
    );
    return { documentId, chunkId };
  };

  it("creates immutable embedding spaces idempotently by fingerprint", async () => {
    const first = await createSpace("text-embedding-3-small");
    const second = await createSpace("text-embedding-3-small");

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      provider: "openai",
      endpointScopeFingerprint: "endpoint-scope-text-embedding-3-small",
      model: "text-embedding-3-small",
      dimensions: 1536,
      distanceMetric: "cosine",
      normalization: "provider",
    });

    await expect(
      database.query("UPDATE embedding_spaces SET model = 'mutated' WHERE id = $1", [first.id]),
    ).rejects.toThrow(/immutable/i);

    const taskless = await profileRepository.createEmbeddingSpace({
      identityFingerprint: `space-fingerprint-${workspaceId}-taskless`,
      provider: "openai",
      endpointScopeFingerprint: "endpoint-scope-taskless",
      model: "text-embedding-3-small",
      dimensions: 1536,
      distanceMetric: "cosine",
      normalization: "provider",
      documentTask: null,
      queryTask: null,
      vectorOptions: {},
      modelVersion: null,
    });
    expect(taskless).toMatchObject({
      documentTask: null,
      queryTask: null,
    });
  });

  it("enforces one pending transition and generation compare-and-swap", async () => {
    const active = await createSpace("active");
    const pending = await createSpace("pending", 3072);
    const other = await createSpace("other", 768);
    const initialized = await profileRepository.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });

    expect(initialized.generation).toBe("1");
    const started = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });
    expect(started.profile).toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: pending.id,
      generation: "2",
    });
    expect(started.transition).toMatchObject({
      sourceEmbeddingSpaceId: active.id,
      targetEmbeddingSpaceId: pending.id,
      generation: "2",
      status: "building",
    });

    await expect(profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: other.id,
      expectedGeneration: "2",
    })).rejects.toThrow(/already pending/i);
    await expect(profileRepository.cancelTransition({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "1",
    })).rejects.toThrow(/stale workspace embedding profile generation/i);

    const cancelled = await profileRepository.cancelTransition({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
    });
    expect(cancelled).toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: null,
      generation: "3",
    });
  });

  it("persists fenced blocked, quarantined, terminal, and cancellation states", async () => {
    const active = await createSpace("failure-active");
    const blockedTarget = await createSpace("failure-blocked", 3072);
    const quarantinedTarget = await createSpace("failure-quarantined", 768);
    const terminalTarget = await createSpace("failure-terminal", 1024);
    await profileRepository.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });

    const blocked = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: blockedTarget.id,
      expectedGeneration: "1",
    });
    await expect(
      profileRepository.listBuildingTransitions({ limit: 25 }),
    ).resolves.toEqual([
      {
        profile: blocked.profile,
        transition: blocked.transition,
      },
    ]);
    const blockedProfile = await profileRepository.failTransition({
      workspaceId,
      transitionId: blocked.transition.id,
      expectedGeneration: "2",
      status: "blocked",
      reason: "backfill_retry_exhausted",
    });
    expect(blockedProfile).toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: blockedTarget.id,
      generation: "2",
      transition: {
        status: "blocked",
        failureReason: "backfill_retry_exhausted",
      },
    });
    const cancelledBlocked = await profileRepository.cancelTransition({
      workspaceId,
      transitionId: blocked.transition.id,
      expectedGeneration: "2",
    });
    expect(cancelledBlocked).toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: null,
      generation: "3",
      transition: { status: "cancelled" },
    });

    const quarantined = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: quarantinedTarget.id,
      expectedGeneration: "3",
    });
    const quarantinedProfile = await profileRepository.failTransition({
      workspaceId,
      transitionId: quarantined.transition.id,
      expectedGeneration: "4",
      status: "quarantined",
      reason: "embedding_contract_drift",
    });
    expect(quarantinedProfile).toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: quarantinedTarget.id,
      generation: "4",
      transition: {
        status: "quarantined",
        failureReason: "embedding_contract_drift",
      },
    });
    await expect(
      profileRepository.findEmbeddingSpaceById(quarantinedTarget.id),
    ).resolves.toMatchObject({
      status: "quarantined",
      quarantineReason: "embedding_contract_drift",
    });
    await profileRepository.cancelTransition({
      workspaceId,
      transitionId: quarantined.transition.id,
      expectedGeneration: "4",
    });
    await expect(profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: quarantinedTarget.id,
      expectedGeneration: "5",
    })).rejects.toThrow(/target is quarantined/i);

    const terminal = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: terminalTarget.id,
      expectedGeneration: "5",
    });
    await expect(profileRepository.failTransition({
      workspaceId,
      transitionId: terminal.transition.id,
      expectedGeneration: "5",
      status: "failed",
      reason: "terminal_failure",
    })).rejects.toThrow(/stale workspace embedding profile generation/i);

    const failed = await profileRepository.failTransition({
      workspaceId,
      transitionId: terminal.transition.id,
      expectedGeneration: "6",
      status: "failed",
      reason: "terminal_failure",
    });
    expect(failed).toMatchObject({
      activeEmbeddingSpaceId: active.id,
      pendingEmbeddingSpaceId: null,
      generation: "7",
      transition: {
        status: "failed",
        failureReason: "terminal_failure",
      },
    });
  });

  it("moves a retry-exhausted pinned job transition out of building", async () => {
    const active = await createSpace("exhausted-active");
    const pending = await createSpace("exhausted-pending", 3072);
    const { documentId } = await insertReadyDocumentWithChunk();
    await profileRepository.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    const started = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status,
          embedding_space_id, workspace_profile_generation, last_error,
          completed_at)
       VALUES ($1, $2, $3, 7, 'embedding_profile', 'failed', $4, 2,
               'provider unavailable', NOW())`,
      [jobId, documentId, workspaceId, pending.id],
    );
    const coordinator = new EmbeddingTransitionCoordinator(
      profileRepository,
      { validateFixedInput: async () => undefined },
      {
        ensureTransitionWork: async () => undefined,
        cancelTransitionWork: async () => undefined,
      },
      { backendKey: "pgvector" },
    );
    const failures = new EmbeddingProfileJobFailureAdapter(
      profileRepository,
      coordinator,
    );

    await failures.recordFailure({
      jobId,
      workspaceId,
      embeddingSpaceId: pending.id,
      workspaceProfileGeneration: "2",
      failureKind: "retry_exhausted",
    });

    await expect(profileRepository.findWorkspaceProfile(workspaceId))
      .resolves.toMatchObject({
        activeEmbeddingSpaceId: active.id,
        pendingEmbeddingSpaceId: pending.id,
        transition: {
          id: started.transition.id,
          status: "blocked",
          failureReason: "backfill_retry_exhausted",
        },
      });
    await expect(profileRepository.listBuildingTransitions({ limit: 25 }))
      .resolves.toEqual([]);
    await expect(coordinator.reconcilePromotion({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
    })).resolves.toMatchObject({
      outcome: "blocked",
      profile: {
        transition: { status: "blocked" },
      },
    });
  });

  it("repairs settings after permanent pinned work failure and accepts a new model", async () => {
    const active = await createSpace("text-embedding-3-small");
    const failedTarget = await createSpace("text-embedding-3-large", 3072);
    const { documentId } = await insertReadyDocumentWithChunk();
    await profileRepository.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    const started = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: failedTarget.id,
      expectedGeneration: "1",
    });
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status,
          embedding_space_id, workspace_profile_generation, last_error,
          completed_at)
       VALUES ($1, $2, $3, 7, 'embedding_profile', 'failed', $4, 2,
               'provider rejected request', NOW())`,
      [jobId, documentId, workspaceId, failedTarget.id],
    );
    await ingestionSettingsRepository.upsert(workspaceId, {
      ...defaultIngestionSettings(workspaceId),
      pendingEmbeddingModel: "text-embedding-3-large",
    });
    const staleSettingsSnapshot =
      await ingestionSettingsRepository.findVersionedByWorkspaceId(workspaceId);
    expect(staleSettingsSnapshot).not.toBeNull();
    await ingestionSettingsRepository.upsert(workspaceId, {
      ...defaultIngestionSettings(workspaceId),
      pendingEmbeddingModel: "text-embedding-3-large",
    });
    await expect(ingestionSettingsRepository.clearPendingEmbeddingModel(
      workspaceId,
      "text-embedding-3-large",
      staleSettingsSnapshot!.revision,
    )).resolves.toBeNull();
    await expect(ingestionSettingsRepository.findByWorkspaceId(workspaceId))
      .resolves.toMatchObject({
        pendingEmbeddingModel: "text-embedding-3-large",
      });
    const coordinator = new EmbeddingTransitionCoordinator(
      profileRepository,
      { validateFixedInput: async () => undefined },
      {
        ensureTransitionWork: async () => undefined,
        cancelTransitionWork: async () => undefined,
      },
      { backendKey: "pgvector" },
    );
    const jobFailures = new EmbeddingProfileJobFailureAdapter(
      profileRepository,
      coordinator,
    );
    await jobFailures.recordFailure({
      jobId,
      workspaceId,
      embeddingSpaceId: failedTarget.id,
      workspaceProfileGeneration: "2",
      failureKind: "permanent",
    });
    const transitions = new EmbeddingModelTransitionAdapter(
      profileRepository,
      (model) => ({
        provider: model === "gemini-embedding-001" ? "gemini" : "openai",
        endpointScopeFingerprint: `scope:${model}`,
      }),
      coordinator,
      { prepare: async () => undefined },
    );
    const settings = new IngestionSettingsService(
      ingestionSettingsRepository,
      { record: async () => undefined } as never,
      undefined,
      transitions,
    );

    await expect(settings.getForWorkspace(workspaceId)).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: null,
    });
    await expect(ingestionSettingsRepository.findByWorkspaceId(workspaceId))
      .resolves.toMatchObject({
        pendingEmbeddingModel: null,
      });

    await expect(settings.updateForWorkspace(workspaceId, {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      embeddingModel: "gemini-embedding-001",
    })).resolves.toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: "gemini-embedding-001",
    });
    await expect(profileRepository.findWorkspaceProfile(workspaceId))
      .resolves.toMatchObject({
        activeEmbeddingSpaceId: active.id,
        pendingEmbeddingSpaceId: expect.any(String),
        generation: "4",
        transition: {
          status: "building",
          targetEmbeddingSpaceId: expect.any(String),
        },
      });
    expect(started.transition.targetEmbeddingSpaceId).toBe(failedTarget.id);
  });

  it("promotes only after canonical coverage, pinned work, and vector readiness are rechecked", async () => {
    const active = await createSpace("active");
    const pending = await createSpace("pending", 3072);
    const { documentId, chunkId } = await insertReadyDocumentWithChunk();
    await profileRepository.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    const started = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });

    const projection = await vectorIndexWorkRepository.append({
      workspaceId,
      embeddingSpaceId: pending.id,
      chunkId,
      documentId,
      operation: "upsert",
      canonicalVersion: "1",
      payload: {},
    });
    await vectorIndexWorkRepository.advanceCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: pending.id,
      acknowledgedSequence: "0",
      expectedAcknowledgedSequence: "0",
      readiness: "ready",
    });
    await expect(profileRepository.promoteTransitionIfEligible({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
      backendKey: "pgvector",
    })).rejects.toThrow(/not ready for promotion/i);

    await chunkEmbeddingRepository.upsert({
      workspaceId,
      chunkId,
      documentId,
      documentRevision: 7,
      embeddingSpaceId: pending.id,
      canonicalVersion: "1",
      dimensions: 3072,
      embedding: Array.from({ length: 3072 }, () => 0),
      contentHash: "promotion-content",
    });
    await expect(profileRepository.promoteTransitionIfEligible({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
      backendKey: "pgvector",
    })).rejects.toThrow(/not ready for promotion/i);

    await vectorIndexWorkRepository.advanceCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: pending.id,
      acknowledgedSequence: projection.work.sequence,
      expectedAcknowledgedSequence: "0",
      readiness: "ready",
    });
    const pinnedJobId = randomUUID();
    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status,
          embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 7, 'embedding_profile', 'queued', $4, 2)`,
      [pinnedJobId, documentId, workspaceId, pending.id],
    );
    await expect(profileRepository.promoteTransitionIfEligible({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
      backendKey: "pgvector",
    })).rejects.toThrow(/not ready for promotion/i);

    await database.query(
      `UPDATE document_processing_jobs
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [pinnedJobId],
    );
    const promoted = await profileRepository.promoteTransitionIfEligible({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
      backendKey: "pgvector",
    });

    expect(promoted).toMatchObject({
      activeEmbeddingSpaceId: pending.id,
      pendingEmbeddingSpaceId: null,
      generation: "3",
      transition: {
        id: started.transition.id,
        status: "promoted",
      },
    });
  });

  it("promotes an empty workspace from an initialized exact fallback checkpoint", async () => {
    const active = await createSpace("empty-active");
    const pending = await createSpace("empty-pending", 3072);
    await profileRepository.initializeWorkspaceProfile({
      workspaceId,
      activeEmbeddingSpaceId: active.id,
    });
    const started = await profileRepository.startTransition({
      workspaceId,
      targetEmbeddingSpaceId: pending.id,
      expectedGeneration: "1",
    });

    await vectorIndexWorkRepository.ensureCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: pending.id,
      readiness: "exact_fallback",
    });
    const promoted = await profileRepository.promoteTransitionIfEligible({
      workspaceId,
      transitionId: started.transition.id,
      expectedGeneration: "2",
      backendKey: "pgvector",
    });

    expect(promoted).toMatchObject({
      activeEmbeddingSpaceId: pending.id,
      pendingEmbeddingSpaceId: null,
      transition: {
        status: "promoted",
      },
    });
  });

  it("stores full-precision canonical vectors with decimal-safe monotonic versions", async () => {
    const space = await createSpace("canonical", 3);
    const { documentId, chunkId } = await insertReadyDocumentWithChunk();
    const first = await chunkEmbeddingRepository.upsert({
      workspaceId,
      chunkId,
      documentId,
      documentRevision: 7,
      embeddingSpaceId: space.id,
      canonicalVersion: "9007199254740993",
      dimensions: 3,
      embedding: [0.125, -0.25, 0.375],
      contentHash: "content-hash-v1",
    });

    expect(first.applied).toBe(true);
    expect(first.record).toMatchObject({
      canonicalVersion: "9007199254740993",
      dimensions: 3,
      embedding: [0.125, -0.25, 0.375],
    });

    const stale = await chunkEmbeddingRepository.upsert({
      workspaceId,
      chunkId,
      documentId,
      documentRevision: 7,
      embeddingSpaceId: space.id,
      canonicalVersion: "9007199254740992",
      dimensions: 3,
      embedding: [1, 0, 0],
      contentHash: "stale",
    });
    expect(stale.applied).toBe(false);
    expect(stale.record.canonicalVersion).toBe("9007199254740993");

    const updated = await chunkEmbeddingRepository.upsert({
      workspaceId,
      chunkId,
      documentId,
      documentRevision: 7,
      embeddingSpaceId: space.id,
      canonicalVersion: "9007199254740994",
      dimensions: 3,
      embedding: [0.5, 0.25, -0.125],
      contentHash: "content-hash-v2",
    });
    expect(updated.applied).toBe(true);
    expect((await chunkEmbeddingRepository.find({
      workspaceId,
      chunkId,
      embeddingSpaceId: space.id,
    }))?.canonicalVersion).toBe("9007199254740994");
  });

  it("keeps versioned projection tombstones durable and advances checkpoints safely", async () => {
    const space = await createSpace("projection");
    const { documentId, chunkId } = await insertReadyDocumentWithChunk();
    const upsert = await vectorIndexWorkRepository.append({
      workspaceId,
      embeddingSpaceId: space.id,
      chunkId,
      documentId,
      operation: "upsert",
      canonicalVersion: "9007199254740993",
      payload: { sourceId: null },
    });
    const tombstone = await vectorIndexWorkRepository.append({
      workspaceId,
      embeddingSpaceId: space.id,
      chunkId,
      documentId,
      operation: "delete",
      canonicalVersion: "9007199254740994",
      payload: {},
    });
    const stale = await vectorIndexWorkRepository.append({
      workspaceId,
      embeddingSpaceId: space.id,
      chunkId,
      documentId,
      operation: "upsert",
      canonicalVersion: "9007199254740993",
      payload: { sourceId: "stale" },
    });

    expect(upsert.accepted).toBe(true);
    expect(tombstone.accepted).toBe(true);
    expect(stale).toMatchObject({
      accepted: false,
      work: {
        id: tombstone.work.id,
        operation: "delete",
        canonicalVersion: "9007199254740994",
      },
    });

    await vectorIndexWorkRepository.markCompleted(tombstone.work.id);
    const checkpoint = await vectorIndexWorkRepository.advanceCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: space.id,
      acknowledgedSequence: tombstone.work.sequence,
      expectedAcknowledgedSequence: "0",
      readiness: "ready",
    });
    expect(checkpoint).toMatchObject({
      acknowledgedSequence: tombstone.work.sequence,
      readiness: "ready",
    });
    await expect(vectorIndexWorkRepository.advanceCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: space.id,
      acknowledgedSequence: (BigInt(tombstone.work.sequence) + 1n).toString(),
      expectedAcknowledgedSequence: "0",
      readiness: "ready",
    })).rejects.toThrow(/stale vector index checkpoint/i);
  });

  it("adds profile-pinned durable jobs without weakening existing uniqueness", async () => {
    const active = await createSpace("active");
    const pending = await createSpace("pending");
    const { documentId } = await insertReadyDocumentWithChunk();

    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status)
       VALUES ($1, $2, $3, 7, 'vectorize', 'queued'),
              ($4, $2, $3, 7, 'enrich', 'queued')`,
      [randomUUID(), documentId, workspaceId, randomUUID()],
    );
    await expect(
      database.query(
        `INSERT INTO document_processing_jobs
           (id, document_id, workspace_id, document_revision, kind, status)
         VALUES ($1, $2, $3, 7, 'vectorize', 'queued')`,
        [randomUUID(), documentId, workspaceId],
      ),
    ).rejects.toThrow();

    await database.query(
      `INSERT INTO document_processing_jobs
         (id, document_id, workspace_id, document_revision, kind, status,
          embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 7, 'embedding_profile', 'queued', $4, 2),
              ($5, $2, $3, 7, 'embedding_profile', 'queued', $6, 2)`,
      [randomUUID(), documentId, workspaceId, active.id, randomUUID(), pending.id],
    );
    await expect(
      database.query(
        `INSERT INTO document_processing_jobs
           (id, document_id, workspace_id, document_revision, kind, status,
            embedding_space_id, workspace_profile_generation)
         VALUES ($1, $2, $3, 7, 'embedding_profile', 'queued', $4, 2)`,
        [randomUUID(), documentId, workspaceId, active.id],
      ),
    ).rejects.toThrow();
  });
});
