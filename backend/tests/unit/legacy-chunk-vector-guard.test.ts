import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  findLegacyChunkVectorReaders,
  lineReadsLegacyChunkVector,
} from "../../scripts/checkLegacyChunkVectorReaders.mjs";

// Issue #1063: every chunk vector is stored twice, in chunks.embedding and in
// chunk_embeddings. Retiring the legacy pair is only mechanical if the set of files
// touching it stays known — the two readers this guard was written for were both
// missing from the retirement plan, and one of them fails silently when the column
// goes. The allowlist is the checklist: when it empties, the columns can be dropped.

describe("legacy chunk vector guard", () => {
  it("flags reads of the legacy embedding columns", () => {
    expect(lineReadsLegacyChunkVector("COALESCE(c.embedding_unbounded, c.embedding)")).toBe(true);
    expect(lineReadsLegacyChunkVector("sql`coalesce(embedding_unbounded::text, embedding::text)`")).toBe(true);
    expect(lineReadsLegacyChunkVector("SELECT vector_dims(embedding_unbounded) FROM chunks")).toBe(true);
    expect(lineReadsLegacyChunkVector("ORDER BY c.embedding <=> $2::vector(1536)")).toBe(true);
    expect(lineReadsLegacyChunkVector("INSERT INTO chunks (id, embedding, embedding_model)")).toBe(true);
  });

  it("flags ordinary SQL and query-builder evasions", () => {
    expect(lineReadsLegacyChunkVector("SELECT embedding FROM chunks")).toBe(true);
    expect(lineReadsLegacyChunkVector("SELECT ch.embedding FROM chunks ch")).toBe(true);
    expect(lineReadsLegacyChunkVector("SELECT C.EMBEDDING FROM chunks C")).toBe(true);
    expect(lineReadsLegacyChunkVector('SELECT "c"."embedding" FROM "chunks" AS "c"')).toBe(true);
    expect(lineReadsLegacyChunkVector('.selectFrom("chunks").select("embedding")')).toBe(true);
  });

  it("flags a multiline chunks insert column list while scanning a file", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "legacy-chunk-vector-guard-"));
    try {
      writeFileSync(
        join(fixtureDir, "reader.ts"),
        `sql\`INSERT INTO chunks (\n  id,\n  embedding,\n  embedding_model\n) VALUES (...)\`;`,
      );

      expect(findLegacyChunkVectorReaders(fixtureDir)).toHaveLength(1);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("does not flag the canonical table that replaces them", () => {
    // chunk_embeddings has its own `embedding` column. Matching it would make the
    // allowlist meaningless, since the replacement reads would all trip the guard.
    expect(lineReadsLegacyChunkVector("FROM chunk_embeddings ce WHERE ce.embedding IS NOT NULL")).toBe(false);
    expect(lineReadsLegacyChunkVector("ce.embedding::vector(1536) <=> $3")).toBe(false);
    expect(lineReadsLegacyChunkVector("await this.db.selectFrom('chunk_embeddings').select('embedding')")).toBe(false);
    expect(lineReadsLegacyChunkVector('SELECT "ce"."embedding" FROM "chunk_embeddings" AS "ce"')).toBe(false);
    expect(lineReadsLegacyChunkVector('.selectFrom("chunk_embeddings").select("embedding")')).toBe(false);
  });

  it("does not flag unrelated embedding vocabulary", () => {
    expect(lineReadsLegacyChunkVector("const embeddingModel = settings.embeddingModel;")).toBe(false);
    expect(lineReadsLegacyChunkVector("embedding_space_id: string;")).toBe(false);
    expect(lineReadsLegacyChunkVector("interface DocumentEmbeddingPort {")).toBe(false);
  });

  it("pins the files still reading the legacy columns, and why", () => {
    // This set may only ever shrink. Each entry names the step of #1063 that removes
    // it; when the set is empty the columns and this guard go together.
    expect([...ALLOWLIST.keys()].sort()).toEqual(
      [
        "modules/documents/infra/chunkRepository.ts",
        "modules/retrieval/infra/chunkVectorStorage.ts",
        "modules/retrieval/infra/vectorSearch.ts",
        "modules/retrieval/services/senseGroupingService.ts",
      ].sort(),
    );
    for (const reason of ALLOWLIST.values()) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("reports zero violations across src/ (the guard is green on the current tree)", () => {
    const srcDir = new URL("../../src", import.meta.url).pathname;
    expect(findLegacyChunkVectorReaders(srcDir)).toEqual([]);
  });
});
