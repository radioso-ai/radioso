import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { deriveLexicalQueryPlan } from "../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { renderSearchText } from "../../src/modules/retrieval/services/searchTextRenderer.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

type RecordedStatement = { sql: string; params: unknown[] };

// Answers each search statement with the next prepared row set, then with no rows.
// Statement-timeout settings are recorded apart, so `calls` holds only the searches.
const recordStatements = (
  responses: unknown[][] = [],
  options: { failOn?: (call: RecordedStatement, index: number) => Error | undefined; waitingClients?: number } = {},
) => {
  const calls: RecordedStatement[] = [];
  const timeoutSettings: RecordedStatement[] = [];
  let transactions = 0;
  const run = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes("set_config('statement_timeout'")) {
      timeoutSettings.push({ sql, params });
      return [];
    }
    const call = { sql, params };
    calls.push(call);
    const failure = options.failOn?.(call, calls.length - 1);
    if (failure) {
      throw failure;
    }
    return responses[calls.length - 1] ?? [];
  };
  return {
    calls,
    timeoutSettings,
    transactions: () => transactions,
    first: (): RecordedStatement => {
      const [call] = calls;
      if (!call) {
        throw new Error("expected a lexical search statement");
      }
      return call;
    },
    database: {
      pool: { waitingCount: options.waitingClients ?? 0 },
      query: run,
      async withTransaction<T>(callback: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) {
        transactions += 1;
        return callback({ query: async (sql, params) => ({ rows: await run(sql, params) }) });
      },
    } as never,
  };
};

