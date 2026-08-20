import { describe, expect, it } from "vitest";

import {
  HALFVEC_HNSW_MAX_DIMENSIONS,
  VECTOR_HNSW_MAX_DIMENSIONS,
  buildChunkEmbeddingIndexName,
  buildChunkEmbeddingIndexSql,
  buildChunkEmbeddingDistanceExpression,
} from "../../../src/modules/retrieval/infra/chunkEmbeddingVectorIndex.js";

// An HNSW expression index is only used when the query's ORDER BY expression is
// textually equivalent to the indexed expression. Index definition and query must
// therefore come from one place; if they drift, the index silently stops being
// used and every search becomes a full scan.

describe("chunk embedding vector index", () => {
  it("uses vector ops at or below the pgvector HNSW dimension cap", () => {
    const sql = buildChunkEmbeddingIndexSql(1536) ?? "";
    expect(sql).toContain("USING hnsw ((embedding::vector(1536)) vector_cosine_ops)");
    expect(sql).toContain("WHERE dimensions = 1536");
  });

  it("switches to halfvec above the cap, which vector HNSW cannot index", () => {
    expect(VECTOR_HNSW_MAX_DIMENSIONS).toBe(2000);
    const sql = buildChunkEmbeddingIndexSql(3072) ?? "";
    expect(sql).toContain("USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)");
    expect(sql).toContain("WHERE dimensions = 3072");
  });

  it("builds the boundary width with vector, not halfvec", () => {
    expect(buildChunkEmbeddingIndexSql(2000) ?? "").toContain("embedding::vector(2000)");
    expect(buildChunkEmbeddingIndexSql(2001) ?? "").toContain("embedding::halfvec(2001)");
  });

  it("stops indexing above the halfvec ceiling instead of emitting DDL that fails", () => {
    // pgvector: "column cannot have more than 4000 dimensions for hnsw index".
    expect(HALFVEC_HNSW_MAX_DIMENSIONS).toBe(4000);
    expect(buildChunkEmbeddingIndexSql(4000) ?? "").toContain("embedding::halfvec(4000)");
    expect(buildChunkEmbeddingIndexSql(4001)).toBeNull();
    expect(buildChunkEmbeddingIndexSql(16_000)).toBeNull();
  });

  it("compares at full precision where no index can exist", () => {
    // Half precision is only worth taking when it buys an index.
    expect(buildChunkEmbeddingDistanceExpression(3072, "$4").operand)
      .toBe("embedding::halfvec(3072)");
    expect(buildChunkEmbeddingDistanceExpression(4001, "$4").operand)
      .toBe("embedding::vector(4001)");
    expect(buildChunkEmbeddingDistanceExpression(16_000, "$4").queryCast)
      .toBe("$4::vector(16000)");
  });

  it("derives the query distance expression from the same rule as the index", () => {
    for (const dimensions of [768, 1536, 2000, 2001, 3072, 4000]) {
      const { operand, queryCast } = buildChunkEmbeddingDistanceExpression(dimensions, "$4");
      // The operand must appear verbatim inside the index definition, or the
      // planner cannot match the two.
      expect(buildChunkEmbeddingIndexSql(dimensions) ?? "").toContain(`(${operand})`);
      expect(queryCast).toContain("$4");
    }
  });

  it("names indexes per width so a new width is additive", () => {
    expect(buildChunkEmbeddingIndexName(1536)).toBe("chunk_embeddings_hnsw_1536_idx");
    expect(buildChunkEmbeddingIndexName(3072)).toBe("chunk_embeddings_hnsw_3072_idx");
  });

  it.each([
    "146_chunk_embeddings_hash_partitions.sql",
  ])("keeps %s building the same DDL as the module", async (migrationFile) => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(
      new URL(`../../../src/db/migrations/${migrationFile}`, import.meta.url),
      "utf8",
    );
    // Select the format() templates that build hnsw DDL by content rather than by
    // position: migration 146 also uses EXECUTE format() to create its partitions.
    const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, " ").trim();
    const templates = migration
      .split("EXECUTE format(")
      .slice(1)
      .map((chunk) => chunk.split(");")[0] ?? "")
      .filter((chunk) => chunk.toLowerCase().includes("hnsw"));
    expect(templates.length, `${migrationFile} hnsw branches`).toBe(2);

    for (const width of [1536, 3072]) {
      const branch = width <= 2000 ? "vector" : "halfvec";
      const template = templates.find((chunk) => chunk.includes(`::${branch}(%s)`)) ?? "";
      const rendered = normalize(
        template
          .replace(/'\s*\n?\s*'/g, "")
          .replace(/^\s*'/, "")
          .replaceAll("%s", String(width))
          .split("',")[0],
      );
      expect(rendered, `${migrationFile} branch for ${branch}`).toContain(
        normalize(`embedding::${branch}(${width})`),
      );
      expect(normalize(buildChunkEmbeddingIndexSql(width) ?? "")).toContain(rendered);
    }
  });

  it("rejects widths that cannot be embedded in SQL as a literal", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16_001]) {
      expect(() => buildChunkEmbeddingIndexSql(bad)).toThrow(/dimension/i);
      expect(() => buildChunkEmbeddingDistanceExpression(bad, "$4")).toThrow(/dimension/i);
    }
  });
});
