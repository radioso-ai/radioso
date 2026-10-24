import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { Database } from "../../../shared/infra/database.js";
import { buildPlainLexicalQueryPlan } from "../domain/lexicalQueryPlan.js";
import {
  buildSomeTermsLexicalQuery,
  planSomeTermsRanking,
  type LexicalTermAlternative,
  type SomeTermsLexicalQuery,
  type SomeTermsRankingPlan,
} from "../domain/lexicalSomeTermsMatch.js";
import type { LexicalQueryPlan } from "../domain/retrievalPipelineTypes.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type { VectorMetadataFilter } from "../domain/vectorFilter.js";
import { compilePgChunkFilter } from "./pgChunkFilter.js";
import { retrievableDocumentPredicateSql } from "./documentRetrievalEligibility.js";

export type LexicalSearchInput = {
  workspaceId: string;
  query: string;
  topK: number;
  metadataFilter?: VectorMetadataFilter;
  sourceFilter?: RetrievalSourceFilter;
  lexicalPlan?: LexicalQueryPlan;
};

/**
 * Keyword search over chunk search text. Results hold every query term first; when too
 * few chunks do, chunks holding part of the query follow, each tagged with its
 * `lexicalTermCoverage`.
 */
export interface LexicalSearchPort {
  search(input: LexicalSearchInput): Promise<RetrievedChunk[]>;
}

interface LexicalSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  search_text: string | null;
  chunk_index: number;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown> | null;
  rank: number;
}

interface SomeTermsSearchRow extends LexicalSearchRow {
  covered_weight: number;
  covers_all_terms: boolean;
}

// Must stay textually equivalent to chunks_search_text_fts_idx, or Postgres cannot use
// the GIN index and seq-scans every partition. Migration 144 backfilled search_text so
// dropping the content fallback does not change which chunks are searchable.
const CHUNK_SEARCH_VECTOR_SQL = "to_tsvector('simple', coalesce(c.search_text, ''))";

export class PgLexicalSearch implements LexicalSearchPort {
  constructor(private readonly database: Database) {}

  async search(input: LexicalSearchInput): Promise<RetrievedChunk[]> {
    const normalizedQuery = input.query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const plan = input.lexicalPlan ?? buildPlainLexicalQueryPlan(normalizedQuery);
    const allTermsMatches = await this.searchAllTerms(input, plan);
    const enoughAllTermsMatches = Math.min(input.topK, RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsBelowAllTermsMatches);
    if (allTermsMatches.length >= enoughAllTermsMatches) {
      return allTermsMatches;
    }

    const someTermsQuery = buildSomeTermsLexicalQuery(plan);
    if (!someTermsQuery) {
      return allTermsMatches;
    }

    const found = new Set(allTermsMatches.map((match) => match.chunkId));
    const someTermsMatches = await this.searchSomeTerms(input, someTermsQuery, input.topK + found.size);
    return [
      ...allTermsMatches,
      ...someTermsMatches.filter((match) => !found.has(match.chunkId)),
    ].slice(0, input.topK);
  }

  private async searchAllTerms(input: LexicalSearchInput, plan: LexicalQueryPlan): Promise<RetrievedChunk[]> {
    const compiledPlan = compilePostgresLexicalPlan(plan);
    if (!compiledPlan) {
      return [];
    }

    const params: unknown[] = [input.workspaceId];
    const chunkFilterClause = compilePgChunkFilter(input, params);

    let querySql = compiledPlan.sql;
    compiledPlan.params.forEach((value, index) => {
      params.push(value);
      const token = `__LEXICAL_PARAM_${index}__`;
      const placeholder = `$${params.length}`;
      querySql = {
        where: querySql.where.replaceAll(token, placeholder),
        rank: querySql.rank.replaceAll(token, placeholder),
      };
    });
    params.push(input.topK);

    const rows = await this.database.query<LexicalSearchRow>(
      `WITH searchable_chunks AS (
         SELECT c.id AS chunk_id,
                c.document_id,
                d.title,
                c.content,
                c.search_text,
                c.chunk_index,
                c.start_offset,
                c.end_offset,
                c.metadata,
                ${CHUNK_SEARCH_VECTOR_SQL} AS search_vector
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.workspace_id = $1
           AND ${retrievableDocumentPredicateSql("d")}
           ${chunkFilterClause}
       )
       SELECT c.chunk_id,
              c.document_id,
              c.title,
              c.content,
              c.search_text,
              c.chunk_index,
              c.start_offset,
              c.end_offset,
              c.metadata,
              ${querySql.rank} AS rank
       FROM searchable_chunks c
       WHERE ${querySql.where}
       ORDER BY rank DESC, c.chunk_index ASC
       LIMIT $${params.length}`,
      params,
    );

    const maxRank = rows.reduce((highest, row) => Math.max(highest, Number(row.rank)), 0);

    return rows.map((row) => ({
      ...toRetrievedChunk(row),
      similarity: normalizeLexicalRank(Number(row.rank), maxRank),
      lexicalTermCoverage: "all_terms" as const,
    }));
  }

