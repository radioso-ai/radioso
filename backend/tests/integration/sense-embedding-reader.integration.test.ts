import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import { PostgresSenseEmbeddingReader } from "../../src/modules/retrieval/services/senseGroupingService.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }

  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("PostgresSenseEmbeddingReader", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  // chunks.id is uuid; the read must compare it against a uuid[] bind, not text[].
  // A text[] cast makes Postgres reject the query with "operator does not exist:
  // uuid = text" at execution time, even when no rows match — which broke the
  // retrieval-sense detector before it could ask or pick a sense.
  it("queries chunk embeddings by uuid id without a uuid/text operator error", async () => {
    const reader = new PostgresSenseEmbeddingReader(database.kysely);

    const result = await reader.readChunkEmbeddings({
      workspaceId: randomUUID(),
      chunkIds: [randomUUID(), randomUUID()],
    });

    expect(result.size).toBe(0);
  });

  // Characterizes the vector-as-text read: the pgvector column serializes to the
  // `[a,b,...]` literal and `parsePgVector` maps it back to numbers, scoped to the
  // workspace and its active embedding space.
  it("reads active canonical embeddings scoped to the workspace", async () => {
    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    const documentRepository = new DocumentRepository(database.kysely);
    const chunkRepository = new ChunkRepository(database);

    const account = await accountRepository.create({
      name: "Sense Reader Org",
      email: `sense-reader-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Sense Reader Workspace");
    const otherWorkspace = await workspaceRepository.create(account.id, "Other Workspace");
    const document = await documentRepository.create({
      workspaceId: workspace.id,
      title: "Sense Reader Guide",
      sourceContent: "Sense reader content.",
      markdownContent: "Sense reader content.",
      status: "ready",
    });

    const matchedChunkId = randomUUID();
    await chunkRepository.replaceForDocument(document.id, [
      {
        id: matchedChunkId,
        documentId: document.id,
        workspaceId: workspace.id,
        chunkIndex: 0,
        content: "The first chunk.",
        embedding: [1, 0, 0],
        embeddingModel: "gemini-embedding-001",
        startOffset: 0,
        endOffset: 16,
        createdAt: new Date(),
      },
    ]);
    const activeSpaceId = randomUUID();
    await database.query(
      `INSERT INTO embedding_spaces
         (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
       VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', 3, 'cosine', 'none', 'active')`,
      [activeSpaceId, `sense-reader-fp-${activeSpaceId}`, `sense-reader-scope-${activeSpaceId}`],
    );
    await database.query(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
       VALUES ($1, $2)`,
      [workspace.id, activeSpaceId],
    );
    await database.query(
      `INSERT INTO chunk_embeddings
         (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
       VALUES ($1, $2, $3, 1, 1, 3, '[1,0,0]'::vector, 'hash')`,
      [workspace.id, matchedChunkId, activeSpaceId],
    );

    const reader = new PostgresSenseEmbeddingReader(database.kysely);

    const result = await reader.readChunkEmbeddings({
      workspaceId: workspace.id,
      chunkIds: [matchedChunkId],
    });

    expect(result.size).toBe(1);
    expect(result.get(matchedChunkId)).toEqual([1, 0, 0]);

    // Wrong workspace scope returns nothing even for a real chunk id.
    const scoped = await reader.readChunkEmbeddings({
      workspaceId: otherWorkspace.id,
      chunkIds: [matchedChunkId],
    });
    expect(scoped.size).toBe(0);

    await database.query("DELETE FROM chunk_embeddings WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM chunks WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1 OR id = $2", [workspace.id, otherWorkspace.id]);
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [activeSpaceId]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  // The vectors this reader returns are compared against each other with cosine
  // distance, which is only meaningful inside one embedding space. That constraint is
  // what shapes the canonical read below: it pins to the workspace's active space and
  // requires coverage for the whole batch. A partial vector set could produce a
  // centroid from only some retrieved chunks and lead to a false clarification.
  describe("canonical embeddings", () => {
    const seed = async () => {
      const accountRepository = new AccountRepository(database.kysely);
      const workspaceRepository = new WorkspaceRepository(database.kysely);
      const documentRepository = new DocumentRepository(database.kysely);
      const chunkRepository = new ChunkRepository(database);

      const account = await accountRepository.create({
        name: "Canonical Sense Org",
        email: `canonical-sense-${randomUUID()}@example.com`,
        passwordHash: "hash",
      });
      const workspace = await workspaceRepository.create(account.id, "Canonical Sense Workspace");
      const document = await documentRepository.create({
        workspaceId: workspace.id,
        title: "Canonical Sense Guide",
        sourceContent: "Canonical sense content.",
        markdownContent: "Canonical sense content.",
        status: "ready",
      });

      const firstChunkId = randomUUID();
      const secondChunkId = randomUUID();
      await chunkRepository.replaceForDocument(document.id, [
        {
          id: firstChunkId,
          documentId: document.id,
          workspaceId: workspace.id,
          chunkIndex: 0,
          content: "The first chunk.",
          embedding: [1, 0, 0],
          embeddingModel: "gemini-embedding-001",
          startOffset: 0,
          endOffset: 16,
          createdAt: new Date(),
        },
        {
          id: secondChunkId,
          documentId: document.id,
          workspaceId: workspace.id,
          chunkIndex: 1,
          content: "The second chunk.",
          embedding: [0, 1, 0],
          embeddingModel: "gemini-embedding-001",
          startOffset: 16,
          endOffset: 33,
          createdAt: new Date(),
        },
      ]);

      const activeSpaceId = randomUUID();
      const otherSpaceId = randomUUID();
      for (const spaceId of [activeSpaceId, otherSpaceId]) {
        await database.query(
          `INSERT INTO embedding_spaces
             (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
           VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', 3, 'cosine', 'none', 'active')`,
          [spaceId, `sense-fp-${spaceId}`, `sense-scope-${spaceId}`],
        );
      }
      await database.query(
        `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
         VALUES ($1, $2)`,
        [workspace.id, activeSpaceId],
      );

      return { account, workspace, document, firstChunkId, secondChunkId, activeSpaceId, otherSpaceId };
    };

    const insertCanonical = async (input: {
      workspaceId: string;
      chunkId: string;
      spaceId: string;
      vector: number[];
    }) => {
      await database.query(
        `INSERT INTO chunk_embeddings
           (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
         VALUES ($1, $2, $3, 1, 1, $4, $5::vector, 'hash')`,
        [input.workspaceId, input.chunkId, input.spaceId, input.vector.length, `[${input.vector.join(",")}]`],
      );
    };

    const cleanUp = async (accountId: string, workspaceId: string, spaceIds: string[]) => {
      await database.query("DELETE FROM chunk_embeddings WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
      await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
      await database.query("DELETE FROM chunks WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
      await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
      await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
      await database.query("DELETE FROM embedding_spaces WHERE id = ANY($1)", [spaceIds]).catch(() => undefined);
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    };

    it("returns canonical vectors when coverage is complete", async () => {
      const s = await seed();
      await insertCanonical({ workspaceId: s.workspace.id, chunkId: s.firstChunkId, spaceId: s.activeSpaceId, vector: [0, 0, 1] });
      await insertCanonical({ workspaceId: s.workspace.id, chunkId: s.secondChunkId, spaceId: s.activeSpaceId, vector: [0, 0, -1] });

      const reader = new PostgresSenseEmbeddingReader(database.kysely);
      const result = await reader.readChunkEmbeddings({
        workspaceId: s.workspace.id,
        chunkIds: [s.firstChunkId, s.secondChunkId],
      });

      expect(result.get(s.firstChunkId)).toEqual([0, 0, 1]);
      expect(result.get(s.secondChunkId)).toEqual([0, 0, -1]);

      await cleanUp(s.account.id, s.workspace.id, [s.activeSpaceId, s.otherSpaceId]);
    });

    it("disables grouping when one requested chunk is uncovered", async () => {
      const s = await seed();
      await insertCanonical({ workspaceId: s.workspace.id, chunkId: s.firstChunkId, spaceId: s.activeSpaceId, vector: [0, 0, 1] });

      const reader = new PostgresSenseEmbeddingReader(database.kysely);
      const result = await reader.readChunkEmbeddings({
        workspaceId: s.workspace.id,
        chunkIds: [s.firstChunkId, s.secondChunkId],
      });

      expect(result).toEqual(new Map());

      await cleanUp(s.account.id, s.workspace.id, [s.activeSpaceId, s.otherSpaceId]);
    });

    it("counts duplicate chunk ids once when checking coverage", async () => {
      const s = await seed();
      await insertCanonical({ workspaceId: s.workspace.id, chunkId: s.firstChunkId, spaceId: s.activeSpaceId, vector: [0, 0, 1] });

      const reader = new PostgresSenseEmbeddingReader(database.kysely);
      const result = await reader.readChunkEmbeddings({
        workspaceId: s.workspace.id,
        chunkIds: [s.firstChunkId, s.firstChunkId],
      });

      expect(result).toEqual(new Map([[s.firstChunkId, [0, 0, 1]]]));

      await cleanUp(s.account.id, s.workspace.id, [s.activeSpaceId, s.otherSpaceId]);
    });

    it("ignores canonical rows filed under a space the workspace is not using", async () => {
      const s = await seed();
      await insertCanonical({ workspaceId: s.workspace.id, chunkId: s.firstChunkId, spaceId: s.otherSpaceId, vector: [0, 0, 1] });
      await insertCanonical({ workspaceId: s.workspace.id, chunkId: s.secondChunkId, spaceId: s.otherSpaceId, vector: [0, 0, -1] });

      const reader = new PostgresSenseEmbeddingReader(database.kysely);
      const result = await reader.readChunkEmbeddings({
        workspaceId: s.workspace.id,
        chunkIds: [s.firstChunkId, s.secondChunkId],
      });

      expect(result).toEqual(new Map());

      await cleanUp(s.account.id, s.workspace.id, [s.activeSpaceId, s.otherSpaceId]);
    });
  });
});