const statementTimeout = (): Error => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

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

    const { matches: results } = await search.search({
      workspaceId: "a1",
      query: "guide",
      topK: 5,
      matchMode: "all_or_some_terms",
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
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], []]);
    const search = new PgLexicalSearch(statements.database);

    await search.search({
      workspaceId: "a1",
      query: "session cookie",
      topK: 5,
      matchMode: "all_or_some_terms",
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
      matchMode: "all_or_some_terms",
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
      matchMode: "all_or_some_terms",
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
      matchMode: "all_or_some_terms",
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
      matchMode: "all_or_some_terms",
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

    const { matches: results } = await search.search({ workspaceId: "a1", query: "pernottamento evento", topK: 20, matchMode: "all_or_some_terms" });

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
      [{ scope_count: 1000, counts: [0, 120, 4, 201, 0, 0, 0] }],
      [
        lexicalRow("exact", { covered_weight: 5, covers_all_terms: false, rank: 0.3 }),
        lexicalRow("stay", { covered_weight: 3, covers_all_terms: false, rank: 0.2 }),
        lexicalRow("event", { covered_weight: 2, covers_all_terms: false, rank: 0.9 }),
      ],
    ]);
    const search = new PgLexicalSearch(statements.database);

    const { matches: results } = await search.search({ workspaceId: "a1", query: "preventivo completo pernottamento evento", topK: 20, matchMode: "all_or_some_terms" });

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
    expect(results[1]?.similarity).toBeCloseTo(3 / totalWeight);
    expect(results[2]?.similarity).toBeCloseTo(2 / totalWeight);
    expect(results[1]?.lexicalRankScore).toBeCloseTo(0.2);
  });

  it("searches terms only as plain text, never as tsquery syntax", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [1, 1, 1, 0, 0, 0] }], []]);
    const search = new PgLexicalSearch(statements.database);
    const query = "pernottamento & !evento | (coscienti:*";

    await search.search({ workspaceId: "a1", query, topK: 5, matchMode: "all_or_some_terms" });

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

    await search.search({ workspaceId: "a1", query: "Supercoscienti", topK: 20, matchMode: "all_or_some_terms" });

    expect(statements.calls).toHaveLength(1);
  });

  it("ranks nothing when every term is too common to find a chunk on its own", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [201, 201, 201, 0, 0] }]]);
    const search = new PgLexicalSearch(statements.database);

    const result = await search.search({ workspaceId: "a1", query: "il di per", topK: 20, matchMode: "all_or_some_terms" });

    expect(statements.calls).toHaveLength(2);
    expect(result.matches).toEqual([]);
    expect(result.someTermsPass.outcome).toBe("ran");
  });

  it("keeps to the all-terms search when the caller asks for every term", async () => {
    const statements = recordStatements();
    const search = new PgLexicalSearch(statements.database);

    const result = await search.search({
      workspaceId: "a1",
      query: "preventivo completo pernottamento evento",
      topK: 20,
      matchMode: "all_terms",
    });

    expect(statements.calls).toHaveLength(1);
    expect(result).toEqual({ matches: [], someTermsPass: { outcome: "skipped", reason: "all_terms_only", durationMs: 0 } });
  });

  it("reports the some-terms pass as skipped when enough chunks hold every term", async () => {
    const statements = recordStatements([[lexicalRow("a"), lexicalRow("b"), lexicalRow("c")]]);
    const search = new PgLexicalSearch(statements.database);

    const result = await search.search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    expect(result.someTermsPass).toEqual({ outcome: "skipped", reason: "enough_all_terms_matches", durationMs: 0 });
  });

  it("runs the some-terms statements in one transaction, inside what is left of one time budget", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], [lexicalRow("partial", { covered_weight: 1, covers_all_terms: false })]]);
    const search = new PgLexicalSearch(statements.database);

    const result = await search.search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    expect(statements.transactions()).toBe(1);
    expect(statements.timeoutSettings).toHaveLength(2);
    const budgets = statements.timeoutSettings.map(({ params }) => Number.parseInt(String(params[0]), 10));
    expect(budgets[0]).toBeLessThanOrEqual(RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsTimeoutMs);
    expect(budgets[0]).toBeGreaterThan(RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsTimeoutMs - 50);
    expect(budgets[1]).toBeLessThanOrEqual(budgets[0]);
    expect(budgets.every((budget) => budget >= 1)).toBe(true);
    // The setting is local to the transaction, so it never leaks onto the pooled connection.
    expect(statements.timeoutSettings.every(({ sql }) => sql.includes(", true)"))).toBe(true);
    expect(result.someTermsPass.outcome).toBe("ran");
    expect(result.someTermsPass.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.matches.map((match) => match.chunkId)).toEqual(["partial"]);
  });

  it("falls back to the all-terms hits when the some-terms search runs out of time", async () => {
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const statements = recordStatements(
      [[lexicalRow("exact", { rank: 0.2 })], [{ scope_count: 1000, counts: [3, 3, 0] }]],
      { failOn: (_, index) => (index === 2 ? statementTimeout() : undefined) },
    );
    const search = new PgLexicalSearch(statements.database, {
      logger: { warn: (fields, message) => warnings.push({ fields, message }) },
    });

    const result = await search.search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    expect(result.matches.map((match) => [match.chunkId, match.lexicalTermCoverage])).toEqual([["exact", "all_terms"]]);
    expect(result.someTermsPass.outcome).toBe("timed_out");
    expect(warnings).toHaveLength(1);
    expect(Object.keys(warnings[0].fields).sort()).toEqual(["durationMs", "termCount", "timeoutMs", "workspaceId"]);
    expect(JSON.stringify(warnings[0])).not.toContain("alfa");
  });

  it("keeps the all-terms hits when the some-terms search fails for another reason", async () => {
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const statements = recordStatements(
      [[lexicalRow("exact", { rank: 0.2 })]],
      { failOn: (_, index) => (index === 1 ? Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }) : undefined) },
    );
    const search = new PgLexicalSearch(statements.database, {
      logger: { warn: (fields, message) => warnings.push({ fields, message }) },
    });

    const result = await search.search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    expect(result.matches.map((match) => match.chunkId)).toEqual(["exact"]);
    expect(result.someTermsPass.outcome).toBe("failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].fields).toMatchObject({ termCount: 2, sqlState: "57P01" });
    expect(JSON.stringify(warnings[0])).not.toContain("alfa");
    expect(JSON.stringify(warnings[0])).not.toContain("administrator");
  });

  it("skips the some-terms search while other requests wait for a connection", async () => {
    const statements = recordStatements([[]], { waitingClients: 2 });
    const search = new PgLexicalSearch(statements.database);

    const result = await search.search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    expect(statements.calls).toHaveLength(1);
    expect(statements.transactions()).toBe(0);
    expect(result.someTermsPass).toEqual({ outcome: "skipped", reason: "connections_busy", durationMs: 0 });
  });

  it("reports a one-term query's pass as having nothing to relax", async () => {
    const statements = recordStatements();
    const result = await new PgLexicalSearch(statements.database)
      .search({ workspaceId: "a1", query: "Supercoscienti", topK: 20, matchMode: "all_or_some_terms" });

    expect(result.someTermsPass).toEqual({ outcome: "skipped", reason: "nothing_to_relax", durationMs: 0 });
  });

  it("takes its time budget from the constructor when one is given", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], []]);
    await new PgLexicalSearch(statements.database, { someTermsTimeoutMs: 40 })
      .search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    expect(Number.parseInt(String(statements.timeoutSettings[0]?.params[0]), 10)).toBeLessThanOrEqual(40);
  });

  it("counts the chunks in scope alongside each alternative, under the same scope", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], []]);
    await new PgLexicalSearch(statements.database)
      .search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    const countSql = statements.calls[1]?.sql ?? "";
    expect(countSql).toMatch(/AS scope_count/);
    expect(countSql.match(/d\.retrieval_enabled = true/g)).toHaveLength(4);
    expect(statements.calls[1]?.params).toContain(RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsScopeCountCap + 1);
  });

  it("scopes the some-terms statements to the workspace, retrievable documents, and the turn's filters", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], []]);
    const search = new PgLexicalSearch(statements.database);

    await search.search({
      workspaceId: "a1",
      query: "alfa beta",
      topK: 20,
      matchMode: "all_or_some_terms",
      metadataFilter: { language: "it" },
      sourceFilter: { constrained: true, sourceIds: ["source-1"], includeUnassignedDocuments: false },
    });

    expect(statements.calls).toHaveLength(3);
    for (const { sql, params } of statements.calls) {
      expect(sql).toContain("c.workspace_id = $1");
      expect(sql).toContain("d.status = 'ready'");
      expect(sql).toContain("d.retrieval_enabled = true");
      expect(sql).toContain("d.retrieval_expires_at IS NULL OR d.retrieval_expires_at > now()");
      expect(sql).toContain("d.source_id = ANY($2::uuid[])");
      expect(sql).toContain("c.metadata @> $3::jsonb");
      expect(params.slice(0, 3)).toEqual(["a1", ["source-1"], JSON.stringify({ language: "it" })]);
    }
  });

  it("ranks a some-terms chunk against every alternative it holds, on the all-terms scale", async () => {
    const statements = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], []]);
    const search = new PgLexicalSearch(statements.database);

    await search.search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });

    const rankSql = statements.calls[2]?.sql ?? "";
    expect(rankSql).toMatch(/ts_rank_cd\(h\.search_vector, plainto_tsquery\('simple', concat_ws\(' ',/);
    expect(rankSql).toContain("CASE WHEN h.alternative_0 THEN $");
  });

  it("can tag a some-terms chunk as holding every term only when the ranking covers every term", async () => {
    const complete = recordStatements([[], [{ scope_count: 1000, counts: [3, 3, 0] }], []]);
    await new PgLexicalSearch(complete.database)
      .search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });
    expect(complete.calls[2]?.sql).toContain("(h.alternative_0 AND h.alternative_1) AS covers_all_terms");

    // beta matches nothing, so no chunk can hold every term.
    const partial = recordStatements([[], [{ scope_count: 1000, counts: [3, 0, 0] }], []]);
    await new PgLexicalSearch(partial.database)
      .search({ workspaceId: "a1", query: "alfa beta", topK: 20, matchMode: "all_or_some_terms" });
    expect(partial.calls[2]?.sql).toContain("FALSE AS covers_all_terms");
  });

});
