import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  measureWorkspaceParity,
  openExactSearchDatabase,
  resolveParityWorkspaceSelection,
  resolveParityTargets,
  sampleProbeVectors,
} from "../../scripts/canonicalVectorParityRunner.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// The gate for removing the legacy vector leg. It only means anything if it fails when
// canonical really would lose results, so the divergence is staged here on purpose:
// chunks that exist in chunks.embedding but not in chunk_embeddings are exactly the
// production state issue #1063 is waiting on the backfill to clear.

const DIMENSIONS = 1536;
const MODEL = "text-embedding-3-small";

// Distinct unit vectors: chunk n points along axis n, so a probe along axis n retrieves
// chunk n first and the rest at a known distance.
const axisVector = (axis: number): number[] =>
  Array.from({ length: DIMENSIONS }, (_, index) => (index === axis ? 1 : 0));

const serialize = (vector: readonly number[]): string => `[${vector.join(",")}]`;

describeIntegration("canonical vector parity gate (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const eligibleUnprofiledWorkspaceId = randomUUID();
  const emptyUnprofiledWorkspaceId = randomUUID();
  const spaceId = randomUUID();
  let documentId: string;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Parity Co", `parity-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Parity Workspace", `parity-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $3, 'Unprofiled Eligible', $4), ($2, $3, 'Unprofiled Empty', $5)`,
      [
        eligibleUnprofiledWorkspaceId,
        emptyUnprofiledWorkspaceId,
        accountId,
        `parity-route-${eligibleUnprofiledWorkspaceId}`,
        `parity-route-${emptyUnprofiledWorkspaceId}`,
      ],
    );
    const unprofiledDocumentId = randomUUID();
    await database.query(
      `INSERT INTO documents
         (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Unprofiled doc', 'content', 'content', 'ready', 1, '{}'::jsonb)`,
      [unprofiledDocumentId, eligibleUnprofiledWorkspaceId],
    );
    await database.query(
      `INSERT INTO chunks
         (id, document_id, workspace_id, chunk_index, content, search_text,
          embedding, embedding_model, start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, 0, 'chunk text', 'chunk text', $4::vector, $5, 0, 10, '{}'::jsonb)`,
      [
        randomUUID(),
        unprofiledDocumentId,
        eligibleUnprofiledWorkspaceId,
        serialize(axisVector(20)),
        MODEL,
      ],
    );
    await database.query(
      `INSERT INTO embedding_spaces
         (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
       VALUES ($1, $2, $3, 'openai', $4, ${DIMENSIONS}, 'cosine', 'none', 'active')`,
      [spaceId, `parity-fp-${spaceId}`, `parity-scope-${spaceId}`, MODEL],
    );
    await database.query(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
       VALUES ($1, $2)`,
      [workspaceId, spaceId],
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
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [spaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertChunk = async (
    axis: number,
    options: { canonical: boolean; embeddingModel?: string },
  ): Promise<string> => {
    const chunkId = randomUUID();
    const vector = serialize(axisVector(axis));
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, embedding, embedding_model, start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, $4, 'chunk text', 'chunk text', $5::vector, $6, 0, 10, '{}'::jsonb)`,
      [chunkId, documentId, workspaceId, axis, vector, options.embeddingModel ?? MODEL],
    );
    if (options.canonical) {
      await database.query(
        `INSERT INTO chunk_embeddings
           (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
         VALUES ($1, $2, $3, 1, 1, ${DIMENSIONS}, $4::vector, 'hash')`,
        [workspaceId, chunkId, spaceId, vector],
      );
    }
    return chunkId;
  };

  const measure = async (options: { topK?: number; exact?: Database | null } = {}) => {
    const targets = await resolveParityTargets(database, [workspaceId]);
    const target = targets[0];
    expect(target).toBeDefined();
    const probeVectors = await sampleProbeVectors(database, target!, 10, "test-seed");
    return {
      probeVectors,
      measurement: await measureWorkspaceParity({
        target: target!,
        probeVectors,
        topK: options.topK ?? 10,
        database,
        exactDatabase: options.exact ?? null,
      }),
    };
  };

  it("resolves every eligible workspace with an active embedding space when none is named", async () => {
    // The default CLI run passes no --workspace, so this is the path an operator
    // actually takes; the filtered form is what every other case here exercises.
    await insertChunk(0, { canonical: true });
    const targets = await resolveParityTargets(database);

    expect(targets.map((target) => target.workspaceId)).toContain(workspaceId);
    expect(targets.find((target) => target.workspaceId === workspaceId)).toMatchObject({
      model: MODEL,
      space: { id: spaceId, dimensions: DIMENSIONS, distanceMetric: "cosine" },
    });
  });

  it("fails selection for an eligible workspace without an active cosine space", async () => {
    const selection = await resolveParityWorkspaceSelection(database);

    expect(selection.missingActiveSpaceWorkspaceIds)
      .toContain(eligibleUnprofiledWorkspaceId);
    expect(selection.zeroRiskWorkspaceIds).not.toContain(eligibleUnprofiledWorkspaceId);
  });

  it("names explicitly requested workspace ids that do not exist", async () => {
    const missingWorkspaceId = randomUUID();

    const selection = await resolveParityWorkspaceSelection(database, [missingWorkspaceId]);

    expect(selection.unresolvedWorkspaceIds).toEqual([missingWorkspaceId]);
  });

  it("treats an existing workspace with zero eligible chunks as zero-risk", async () => {
    const selection = await resolveParityWorkspaceSelection(
      database,
      [emptyUnprofiledWorkspaceId],
    );

    expect(selection).toMatchObject({
      targets: [],
      missingActiveSpaceWorkspaceIds: [],
      unresolvedWorkspaceIds: [],
      zeroRiskWorkspaceIds: [emptyUnprofiledWorkspaceId],
    });
  });

  it("reports full parity when every chunk is projected into chunk_embeddings", async () => {
    for (let axis = 0; axis < 4; axis += 1) {
      await insertChunk(axis, { canonical: true });
    }

    const { probeVectors, measurement } = await measure();

    expect(probeVectors).toHaveLength(4);
    expect(measurement.legacy.summary.meanRecall).toBe(1);
    expect(measurement.legacy.summary.distinctMissingChunks).toBe(0);
    expect(measurement.legacy.summary.topMatchRate).toBe(1);
  });

  it("names the chunks canonical would lose when the projection is incomplete", async () => {
    await insertChunk(0, { canonical: true });
    const legacyOnly = await insertChunk(1, { canonical: false });

    const { measurement } = await measure();

    // This is the failure the gate exists to catch: the legacy leg is still carrying a
    // chunk canonical cannot return, so removing it would make that chunk unreachable.
    expect(measurement.legacy.summary.meanRecall).toBeLessThan(1);
    expect(measurement.legacy.summary.distinctMissingChunks).toBe(1);
    expect(
      measurement.legacy.comparisons.flatMap((comparison) => [...comparison.missingFromCandidate]),
    ).toContain(legacyOnly);
  });

  it("marks the comparison vacuous when the legacy leg matches no rows at all", async () => {
    for (let axis = 0; axis < 3; axis += 1) {
      await insertChunk(axis, { canonical: true, embeddingModel: "some-other-model" });
    }

    const { measurement } = await measure();

    // The legacy query filters on the chunk's recorded embedding model. When that label
    // does not match the workspace's space, every reference ranking comes back empty and
    // recall reads 100% having compared nothing — the run has to say so.
    expect(measurement.legacy.summary.meanRecall).toBe(1);
    expect(measurement.legacy.summary.probesWithEmptyReference)
      .toBe(measurement.legacy.summary.probes);
  });

  it("does not sample a probe for a chunk that has no canonical row", async () => {
    await insertChunk(0, { canonical: true });
    await insertChunk(1, { canonical: false });

    const { probeVectors } = await measure();

    // Probes come from chunk_embeddings, so an uncovered chunk cannot supply one. It
    // still shows up as a miss above, which is why coverage is checked separately
    // rather than inferred from the probe count.
    expect(probeVectors).toHaveLength(1);
  });

  it("treats a workspace whose documents retrieval would not serve as zero-risk", async () => {
    await insertChunk(0, { canonical: true });
    await insertChunk(1, { canonical: false });
    await database.query(
      "UPDATE documents SET retrieval_enabled = FALSE WHERE id = $1",
      [documentId],
    );

    const selection = await resolveParityWorkspaceSelection(database, [workspaceId]);

    // Eligibility is what decides whether retiring the legacy leg can lose anything
    // here. With no retrievable chunk there is nothing to measure and nothing at risk,
    // so the workspace is classified rather than sampled — measuring it would report a
    // vacuous pass over zero probes.
    expect(selection.zeroRiskWorkspaceIds).toContain(workspaceId);
    expect(selection.targets.map((target) => target.workspaceId)).not.toContain(workspaceId);
    expect(selection.missingActiveSpaceWorkspaceIds).not.toContain(workspaceId);
  });

  it("measures the indexed path against an exact scan of the same table", async () => {
    for (let axis = 0; axis < 4; axis += 1) {
      await insertChunk(axis, { canonical: true });
    }
    const exact = openExactSearchDatabase(integrationDatabaseUrl as string);
    expect(exact).not.toBeNull();

    try {
      const { measurement } = await measure({ exact });

      // The exact leg is the same adapter SQL on a connection whose planner cannot
      // reach an index. On this many rows both are exhaustive, so they must agree
      // exactly; the value of the measurement is on a production-sized table.
      expect(measurement.indexRecall).not.toBeNull();
      expect(measurement.indexRecall?.summary.meanRecall).toBe(1);
    } finally {
      await exact?.close();
    }
  });

  it("skips the index-recall leg for a connection string that is not a URL", () => {
    // The setting rides on the connection's options parameter, so a libpq keyword-form
    // DSN cannot carry it. Returning null lets the CLI say so instead of silently
    // measuring the indexed path against itself and reporting perfect recall.
    expect(openExactSearchDatabase("host=localhost dbname=radioso")).toBeNull();
  });
});
