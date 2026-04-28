import { describe, expect, it } from "vitest";

import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { PgVectorSearch } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
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
        },
        {
          chunkId: "chunk-2",
          documentId: "doc-2",
          title: "Other",
          content: "Lexical only",
          similarity: 0.6,
        },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      chunkId: "chunk-1",
      retrievalSources: ["semantic_original", "lexical"],
      semanticScore: 0.5,
      lexicalScore: 0.8,
    });
    expect(candidates[0].similarity).toBeGreaterThan(0.8);
    expect(candidates[1]).toMatchObject({
      chunkId: "chunk-2",
      retrievalSources: ["lexical"],
      semanticScore: 0,
      lexicalScore: 0.6,
    });
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
  });

  it("keeps legacy chunks searchable when search_text is null", async () => {
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

    expect(executedSql).toContain("coalesce(c.search_text, c.content, '')");
  });

  it("uses web-search query parsing for phrase and OR-compatible lexical syntax", async () => {
    let executedSql = "";
    const search = new PgLexicalSearch({
      async query(sql: string, params: unknown[]) {
        executedSql = sql;
        expect(params).toEqual(["a1", '"forgot password" OR "reset token"', 5]);
        return [];
      },
    } as never);

    await search.search({
      workspaceId: "a1",
      query: '"forgot password" OR "reset token"',
      topK: 5,
    });

    expect(executedSql).toContain("websearch_to_tsquery('simple', $2)");
  });

  it("uses a materialized CTE and enables iterative scan for filtered semantic retrieval when available", async () => {
    let transactionalQueryCount = 0;
    const statements: string[] = [];
    const search = new PgVectorSearch({
      async query() {
        return [];
      },
      async withTransaction(callback: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) {
        const client = {
          async query(sql: string) {
            statements.push(sql);
            if (sql.startsWith("SET LOCAL")) {
              return { rows: [] };
            }

            transactionalQueryCount += 1;
            expect(sql).toContain("WITH nearest_results AS MATERIALIZED");
            expect(sql).toContain("WHERE c.workspace_id = $1");
            expect(sql).toContain("ORDER BY c.embedding <=> $2::vector ASC");
            expect(sql).toContain("WHERE distance <= $4");
            expect(sql).toContain("AND d.status = 'ready'");
            return { rows: [] };
          },
        };

        return callback(client);
      },
    } as never);

    const results = await search.search({
      workspaceId: "workspace-1",
      queryEmbedding: [0.1, 0.2],
      topK: 2,
      similarityThreshold: 0.2,
    });

    expect(statements[0]).toBe("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(transactionalQueryCount).toBe(1);
    expect(results).toEqual([]);
  });

  it("falls back to the plain filtered query when iterative scan settings are unavailable", async () => {
    let fallbackSql = "";
    const search = new PgVectorSearch({
      async query(sql: string, params: unknown[]) {
        fallbackSql = sql;
        expect(params).toEqual(["workspace-1", "[0.1,0.2]", 2, 0.8]);
        expect(sql).toContain("WITH nearest_results AS MATERIALIZED");
        expect(sql).toContain("WHERE c.workspace_id = $1");
        expect(sql).toContain("AND d.status = 'ready'");
        return [
          {
            chunk_id: "chunk-1",
            document_id: "doc-1",
            title: "Guide",
            content: "Fallback hit",
            search_text: null,
            similarity: 0.81,
            chunk_index: 0,
            start_offset: 0,
            end_offset: 30,
            metadata: {},
          },
        ];
      },
      async withTransaction() {
        throw new Error('unrecognized configuration parameter "hnsw.iterative_scan"');
      },
    } as never);

    const results = await search.search({
      workspaceId: "workspace-1",
      queryEmbedding: [0.1, 0.2],
      topK: 2,
      similarityThreshold: 0.2,
    });

    expect(fallbackSql).toContain("WITH nearest_results AS MATERIALIZED");
    expect(results).toHaveLength(1);
  });

  it("keeps metadata filters inside the nearest-neighbor CTE", async () => {
    const search = new PgVectorSearch({
      async query(_sql: string, params: unknown[]) {
        expect(params).toEqual(["workspace-1", "[0.1,0.2]", 2, 0.8, JSON.stringify({ language: "en" })]);
        return [];
      },
      async withTransaction() {
        throw new Error('unrecognized configuration parameter "hnsw.iterative_scan"');
      },
    } as never);

    const results = await search.search({
      workspaceId: "workspace-1",
      queryEmbedding: [0.1, 0.2],
      topK: 2,
      similarityThreshold: 0.2,
      metadataFilter: { language: "en" },
    });

    expect(results).toEqual([]);
  });
});
