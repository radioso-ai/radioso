import { describe, expect, it } from "vitest";

import {
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
    const sql = buildChunkEmbeddingIndexSql(1536);
    expect(sql).toContain("USING hnsw ((embedding::vector(1536)) vector_cosine_ops)");
    expect(sql).toContain("WHERE dimensions = 1536");
  });

  it("switches to halfvec above the cap, which vector HNSW cannot index", () => {
    expect(VECTOR_HNSW_MAX_DIMENSIONS).toBe(2000);
    const sql = buildChunkEmbeddingIndexSql(3072);
    expect(sql).toContain("USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)");
    expect(sql).toContain("WHERE dimensions = 3072");
  });

  it("builds the boundary width with vector, not halfvec", () => {
    expect(buildChunkEmbeddingIndexSql(2000)).toContain("embedding::vector(2000)");
    expect(buildChunkEmbeddingIndexSql(2001)).toContain("embedding::halfvec(2001)");
  });

  it("derives the query distance expression from the same rule as the index", () => {
    for (const dimensions of [768, 1536, 2000, 2001, 3072]) {
      const { operand, queryCast } = buildChunkEmbeddingDistanceExpression(dimensions, "$4");
      // The operand must appear verbatim inside the index definition, or the
      // planner cannot match the two.
      expect(buildChunkEmbeddingIndexSql(dimensions)).toContain(`(${operand})`);
      expect(queryCast).toContain("$4");
    }
  });

  it("names indexes per width so a new width is additive", () => {
    expect(buildChunkEmbeddingIndexName(1536)).toBe("chunk_embeddings_hnsw_1536_idx");
    expect(buildChunkEmbeddingIndexName(3072)).toBe("chunk_embeddings_hnsw_3072_idx");
  });

  it("keeps migration 145 building the same DDL as the module", async () => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(
      new URL(
        "../../../src/db/migrations/145_chunk_embeddings_hnsw_indexes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    // Reduce the migration's format() templates to concrete DDL for a sample width
    // on each side of the 2000-dimension cap, then compare against the module.
    const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, " ").trim();
    for (const width of [1536, 3072]) {
      const branch = width <= 2000 ? "vector" : "halfvec";
      const template = migration
        .split("EXECUTE format(")[width <= 2000 ? 1 : 2]
        ?.split(");")[0] ?? "";
      const rendered = normalize(
        template
          .replace(/'\s*\n?\s*'/g, "")
          .replace(/^\s*'/, "")
          .replaceAll("%s", String(width))
          .split("',")[0],
      );
      expect(rendered, `migration branch for ${branch}`).toContain(
        normalize(`embedding::${branch}(${width})`),
      );
      expect(normalize(buildChunkEmbeddingIndexSql(width))).toContain(rendered);
    }
  });

  it("rejects widths that cannot be embedded in SQL as a literal", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16_001]) {
      expect(() => buildChunkEmbeddingIndexSql(bad)).toThrow(/dimension/i);
      expect(() => buildChunkEmbeddingDistanceExpression(bad, "$4")).toThrow(/dimension/i);
    }
  });
});
