import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { deriveLexicalQueryPlan } from "../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { renderSearchText } from "../../src/modules/retrieval/services/searchTextRenderer.js";

type RecordedStatement = { sql: string; params: unknown[] };

// Answers each statement with the next prepared row set, then with no rows.
const recordStatements = (responses: unknown[][] = []) => {
  const calls: RecordedStatement[] = [];
  return {
    calls,
    first: (): RecordedStatement => {
      const [call] = calls;
      if (!call) {
        throw new Error("expected a lexical search statement");
      }
      return call;
    },
    database: {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return responses[calls.length - 1] ?? [];
      },
    } as never,
  };
};

const lexicalRow = (chunkId: string, overrides: Record<string, unknown> = {}) => ({
  chunk_id: chunkId,
  document_id: `${chunkId}-doc`,
  title: chunkId,
  content: `${chunkId} content`,
  search_text: `${chunkId} content`,
  chunk_index: 0,
  start_offset: 0,
  end_offset: 10,
  metadata: {},
  rank: 0.1,
  ...overrides,
});

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

  // A lexical branch returning a single row normalizes that row to 1.0, so the
  // relative fusion gate cannot reject it however weak its absolute rank. What still
  // holds is narrower than a gate: it ties the top semantic hit on fused score and
  // loses the semanticScore tiebreak in compareByFusedScore.
  it("keeps a lone weak lexical hit behind the top semantic hit on the tiebreak", () => {
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
    // The gate admits it: both are rank 1 in their own branch, so both fuse to the
    // same score and only the tiebreak separates them.
    expect(candidates[1].fusedScore).toBe(candidates[0].fusedScore);
    expect(candidates[1].fusedScore).toBeGreaterThan(0);
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
    const statements = recordStatements([[], [{ counts: [3, 3, 0] }], []]);
    const search = new PgLexicalSearch(statements.database);

    await search.search({
      workspaceId: "a1",
      query: "session cookie",
      topK: 5,
    });

    // All-terms search, some-terms counts, some-terms ranking.
    expect(statements.calls).toHaveLength(3);
    for (const { sql } of statements.calls) {
      expect(sql).toContain("to_tsvector('simple', coalesce(c.search_text, ''))");
      expect(sql).not.toContain("c.content, ''");
    }
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
    const statements = recordStatements();
    const search = new PgLexicalSearch(statements.database);

    await search.search({
      workspaceId: "a1",
      query: '"forgot password" OR "reset token"',
      topK: 5,
      lexicalPlan: deriveLexicalQueryPlan('"forgot password" OR "reset token"'),
    });

    const executedSql = statements.first().sql;
    expect(statements.first().params).toEqual(["a1", "forgot password", "reset token", 5]);
    expect(executedSql).toContain("phraseto_tsquery('simple', $2)");
    expect(executedSql).toContain("phraseto_tsquery('simple', $3)");
    expect(executedSql).not.toContain("websearch_to_tsquery");
    expect(executedSql).not.toContain('"forgot password" OR "reset token"');
  });

  it("treats raw lexical query strings as plain text by default", async () => {
    const statements = recordStatements();
    const search = new PgLexicalSearch(statements.database);

    await search.search({
      workspaceId: "a1",
      query: "What does OR mean? -expired",
      topK: 5,
    });

    const executedSql = statements.first().sql;
    expect(statements.first().params).toEqual(["a1", "What does OR mean? -expired", 5]);
    expect(executedSql).toContain("plainto_tsquery('simple', $2)");
    expect(executedSql).not.toContain("phraseto_tsquery");
    expect(executedSql).not.toContain("NOT (");
  });

  it("does not bind an unused source id array for manual-only lexical scope", async () => {
    const statements = recordStatements();
    const search = new PgLexicalSearch(statements.database);

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

    const executedSql = statements.first().sql;
    expect(statements.first().params).toEqual(["workspace-1", "manual", 5]);
    expect(executedSql).toContain("AND d.source_id IS NULL");
    expect(executedSql).toContain("plainto_tsquery('simple', $2)");
    expect(executedSql).toContain("LIMIT $3");
    expect(executedSql).not.toContain("$4");
  });

  it("compiles exclusions from validated lexical plans as negative term filters", async () => {
    const statements = recordStatements();
    const search = new PgLexicalSearch(statements.database);

    await search.search({
      workspaceId: "a1",
      query: "reset -expired",
      topK: 5,
      lexicalPlan: deriveLexicalQueryPlan("reset -expired"),
    });

    const executedSql = statements.first().sql;
    expect(statements.first().params).toEqual(["a1", "reset", "expired", 5]);
    expect(executedSql).toContain("plainto_tsquery('simple', $2) @@ c.search_vector");
    expect(executedSql).toContain("NOT (plainto_tsquery('simple', $3) @@ c.search_vector)");
  });

  it("returns only all-terms matches when enough chunks hold every term", async () => {
    const statements = recordStatements([[lexicalRow("a", { rank: 0.4 }), lexicalRow("b", { rank: 0.2 }), lexicalRow("c", { rank: 0.1 })]]);
    const search = new PgLexicalSearch(statements.database);

    const results = await search.search({ workspaceId: "a1", query: "pernottamento evento", topK: 20 });

    expect(statements.calls).toHaveLength(1);
    expect(results.map((result) => [result.chunkId, result.lexicalTermCoverage])).toEqual([
      ["a", "all_terms"],
      ["b", "all_terms"],
      ["c", "all_terms"],
    ]);
  });

  it("adds some-terms matches after the all-terms ones when too few chunks hold every term", async () => {
    const statements = recordStatements([
      [lexicalRow("exact", { rank: 0.05 })],
      // preventivo, completo, pernottamento, evento, then three joins.
      [{ counts: [0, 120, 4, 201, 0, 0, 0] }],
      [
        lexicalRow("exact", { covered_weight: 9, covers_all_terms: true, rank: 0.3 }),
        lexicalRow("stay", { covered_weight: 6, covers_all_terms: false, rank: 0.2 }),
        lexicalRow("event", { covered_weight: 4, covers_all_terms: false, rank: 0.9 }),
      ],
    ]);
    const search = new PgLexicalSearch(statements.database);

    const results = await search.search({ workspaceId: "a1", query: "preventivo completo pernottamento evento", topK: 20 });

    expect(statements.calls).toHaveLength(3);
    expect(results.map((result) => [result.chunkId, result.lexicalTermCoverage])).toEqual([
      ["exact", "all_terms"],
      ["stay", "some_terms"],
      ["event", "some_terms"],
    ]);
    // The all-terms hit keeps its own query-relative score and absolute rank.
    expect(results[0]).toMatchObject({ similarity: 1, lexicalRankScore: 0.05 });
    // A some-terms hit scores the share of the query's term weight it holds.
    const termWeights = statements.calls[2]?.params.find(
      (param): param is number[] => Array.isArray(param) && param.every((value) => typeof value === "number"),
    );
    const totalWeight = (termWeights ?? []).reduce((sum, weight) => sum + weight, 0);
    expect(termWeights).toHaveLength(4);
    expect(results[1]?.similarity).toBeCloseTo(6 / totalWeight);
    expect(results[2]?.similarity).toBeCloseTo(4 / totalWeight);
    expect(results[1]?.lexicalRankScore).toBeCloseTo(0.2);
  });

  it("searches terms only as plain text, never as tsquery syntax", async () => {
    const statements = recordStatements([[], [{ counts: [1, 1, 1, 0, 0, 0] }], []]);
    const search = new PgLexicalSearch(statements.database);
    const query = "pernottamento & !evento | (coscienti:*";

    await search.search({ workspaceId: "a1", query, topK: 5 });

    expect(statements.calls).toHaveLength(3);
    for (const { sql, params } of statements.calls.slice(1)) {
      // Only the plain-text parsers: to_tsquery would read operators out of the text.
      expect(sql).not.toMatch(/(?<![a-z])to_tsquery\(/);
      expect(sql).not.toContain("::tsquery");
      expect(sql).not.toContain(query);
      expect(params).toEqual(expect.arrayContaining(["pernottamento", "evento", "coscienti"]));
      for (const param of params) {
        if (typeof param === "string" && param !== "a1") {
          expect(param).toMatch(/^[\p{L}\p{M}\p{N}._ ]+$/u);
        }
      }
    }
  });

  it("skips the some-terms search for a one-term query", async () => {
    const statements = recordStatements();
    const search = new PgLexicalSearch(statements.database);

    await search.search({ workspaceId: "a1", query: "Supercoscienti", topK: 20 });

    expect(statements.calls).toHaveLength(1);
  });

  it("ranks nothing when every term is too common to find a chunk on its own", async () => {
    const statements = recordStatements([[], [{ counts: [201, 201, 201, 0, 0] }]]);
    const search = new PgLexicalSearch(statements.database);

    const results = await search.search({ workspaceId: "a1", query: "il di per", topK: 20 });

    expect(statements.calls).toHaveLength(2);
    expect(results).toEqual([]);
  });

});