  /**
   * Two statements: count each alternative's matches (capped, so a frequent word costs
   * little), then rank the chunks the rarer alternatives find by the share of the
   * query's term weight they hold, breaking ties with ts_rank_cd.
   */
  private async searchSomeTerms(
    input: LexicalSearchInput,
    query: SomeTermsLexicalQuery,
    limit: number,
  ): Promise<RetrievedChunk[]> {
    const behavior = RETRIEVAL_BEHAVIOR.hybrid;
    const alternativeMatchCounts = await this.countAlternativeMatches(input, query, behavior.lexicalSomeTermsTermMatchCap);
    const ranking = planSomeTermsRanking({
      query,
      alternativeMatchCounts,
      matchCap: behavior.lexicalSomeTermsTermMatchCap,
      rankedChunkBudget: behavior.lexicalSomeTermsRankedChunkBudget,
      minimumWeightShare: behavior.lexicalSomeTermsMinimumWeightShare,
    });
    if (!ranking) {
      return [];
    }

    const rows = await this.rankSomeTermsMatches(input, query, ranking, limit);
    return rows.map((row) => ({
      ...toRetrievedChunk(row),
      similarity: Math.max(0, Math.min(1, Number(row.covered_weight) / ranking.totalWeight)),
      lexicalTermCoverage: row.covers_all_terms ? "all_terms" as const : "some_terms" as const,
    }));
  }

  private async countAlternativeMatches(
    input: LexicalSearchInput,
    query: SomeTermsLexicalQuery,
    matchCap: number,
  ): Promise<number[]> {
    const params: unknown[] = [input.workspaceId];
    const chunkFilterClause = compilePgChunkFilter(input, params);
    const bind = bindParam(params);
    const countLimit = bind(matchCap + 1);
    const counts = query.alternatives.map((alternative) => `(
      SELECT count(*)
      FROM (
        SELECT 1
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.workspace_id = $1
          AND ${retrievableDocumentPredicateSql("d")}
          ${chunkFilterClause}
          AND ${CHUNK_SEARCH_VECTOR_SQL} @@ ${alternativeTsquery(alternative, bind)}
        LIMIT ${countLimit}
      ) alternative_matches
    )`);

    const rows = await this.database.query<{ counts: number[] | null }>(
      `SELECT ARRAY[${counts.join(",\n")}]::int[] AS counts`,
      params,
    );
    return (rows[0]?.counts ?? []).map(Number);
  }

  private async rankSomeTermsMatches(
    input: LexicalSearchInput,
    query: SomeTermsLexicalQuery,
    ranking: SomeTermsRankingPlan,
    limit: number,
  ): Promise<SomeTermsSearchRow[]> {
    const params: unknown[] = [input.workspaceId];
    const chunkFilterClause = compilePgChunkFilter(input, params);
    const bind = bindParam(params);
    const alternativeSql = query.alternatives.map((alternative) => alternativeTsquery(alternative, bind));
    const matchingSql = ranking.matchingAlternatives.map((index) => alternativeSql[index]).join(" || ");
    const anyAlternativeSql = alternativeSql.join(" || ");
    const termIndexes = Array.from({ length: query.termCount }, (_, termIndex) => termIndex);
    const termHitSql = termIndexes.map((termIndex) => {
      const covering = query.alternatives
        .map((alternative, index) => (alternative.covers.includes(termIndex) ? alternativeSql[index] : null))
        .filter((sql): sql is string => sql !== null);
      return `(${covering.join(" || ")}) @@ m.search_vector AS term_${termIndex}`;
    });
    const exclusionSql = query.excludedTerms.length > 0
      ? query.excludedTerms
          .map((term) => `NOT (plainto_tsquery('simple', ${bind(term)}) @@ m.search_vector)`)
          .join(" AND ")
      : "TRUE";
    const termWeights = bind(ranking.termWeights);
    const coveredWeightSql = termIndexes
      .map((termIndex) => `CASE WHEN t.term_${termIndex} THEN (${termWeights}::float8[])[${termIndex + 1}] ELSE 0 END`)
      .join(" + ");
    const coversAllTermsSql = termIndexes.map((termIndex) => `t.term_${termIndex}`).join(" AND ");
    const minimumCoveredWeight = bind(ranking.minimumCoveredWeight);
    const rowLimit = bind(limit);

    return this.database.query<SomeTermsSearchRow>(
      `WITH matched AS MATERIALIZED (
         SELECT c.id AS chunk_id,
                c.document_id,
                d.title,
                c.content,
                c.search_text,
                c.chunk_index,
                c.start_offset,
                c.end_offset,
                c.metadata,
                ${CHUNK_SEARCH_VECTOR_SQL} AS search_vector
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.workspace_id = $1
           AND ${retrievableDocumentPredicateSql("d")}
           ${chunkFilterClause}
           AND ${CHUNK_SEARCH_VECTOR_SQL} @@ (${matchingSql})
       ),
       term_hits AS (
         SELECT m.*,
                ${termHitSql.join(",\n                ")}
         FROM matched m
         WHERE ${exclusionSql}
       ),
       scored AS (
         SELECT t.chunk_id,
                t.document_id,
                t.title,
                t.content,
                t.search_text,
                t.chunk_index,
                t.start_offset,
                t.end_offset,
                t.metadata,
                ${coveredWeightSql} AS covered_weight,
                (${coversAllTermsSql}) AS covers_all_terms,
                ts_rank_cd(t.search_vector, ${anyAlternativeSql}) AS rank
         FROM term_hits t
       )
       SELECT *
       FROM scored
       WHERE covered_weight >= ${minimumCoveredWeight}
       ORDER BY covered_weight DESC, rank DESC, chunk_index ASC
       LIMIT ${rowLimit}`,
      params,
    );
  }
}

