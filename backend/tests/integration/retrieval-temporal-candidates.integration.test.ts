import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildChunkEmbeddingDistanceExpression } from "../../src/modules/retrieval/infra/chunkEmbeddingVectorIndex.js";
import { PgTemporalCandidateRepository } from "../../src/modules/retrieval/infra/temporalCandidateRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PgTemporalCandidateRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new PgTemporalCandidateRepository(database);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const sourceId = randomUUID();
  const otherSourceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Temporal Candidates Co", `temporal-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
      [workspaceId, accountId, "Temporal Workspace", `temporal-${workspaceId}`, otherWorkspaceId, "Other Temporal Workspace", `temporal-${otherWorkspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, external_id, config, metadata)
       VALUES ($1, $2, 'website', 'Events', 'events', '{}'::jsonb, '{}'::jsonb),
              ($3, $2, 'website', 'Other Events', 'other-events', '{}'::jsonb, '{}'::jsonb)`,
      [sourceId, workspaceId, otherSourceId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertReadyDocumentWithChunk = async (input: {
    id?: string;
    workspaceId?: string;
    sourceId?: string | null;
    title: string;
    chunkId?: string;
    metadata: Record<string, unknown>;
    retrievalEnabled?: boolean;
    retrievalExpiresAt?: string | null;
  }): Promise<string> => {
    const documentId = input.id ?? randomUUID();
    const chunkId = input.chunkId ?? randomUUID();
    const workspace = input.workspaceId ?? workspaceId;
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, source_id, metadata, retrieval_enabled, retrieval_expires_at)
       VALUES ($1, $2, $3, $4, $4, 'ready', $5, '{}'::jsonb, $6, $7)`,
      [documentId, workspace, input.title, `${input.title} body`, input.sourceId ?? sourceId, input.retrievalEnabled ?? true, input.retrievalExpiresAt ?? null],
    );
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
       VALUES ($1, $2, $3, 0, $4, $4, $5::jsonb)`,
      [chunkId, documentId, workspace, `${input.title} chunk`, JSON.stringify(input.metadata)],
    );
    return chunkId;
  };

  it("returns ongoing and upcoming dated chunks soonest-first within workspace and source scope", async () => {
    const past = await insertReadyDocumentWithChunk({
      title: "Past Event",
      metadata: { dateFrom: "2026-06-01", dateTo: "2026-06-02" },
    });
    const ongoing = await insertReadyDocumentWithChunk({
      title: "Ongoing Event",
      metadata: { dateFrom: "2026-06-30", dateTo: "2026-07-03" },
    });
    const soon = await insertReadyDocumentWithChunk({
      title: "Soon Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
    });
    const later = await insertReadyDocumentWithChunk({
      title: "Later Event",
      metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
    });
    const otherSource = await insertReadyDocumentWithChunk({
      title: "Other Source Event",
      sourceId: otherSourceId,
      metadata: { dateFrom: "2026-07-02", dateTo: "2026-07-02" },
    });
    await insertReadyDocumentWithChunk({
      workspaceId: otherWorkspaceId,
      sourceId: null,
      title: "Other Workspace Event",
      metadata: { dateFrom: "2026-07-02", dateTo: "2026-07-02" },
    });

    const allSources = await repository.findInWindow({
      workspaceId,
      window: { kind: "upcoming", today: "2026-07-02" },
      topK: 10,
    });

    expect(allSources.map((candidate) => candidate.chunkId)).toEqual([ongoing, otherSource, soon, later]);
    expect(allSources.map((candidate) => candidate.chunkId)).not.toContain(past);

    const scoped = await repository.findInWindow({
      workspaceId,
      window: { kind: "upcoming", today: "2026-07-02" },
      topK: 10,
      sourceFilter: {
        constrained: true,
        sourceIds: [sourceId],
        includeUnassignedDocuments: false,
      },
    });

    expect(scoped.map((candidate) => candidate.chunkId)).toEqual([ongoing, soon, later]);
  });

  it("omits disabled and expired documents but keeps a future expiry", async () => {
    const excludedWorkspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [excludedWorkspaceId, accountId, "Excluded Workspace", `temporal-${excludedWorkspaceId}`],
    );

    const included = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Included Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
    });
    const excluded = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Excluded Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
      retrievalEnabled: false,
    });
    const expired = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Expired Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
      retrievalExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    const futureExpiry = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Future Expiry Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
      retrievalExpiresAt: "2999-01-01T00:00:00.000Z",
    });

    const candidates = await repository.findInWindow({
      workspaceId: excludedWorkspaceId,
      window: { kind: "upcoming", today: "2026-07-02" },
      topK: 10,
    });
    const chunkIds = candidates.map((candidate) => candidate.chunkId);

    expect(chunkIds).toContain(included);
    expect(chunkIds).toContain(futureExpiry);
    expect(chunkIds).not.toContain(excluded);
    expect(chunkIds).not.toContain(expired);
  });

  const createWorkspace = async (name: string): Promise<string> => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [id, accountId, name, `temporal-${id}`],
    );
    return id;
  };

  const insertReadyDocumentWithChunks = async (input: {
    workspaceId: string;
    title: string;
    chunkCount: number;
    metadata: Record<string, unknown>;
  }): Promise<string[]> => {
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, metadata)
       VALUES ($1, $2, $3, $4, $4, 'ready', '{}'::jsonb)`,
      [documentId, input.workspaceId, input.title, `${input.title} body`],
    );
    const chunkIds: string[] = [];
    for (let chunkIndex = 0; chunkIndex < input.chunkCount; chunkIndex += 1) {
      const chunkId = randomUUID();
      await database.query(
        `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
         VALUES ($1, $2, $3, $4, $5, $5, $6::jsonb)`,
        [chunkId, documentId, input.workspaceId, chunkIndex, `${input.title} part ${chunkIndex}`, JSON.stringify(input.metadata)],
      );
      chunkIds.push(chunkId);
    }
    return chunkIds;
  };

  it("returns the chunks whose dates overlap a requested range, soonest-first", async () => {
    const rangeWorkspaceId = await createWorkspace("Requested Range Workspace");
    const event = async (title: string, metadata: Record<string, unknown>) =>
      (await insertReadyDocumentWithChunks({ workspaceId: rangeWorkspaceId, title, chunkCount: 1, metadata }))[0];

    const endsBefore = await event("Ends Before", { dateFrom: "2026-12-01", dateTo: "2026-12-06" });
    const crossesStart = await event("Crosses Start", { dateFrom: "2026-12-05", dateTo: "2026-12-07" });
    const inside = await event("Inside", { dateFrom: "2026-12-09" });
    const onlyEndDate = await event("Only End Date", { dateTo: "2026-12-10" });
    const crossesEnd = await event("Crosses End", { dateFrom: "2026-12-13", dateTo: "2026-12-20" });
    const spansRange = await event("Spans Range", { dateFrom: "2026-11-01", dateTo: "2027-01-31" });
    const startsAfter = await event("Starts After", { dateFrom: "2026-12-14", dateTo: "2026-12-14" });
    const undated = await event("Undated", {});
    await insertReadyDocumentWithChunks({
      workspaceId: otherWorkspaceId,
      title: "Other Workspace In Range",
      chunkCount: 1,
      metadata: { dateFrom: "2026-12-09", dateTo: "2026-12-09" },
    });

    const candidates = await repository.findInWindow({
      workspaceId: rangeWorkspaceId,
      window: { kind: "requested_range", range: { dateFrom: "2026-12-07", dateTo: "2026-12-13" } },
      topK: 20,
    });
    const chunkIds = candidates.map((candidate) => candidate.chunkId);

    expect(chunkIds).toEqual([spansRange, crossesStart, inside, onlyEndDate, crossesEnd]);
    expect(chunkIds).not.toContain(endsBefore);
    expect(chunkIds).not.toContain(startsAfter);
    expect(chunkIds).not.toContain(undated);
  });

  it("returns every event's first chunk in a requested range before any event's second chunk", async () => {
    const breadthWorkspaceId = await createWorkspace("Requested Range Breadth Workspace");
    const [monday0, monday1, monday2] = await insertReadyDocumentWithChunks({
      workspaceId: breadthWorkspaceId,
      title: "Monday Course",
      chunkCount: 3,
      metadata: { dateFrom: "2026-12-07", dateTo: "2026-12-07" },
    });
    const [tuesday0, tuesday1] = await insertReadyDocumentWithChunks({
      workspaceId: breadthWorkspaceId,
      title: "Tuesday Course",
      chunkCount: 2,
      metadata: { dateFrom: "2026-12-08", dateTo: "2026-12-08" },
    });
    const [wednesday0] = await insertReadyDocumentWithChunks({
      workspaceId: breadthWorkspaceId,
      title: "Wednesday Course",
      chunkCount: 1,
      metadata: { dateFrom: "2026-12-09", dateTo: "2026-12-09" },
    });
    const week = { dateFrom: "2026-12-07", dateTo: "2026-12-13" };

    const firstChunks = await repository.findInWindow({
      workspaceId: breadthWorkspaceId,
      window: { kind: "requested_range", range: week },
      topK: 3,
    });
    const everyChunk = await repository.findInWindow({
      workspaceId: breadthWorkspaceId,
      window: { kind: "requested_range", range: week },
      topK: 10,
    });

    expect(firstChunks.map((candidate) => candidate.chunkId)).toEqual([monday0, tuesday0, wednesday0]);
    expect(everyChunk.map((candidate) => candidate.chunkId)).toEqual([
      monday0,
      tuesday0,
      wednesday0,
      monday1,
      tuesday1,
      monday2,
    ]);
  });

  describe("requested range ordered by similarity to the question", () => {
    const space = { id: randomUUID(), dimensions: 3, distanceMetric: "cosine" as const };
    const week = { dateFrom: "2026-12-07", dateTo: "2026-12-13" };
    const kriya = [1, 0, 0];
    const hatha = [0, 1, 0];

    beforeAll(async () => {
      await database.query(
        `INSERT INTO embedding_spaces
           (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
         VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', 3, 'cosine', 'none', 'active')`,
        [space.id, `temporal-fp-${space.id}`, `temporal-scope-${space.id}`],
      );
    });

    afterAll(async () => {
      await database.query("DELETE FROM chunk_embeddings WHERE embedding_space_id = $1", [space.id]);
      await database.query("DELETE FROM embedding_spaces WHERE id = $1", [space.id]);
    });

    // A one-chunk course document dated `date`, embedded in `space` with `vector` unless
    // it is left unembedded, or embedded for an earlier document revision.
    const course = async (input: {
      workspaceId: string;
      title: string;
      date: string;
      vector?: number[];
      // One vector per chunk, in chunk order, in place of `vector` for every chunk.
      chunkVectors?: number[][];
      chunkCount?: number;
      embeddedRevision?: number;
    }): Promise<string[]> => {
      const chunkIds = await insertReadyDocumentWithChunks({
        workspaceId: input.workspaceId,
        title: input.title,
        chunkCount: input.chunkVectors?.length ?? input.chunkCount ?? 1,
        metadata: { dateFrom: input.date, dateTo: input.date },
      });
      for (const [index, chunkId] of chunkIds.entries()) {
        const vector = input.chunkVectors?.[index] ?? input.vector;
        if (!vector) {
          continue;
        }
        await database.query(
          `INSERT INTO chunk_embeddings
             (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
           VALUES ($1, $2, $3, $4, 1, 3, $5::vector, 'hash')`,
          [input.workspaceId, chunkId, space.id, input.embeddedRevision ?? 1, `[${vector.join(",")}]`],
        );
      }
      return chunkIds;
    };

    it("fills a busy range's depth with the passages closest to the question, not the earliest", async () => {
      const workspace = await createWorkspace("Similarity Range Workspace");
      // Off-topic courses come first by date; on-topic ones come later in the week.
      const [hathaMonday] = await course({ workspaceId: workspace, title: "Hatha Monday", date: "2026-12-07", vector: hatha });
      const [hathaTuesday] = await course({ workspaceId: workspace, title: "Hatha Tuesday", date: "2026-12-08", vector: hatha });
      const [kriyaFriday] = await course({ workspaceId: workspace, title: "Kriya Friday", date: "2026-12-11", vector: [0.9, 0.1, 0] });
      const [kriyaSaturday] = await course({ workspaceId: workspace, title: "Kriya Saturday", date: "2026-12-12", vector: kriya });
      // A perfect match outside the range never qualifies.
      await course({ workspaceId: workspace, title: "Kriya Next Month", date: "2027-01-15", vector: kriya });

      const closest = await repository.findInWindow({
        workspaceId: workspace,
        window: { kind: "requested_range", range: week, similarTo: { space, queryVector: kriya } },
        topK: 2,
      });
      const all = await repository.findInWindow({
        workspaceId: workspace,
        window: { kind: "requested_range", range: week, similarTo: { space, queryVector: kriya } },
        topK: 10,
      });

      expect(closest.map((candidate) => candidate.chunkId)).toEqual([kriyaSaturday, kriyaFriday]);
      // The date filter is the relevance gate: off-topic passages in the range still come back,
      // below the on-topic ones, with no similarity threshold.
      expect(all.map((candidate) => candidate.chunkId)).toEqual([kriyaSaturday, kriyaFriday, hathaMonday, hathaTuesday]);
      expect(all[0]?.similarity).toBeCloseTo(1, 5);
      expect(all[2]?.similarity).toBeCloseTo(0, 5);
    });

    it("keeps breadth first: every event's first passage ahead of a closer second passage", async () => {
      const workspace = await createWorkspace("Similarity Breadth Workspace");
      const [kriya0, kriya1] = await course({ workspaceId: workspace, title: "Kriya Course", date: "2026-12-09", vector: kriya, chunkCount: 2 });
      const [hatha0] = await course({ workspaceId: workspace, title: "Hatha Course", date: "2026-12-10", vector: hatha });

      const candidates = await repository.findInWindow({
        workspaceId: workspace,
        window: { kind: "requested_range", range: week, similarTo: { space, queryVector: kriya } },
        topK: 3,
      });

      expect(candidates.map((candidate) => candidate.chunkId)).toEqual([kriya0, hatha0, kriya1]);
    });

    it("leads each event with its passage closest to the question, whatever its position in the document", async () => {
      const workspace = await createWorkspace("Similarity Tier Workspace");
      // The course's Kriya details sit in its fourth chunk, behind three general chunks.
      const [, , , kriyaDetails] = await course({
        workspaceId: workspace,
        title: "Weekend Course",
        date: "2026-12-12",
        chunkVectors: [hatha, hatha, hatha, kriya],
      });
      const [otherCourse] = await course({ workspaceId: workspace, title: "Other Course", date: "2026-12-08", vector: hatha });

      const candidates = await repository.findInWindow({
        workspaceId: workspace,
        window: { kind: "requested_range", range: week, similarTo: { space, queryVector: kriya } },
        topK: 2,
      });

      expect(candidates.map((candidate) => candidate.chunkId)).toEqual([kriyaDetails, otherCourse]);
      expect(candidates[0]?.content).toBe("Weekend Course part 3");
      expect(candidates[0]?.title).toBe("Weekend Course");
    });

    it("keeps a requested range to the request's document scope", async () => {
      const workspace = await createWorkspace("Similarity Scope Workspace");
      const [inScope] = await course({ workspaceId: workspace, title: "In Scope", date: "2026-12-09", vector: hatha });
      await course({ workspaceId: workspace, title: "Out Of Scope", date: "2026-12-09", vector: kriya });
      const [scopedDocument] = await database.query<{ document_id: string }>(
        "SELECT document_id FROM chunks WHERE id = $1",
        [inScope],
      );

      for (const similarTo of [{ space, queryVector: kriya }, undefined]) {
        const candidates = await repository.findInWindow({
          workspaceId: workspace,
          window: { kind: "requested_range", range: week, ...(similarTo ? { similarTo } : {}) },
          topK: 10,
          documentIds: [scopedDocument.document_id],
        });

        expect(candidates.map((candidate) => candidate.chunkId)).toEqual([inScope]);
      }
    });

    it("puts passages with no current embedding after embedded ones, in date order", async () => {
      const workspace = await createWorkspace("Similarity Unembedded Workspace");
      const [unembeddedEarly] = await course({ workspaceId: workspace, title: "Unembedded Early", date: "2026-12-07" });
      const [staleRevision] = await course({ workspaceId: workspace, title: "Stale Revision", date: "2026-12-08", vector: kriya, embeddedRevision: 2 });
      const [embeddedLate] = await course({ workspaceId: workspace, title: "Embedded Late", date: "2026-12-12", vector: hatha });

      const candidates = await repository.findInWindow({
        workspaceId: workspace,
        window: { kind: "requested_range", range: week, similarTo: { space, queryVector: kriya } },
        topK: 10,
      });

      expect(candidates.map((candidate) => candidate.chunkId)).toEqual([embeddedLate, unembeddedEarly, staleRevision]);
      expect(candidates[1]?.similarity).toBe(0);
    });

    it("orders a requested range by date when the question has no embedding", async () => {
      const workspace = await createWorkspace("Similarity Fallback Workspace");
      const [hathaMonday] = await course({ workspaceId: workspace, title: "Hatha Monday", date: "2026-12-07", vector: hatha });
      const [kriyaSaturday] = await course({ workspaceId: workspace, title: "Kriya Saturday", date: "2026-12-12", vector: kriya });

      const candidates = await repository.findInWindow({
        workspaceId: workspace,
        window: { kind: "requested_range", range: week },
        topK: 10,
      });

      expect(candidates.map((candidate) => candidate.chunkId)).toEqual([hathaMonday, kriyaSaturday]);
    });

    it("sorts the whole date-filtered set exactly even when an HNSW index would return off-range neighbours", async () => {
      const workspace = await createWorkspace("Similarity Exact Sort Workspace");
      // Many closer neighbours outside the range: an index scan that post-filters by date
      // would run out of its search breadth before reaching the in-range passages.
      for (let index = 0; index < 60; index += 1) {
        await course({ workspaceId: workspace, title: `Off Range ${index}`, date: "2027-02-01", vector: kriya });
      }
      const inRange: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const [chunkId] = await course({ workspaceId: workspace, title: `In Range ${index}`, date: "2026-12-09", vector: [0, 1, index / 10] });
        inRange.push(chunkId);
      }
      // The same per-width HNSW expression index the vector adapter builds, under a name
      // this test owns so it can drop it again.
      const indexName = `temporal_exact_sort_${randomUUID().replaceAll("-", "")}`;
      const { operand } = buildChunkEmbeddingDistanceExpression(space.dimensions, "$1");
      await database.query(
        `CREATE INDEX ${indexName} ON chunk_embeddings USING hnsw ((${operand}) vector_cosine_ops) WHERE dimensions = ${space.dimensions}`,
      );
      await database.query("ANALYZE chunk_embeddings");
      // One pooled connection, so the session setting reaches the repository's query: the
      // planner then takes any index it can use.
      const indexPreferring = new Database(integrationDatabaseUrl, { poolMax: 1 });
      try {
        await indexPreferring.query("SET enable_seqscan = off");
        const candidates = await new PgTemporalCandidateRepository(indexPreferring).findInWindow({
          workspaceId: workspace,
          window: { kind: "requested_range", range: week, similarTo: { space, queryVector: kriya } },
          topK: 10,
        });

        expect(new Set(candidates.map((candidate) => candidate.chunkId))).toEqual(new Set(inRange));
      } finally {
        await indexPreferring.close().catch(() => undefined);
        await database.query(`DROP INDEX IF EXISTS ${indexName}`);
      }
    });
  });
});
