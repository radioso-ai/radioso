import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
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

const applyAsMigrationRunner = async (database: Database): Promise<void> => {
  const migrationSql = await readFile(path.join(testMigrationsPath, migrationFile), "utf8");
  await database.withTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = 0");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query(migrationSql);
  });
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

  it("bounds the ACCESS EXCLUSIVE lock wait while the prior revision serves traffic", async () => {
    const migrationSql = await readFile(path.join(testMigrationsPath, migrationFile), "utf8");

    expect(migrationSql).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect(migrationSql.indexOf("DROP INDEX IF EXISTS chunks_embedding_hnsw_idx")).toBeLessThan(
      migrationSql.indexOf("DROP COLUMN IF EXISTS embedding"),
    );
  });

  it("drops the retired columns and their partitioned HNSW indexes while retaining chunk state", async () => {
    expect(
      await database.queryOptional<{ index_name: string }>(
        "SELECT to_regclass('public.chunks_embedding_hnsw_idx')::text AS index_name",
      ),
    ).toEqual({ index_name: "chunks_embedding_hnsw_idx" });

    await applyAsMigrationRunner(database);

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

    expect(columns).toEqual([{ column_name: "embedding_model" }]);
    expect(indexes).toEqual([]);
    expect(chunk).toEqual({
      embedding_model: "text-embedding-3-small",
      content: "Chunk with retired vectors",
    });
  });
});