const toRetrievedChunk = (row: LexicalSearchRow): Omit<RetrievedChunk, "similarity"> => ({
  chunkId: row.chunk_id,
  documentId: row.document_id,
  title: row.title,
  content: row.content,
  searchText: row.search_text,
  lexicalRankScore: normalizeAbsoluteLexicalRank(Number(row.rank)),
  chunkIndex: row.chunk_index,
  startOffset: row.start_offset,
  endOffset: row.end_offset,
  metadata: row.metadata ?? {},
});

const bindParam = (params: unknown[]) => (value: unknown): string => {
  params.push(value);
  return `$${params.length}`;
};

// Alternative text reaches Postgres only as a bound plain-text argument, which
// plainto_tsquery and phraseto_tsquery parse as words, never as tsquery operators.
const alternativeTsquery = (alternative: LexicalTermAlternative, bind: (value: unknown) => string): string =>
  alternative.kind === "phrase"
    ? `phraseto_tsquery('simple', ${bind(alternative.text)})`
    : `plainto_tsquery('simple', ${bind(alternative.text)})`;

const normalizeLexicalRank = (rank: number, maxRank: number): number => {
  if (!Number.isFinite(rank) || rank <= 0 || maxRank <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, rank / maxRank));
};

const normalizeAbsoluteLexicalRank = (rank: number): number =>
  Number.isFinite(rank) && rank > 0 ? rank : 0;

type CompiledLexicalPlan = {
  sql: {
    where: string;
    rank: string;
  };
  params: string[];
};

const compilePostgresLexicalPlan = (plan: LexicalQueryPlan): CompiledLexicalPlan | null => {
  const params: string[] = [];
  const addParam = (value: string): string => {
    params.push(value);
    return `__LEXICAL_PARAM_${params.length - 1}__`;
  };
  const optionClauses = plan.options
    .map((option) => {
      const positiveQueries: string[] = [];
      const requiredTerms = option.requiredTerms.join(" ").trim();
      if (requiredTerms) {
        positiveQueries.push(`plainto_tsquery('simple', ${addParam(requiredTerms)})`);
      }

      for (const phrase of option.phrases) {
        positiveQueries.push(`phraseto_tsquery('simple', ${addParam(phrase)})`);
      }

      if (positiveQueries.length === 0) {
        return null;
      }

      const negativeQueries = option.excludedTerms.map((term) => {
        return `plainto_tsquery('simple', ${addParam(term)})`;
      });

      return {
        where: [
          ...positiveQueries.map((query) => `${query} @@ c.search_vector`),
          ...negativeQueries.map((query) => `NOT (${query} @@ c.search_vector)`),
        ].join(" AND "),
        rank: positiveQueries.map((query) => `ts_rank_cd(c.search_vector, ${query})`).join(" + "),
      };
    })
    .filter((option): option is { where: string; rank: string } => option !== null);

  if (optionClauses.length === 0) {
    return null;
  }

  return {
    sql: {
      where: optionClauses.map((option) => `(${option.where})`).join(" OR "),
      rank: `GREATEST(${optionClauses.map((option) => `CASE WHEN ${option.where} THEN ${option.rank} ELSE 0 END`).join(", ")})`,
    },
    params,
  };
};
