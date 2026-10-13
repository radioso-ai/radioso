import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { runMigrations } from "../../src/db/runMigrations.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { runTestMigrationsBefore, testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "216_drop_legacy_chunk_vectors.sql";

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedUrl = (base: string, databaseName: string): string => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const silentLogger = createLogger("silent");

const recordMigrationsBefore216 = async (database: Database): Promise<void> => {
  const migrationFiles = (await readdir(testMigrationsPath))
    .filter((file) => file.endsWith(".sql") && file < migrationFile)
    .sort();

  await database.execute(`
    CREATE TABLE public.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const filename of migrationFiles) {
    await database.execute("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [filename]);
  }
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("legacy chunk vector column drop migration", () => {
  const databaseName = `mig216_${randomUUID().replaceAll("-", "")}`;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const documentId = randomUUID();
  const chunkId = randomUUID();
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, migrationFile);
    await recordMigrationsBefore216(database);

    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig216-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision)
       VALUES ($1, $2, 'Document', 'source', 'markdown', 'ready', 1)`,
      [documentId, workspaceId],
    );
    await database.execute(
      `INSERT INTO chunks (
         id, document_id, workspace_id, chunk_index, content, embedding, embedding_unbounded
       ) VALUES (
         $1, $2, $3, 0, 'Chunk with retired vectors',
         (SELECT array_agg(0.1)::vector FROM generate_series(1, 1536)),
         '[0.2,0.3,0.4]'::vector
       )`,
      [chunkId, documentId, workspaceId],
    );
  }, 120_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("fails within the migration deadline behind a leaf lock, rolls back, then succeeds on retry", async () => {
    expect(
      await database.queryOptional<{ index_name: string }>(
        "SELECT to_regclass('public.chunks_embedding_hnsw_idx')::text AS index_name",
      ),
    ).toEqual({ index_name: "chunks_embedding_hnsw_idx" });

    const lockHolder = await database.pool.connect();
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query("LOCK TABLE chunks_p0 IN ACCESS SHARE MODE");

      const startedAt = performance.now();
      const failure = await runMigrations(
        isolatedUrl(integrationDatabaseUrl!, databaseName),
        silentLogger,
        { lockTimeoutMs: 0, statementTimeoutMs: 0 },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(failure).toMatchObject({ code: "55P03" });
      expect(elapsedMs).toBeLessThan(5_500);
    } finally {
      await lockHolder.query("ROLLBACK").catch(() => undefined);
      lockHolder.release();
    }

    const columnsAfterRollback = await database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chunks'
          AND column_name = ANY(ARRAY['embedding', 'embedding_unbounded', 'embedding_model'])
        ORDER BY column_name`,
    );
    const recordedAfterRollback = await database.queryOptional<{ filename: string }>(
      "SELECT filename FROM public.schema_migrations WHERE filename = $1",
      [migrationFile],
    );

    expect(columnsAfterRollback).toEqual([
      { column_name: "embedding" },
      { column_name: "embedding_model" },
      { column_name: "embedding_unbounded" },
    ]);
    expect(recordedAfterRollback).toBeNull();

    await expect(
      runMigrations(
        isolatedUrl(integrationDatabaseUrl!, databaseName),
        silentLogger,
        { lockTimeoutMs: 0, statementTimeoutMs: 0 },
      ),
    ).resolves.toBeUndefined();

    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chunks'
          AND column_name = ANY(ARRAY['embedding', 'embedding_unbounded', 'embedding_model'])
        ORDER BY column_name`,
    );
    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND (indexname = 'chunks_embedding_hnsw_idx' OR indexname ~ '^chunks_p[0-9]+_embedding_idx$')`,
    );
    const [chunk] = await database.query<{ embedding_model: string; content: string }>(
      "SELECT embedding_model, content FROM chunks WHERE workspace_id = $1 AND id = $2",
      [workspaceId, chunkId],
    );
    const [recordedMigration] = await database.query<{ filename: string }>(
      "SELECT filename FROM public.schema_migrations WHERE filename = $1",
      [migrationFile],
    );

    expect(columns).toEqual([{ column_name: "embedding_model" }]);
    expect(indexes).toEqual([]);
    expect(chunk).toEqual({
      embedding_model: "text-embedding-3-small",
      content: "Chunk with retired vectors",
    });
    expect(recordedMigration).toEqual({ filename: migrationFile });
  });
});
