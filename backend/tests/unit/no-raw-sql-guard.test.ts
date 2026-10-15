import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  PGVECTOR_SQL_ALLOWLIST,
  findPgVectorSqlViolations,
  findRawSqlViolations,
  lineHasRawSql,
} from "../../scripts/checkNoRawSql.mjs";

// US4 (spec 093): the raw-SQL guard must trip on real raw execution and stay quiet for Kysely.
describe("no-raw-sql guard", () => {
  it("flags raw pg execution markers", () => {
    expect(lineHasRawSql("const rows = await this.database.query<Row>(`SELECT 1`, []);")).toBe(true);
    expect(lineHasRawSql("await this.database.queryOne('INSERT ...', params);")).toBe(true);
    expect(lineHasRawSql("const r = await this.database.queryOptional<X>(text);")).toBe(true);
    expect(lineHasRawSql("await client.query('DELETE FROM x');")).toBe(true);
  });

  it("does not flag Kysely builder or its sanctioned raw escapes", () => {
    expect(lineHasRawSql("await this.db.selectFrom('agents').selectAll().execute();")).toBe(false);
    expect(lineHasRawSql("await this.db.insertInto('x').values(v).executeTakeFirst();")).toBe(false);
    expect(lineHasRawSql("await this.db.executeQuery(CompiledQuery.raw(text, params));")).toBe(false);
    expect(lineHasRawSql("const frag = sql`now()`;")).toBe(false);
    expect(lineHasRawSql("const x = req.query;")).toBe(false); // property access, not a call
  });

  it("finds pgvector syntax in every source literal while ignoring comments", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "radioso-pgvector-guard-"));
    try {
      writeFileSync(join(fixtureDir, "leakedVectorSql.ts"), [
        "// <=> belongs in this comment, not a SQL literal.",
        "const compiled = CompiledQuery.raw(\"SELECT ce.embedding::text FROM chunk_embeddings ce\", []);",
        "const rawFragment = sql.raw(\"SELECT embedding <=> $1\");",
        "const tagged = sql",
        "  `SELECT embedding::halfvec(3072) FROM chunk_embeddings`;",
        "const separatelyBuilt = \"CREATE INDEX ON chunk_embeddings USING hnsw (embedding)\";",
      ].join("\n"));

      expect(findPgVectorSqlViolations(fixtureDir)).toEqual([
        "leakedVectorSql.ts:2: SELECT ce.embedding::text FROM chunk_embeddings ce",
        "leakedVectorSql.ts:3: SELECT embedding <=> $1",
        "leakedVectorSql.ts:5: SELECT embedding::halfvec(3072) FROM chunk_embeddings",
        "leakedVectorSql.ts:6: CREATE INDEX ON chunk_embeddings USING hnsw (embedding)",
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("keeps the allowlist tight and intentional", () => {
    // Pin the sanctioned set so adding a new raw-SQL home is a deliberate, reviewed change.
    expect([...ALLOWLIST].sort()).toEqual(
      [
        "db/repositories/chunkEmbeddingRepository.ts",
        "db/repositories/documentProcessingJobRepository.ts",
        "db/repositories/vectorIndexWorkRepository.ts",
        "db/runMigrations.ts",
        "modules/connectors/plugins/whatsapp/whatsappPlugin.ts",
        "modules/connectors/services/connectorRegistry.ts",
        "modules/documents/infra/chunkRepository.ts",
        "modules/retrieval/infra/hnswIterativeScan.ts",
        "modules/retrieval/infra/lexicalSearch.ts",
        "modules/retrieval/infra/pgVectorAdapter.ts",
        "shared/infra/database.ts",
        "shared/infra/postgresNotificationListener.ts",
      ].sort(),
    );
  });

  it("keeps pgvector SQL in explicit adapter homes", () => {
    expect([...PGVECTOR_SQL_ALLOWLIST].sort()).toEqual(
      [
        "db/repositories/chunkEmbeddingRepository.ts",
        "db/repositories/vectorIndexWorkRepository.ts",
        "modules/retrieval/infra/chunkEmbeddingVectorIndex.ts",
        "modules/retrieval/infra/hnswIterativeScan.ts",
        "modules/retrieval/infra/pgVectorAdapter.ts",
        "shared/infra/kysely/pgVectorSql.ts",
      ].sort(),
    );
  });

  it("reports zero violations across src/ (the guard is green on the current tree)", () => {
    const srcDir = new URL("../../src", import.meta.url).pathname;
    expect(findRawSqlViolations(srcDir)).toEqual([]);
    expect(findPgVectorSqlViolations(srcDir)).toEqual([]);
  });
});
