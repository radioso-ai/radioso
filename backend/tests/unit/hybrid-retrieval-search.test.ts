import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { deriveLexicalQueryPlan } from "../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { renderSearchText } from "../../src/modules/retrieval/services/searchTextRenderer.js";

describe("hybrid retrieval search", () => {
  it("renders normalized search text in stable order", () => {
    expect(
      renderSearchText({
        title: "  Session Cookie ",
        sectionPath: " Auth  > Tokens ",
        attributeText: " date: 2026-03-14 ",
        content: " Used   for   login. ",
      }),
    ).toBe("Title: Session Cookie\n\nSection: Auth > Tokens\n\nAttributes: date: 2026-03-14\n\nUsed for login.");
  });

  it("merges semantic and lexical candidates by chunk id while retaining provenance", () => {
    const candidates = new CandidatePreparationService().prepare({
      original: [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          title: "Guide",
          content: "Semantic content",
          similarity: 0.5,
        },
      ],
      rewritten: [],
      lexical: [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          title: "Guide",
          content: "Semantic content",
          similarity: 0.8,
          lexicalRankScore: 0.4,
        },
        {
          chunkId: "chunk-2",
          documentId: "doc-2",
          title: "Other",
          content: "Lexical only",
          similarity: 0.6,
          lexicalRankScore: 0.2,
        },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      chunkId: "chunk-1",
      retrievalSources: ["semantic_original", "lexical"],
      semanticScore: 0.5,
      lexicalScore: 0.8,
      lexicalRankScore: 0.4,
      fusedScore: 1,
    });
    expect(candidates[0].similarity).toBe(1);
    expect(candidates[1]).toMatchObject({
      chunkId: "chunk-2",
      retrievalSources: ["lexical"],
      semanticScore: 0,
      lexicalScore: 0.6,
    });
  });

  it("does not let a query-relative lexical top hit outrank strong semantic evidence", () => {
    const candidates = new CandidatePreparationService().prepare({
      original: [
        {
          chunkId: "strong-semantic",
          documentId: "semantic-doc",
          title: "Strong semantic result",
          content: "Strong semantic evidence",
          similarity: 0.91,
        },
      ],
      rewritten: [],
      lexical: [
        {
          chunkId: "junk-lexical",
          documentId: "lexical-doc",
          title: "Weak lexical result",
          content: "Weak lexical evidence",
          similarity: 1,
          lexicalRankScore: 0.001,
        },
      ],
    });

    expect(candidates.map((candidate) => candidate.chunkId)).toEqual([
      "strong-semantic",
      "junk-lexical",
    ]);
    expect(candidates.every((candidate) =>
      (candidate.fusedScore ?? -1) >= 0 && (candidate.fusedScore ?? 2) <= 1,
    )).toBe(true);
  });

  it("keeps an explicit bounded rank-up for candidates found by both sources", () => {
    const candidates = new CandidatePreparationService().prepare({
      original: [
        {
          chunkId: "semantic-only",
          documentId: "semantic-only-doc",
          title: "Semantic only",
          content: "Semantic only",
          similarity: 0.95,
        },
        {
          chunkId: "dual-source",
          documentId: "dual-source-doc",
          title: "Dual source",
          content: "Dual source",
          similarity: 0.9,
        },
      ],
      rewritten: [],
      lexical: [
        {
          chunkId: "dual-source",
          documentId: "dual-source-doc",
          title: "Dual source",
          content: "Dual source",
          similarity: 1,
          lexicalRankScore: 0.5,
        },
      ],
    });

    expect(candidates[0]?.chunkId).toBe("dual-source");
    expect(candidates[0]?.fusedScore).toBeGreaterThan(candidates[1]?.fusedScore ?? 0);
    expect(candidates[0]?.fusedScore).toBeLessThanOrEqual(1);
    expect(candidates[0]?.similarity).toBe(candidates[0]?.fusedScore);
  });

  it("uses fused ordering when reranking returns no valid scores", async () => {
    const candidates = new CandidatePreparationService().prepare({
      original: [
        {
          chunkId: "strong-semantic",
          documentId: "semantic-doc",
          title: "Strong semantic result",
          content: "Strong semantic evidence",
          similarity: 0.91,
        },
      ],
      rewritten: [],
      lexical: [
        {
          chunkId: "junk-lexical",
          documentId: "lexical-doc",
          title: "Weak lexical result",
          content: "Weak lexical evidence",
          similarity: 1,
          lexicalRankScore: 0.001,
        },
      ],
    });
    const rerank = new RerankService({
      async rerank() {
        return [];
      },
    });

    const result = await rerank.rerank({
      query: "evidence",
      contexts: candidates,
      enabled: true,
      topK: 2,
    });

    expect(result.status).toBe("fallback");
    expect(result.contexts.map((candidate) => candidate.chunkId)).toEqual([
      "strong-semantic",
      "junk-lexical",
    ]);
  });

  it("normalizes lexical ranks before they are merged with semantic similarity", async () => {
    const search = new PgLexicalSearch({
      async query() {
        return [
          {
            chunk_id: "chunk-1",
            document_id: "doc-1",
            title: "Guide",
            content: "Top lexical hit",
            search_text: null,
            chunk_index: 0,
            start_offset: 0,
            end_offset: 20,
            rank: 4,
          },
          {
            chunk_id: "chunk-2",
            document_id: "doc-2",
            title: "Guide",
            content: "Weaker lexical hit",
            search_text: null,
            chunk_index: 1,
            start_offset: 21,
            end_offset: 40,
            rank: 1,
          },
        ];
      },
    } as never);

    const results = await search.search({
      workspaceId: "a1",
      query: "guide",
      topK: 5,
    });

    expect(results[0]?.similarity).toBe(1);
    expect(results[1]?.similarity).toBe(0.25);
    expect(results[0]?.lexicalRankScore).toBe(4);
    expect(results[1]?.lexicalRankScore).toBe(1);
  });

  // Legacy chunks with a null search_text stay searchable, but the guarantee now
  // lives in migration 144 rather than in a query-side content fallback: the fallback
  // made the tsvector expression differ from chunks_search_text_fts_idx, which cost
  // the GIN index and seq-scanned every chunk partition on every lexical search.
  it("builds its tsvector from search_text alone so the GIN index applies", async () => {
    let executedSql = "";
    const search = new PgLexicalSearch({
      async query(sql: string) {
        executedSql = sql;
        return [];
      },
    } as never);

    await search.search({
      workspaceId: "a1",
      query: "session cookie",
      topK: 5,
    });

    expect(executedSql).toContain("to_tsvector('simple', coalesce(c.search_text, ''))");
    expect(executedSql).not.toContain("c.content, ''");
  });

  it("backfills legacy null search_text so those chunks stay searchable", async () => {
    const migration = await readFile(
      new URL("../../src/db/migrations/144_chunks_search_text_backfill.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toMatch(/UPDATE\s+chunks/i);
    expect(migration).toMatch(/SET\s+search_text\s*=\s*content/i);
    expect(migration).toMatch(/WHERE\s+search_text\s+IS\s+NULL/i);
  });

  it("compiles phrase and OR-compatible lexical syntax instead of executing raw backend syntax", async () => {
    let executedSql = "";
    const search = new PgLexicalSearch({
      async query(sql: string, params: unknown[]) {
        executedSql = sql;
        expect(params).toEqual(["a1", "forgot password", "reset token", 5]);
        return [];
      },
    } as never);

    await search.search({
      workspaceId: "a1",
      query: '"forgot password" OR "reset token"',
      topK: 5,
      lexicalPlan: deriveLexicalQueryPlan('"forgot password" OR "reset token"'),
    });

    expect(executedSql).toContain("phraseto_tsquery('simple', $2)");
    expect(executedSql).toContain("phraseto_tsquery('simple', $3)");
    expect(executedSql).not.toContain("websearch_to_tsquery");
    expect(executedSql).not.toContain('"forgot password" OR "reset token"');
  });

  it("treats raw lexical query strings as plain text by default", async () => {
    let executedSql = "";
    const search = new PgLexicalSearch({
      async query(sql: string, params: unknown[]) {
        executedSql = sql;
        expect(params).toEqual(["a1", "What does OR mean? -expired", 5]);
        return [];
      },
    } as never);

    await search.search({
      workspaceId: "a1",
      query: "What does OR mean? -expired",
      topK: 5,
    });

    expect(executedSql).toContain("plainto_tsquery('simple', $2)");
    expect(executedSql).not.toContain("phraseto_tsquery");
    expect(executedSql).not.toContain("NOT (");
  });

  it("does not bind an unused source id array for manual-only lexical scope", async () => {
    let executedSql = "";
    const search = new PgLexicalSearch({
      async query(sql: string, params: unknown[]) {
        executedSql = sql;
        expect(params).toEqual(["workspace-1", "manual", 5]);
        return [];
      },
    } as never);

    await search.search({
      workspaceId: "workspace-1",
      query: "manual",
      topK: 5,
      sourceFilter: {
        constrained: true,
        sourceIds: [],
        includeUnassignedDocuments: true,
      },
    });

    expect(executedSql).toContain("AND d.source_id IS NULL");
    expect(executedSql).toContain("plainto_tsquery('simple', $2)");
    expect(executedSql).toContain("LIMIT $3");
    expect(executedSql).not.toContain("$4");
  });

  it("compiles exclusions from validated lexical plans as negative term filters", async () => {
    let executedSql = "";
    const search = new PgLexicalSearch({
      async query(sql: string, params: unknown[]) {
        executedSql = sql;
        expect(params).toEqual(["a1", "reset", "expired", 5]);
        return [];
      },
    } as never);

    await search.search({
      workspaceId: "a1",
      query: "reset -expired",
      topK: 5,
      lexicalPlan: deriveLexicalQueryPlan("reset -expired"),
    });

    expect(executedSql).toContain("plainto_tsquery('simple', $2) @@ c.search_vector");
    expect(executedSql).toContain("NOT (plainto_tsquery('simple', $3) @@ c.search_vector)");
  });

});
