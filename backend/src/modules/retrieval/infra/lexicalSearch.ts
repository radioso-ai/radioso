import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { Database } from "../../../shared/infra/database.js";
import { buildPlainLexicalQueryPlan } from "../domain/lexicalQueryPlan.js";
import {
  buildSomeTermsLexicalQuery,
  planSomeTermsRanking,
  skippedSomeTermsPass,
  type LexicalMatchMode,
  type LexicalSomeTermsPassReport,
  type LexicalSomeTermsPassSkipReason,
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
  matchMode: LexicalMatchMode;
  metadataFilter?: VectorMetadataFilter;
  sourceFilter?: RetrievalSourceFilter;
  lexicalPlan?: LexicalQueryPlan;
};

export interface LexicalSearchResult {
  /** All-terms hits first; under `all_or_some_terms`, some-terms hits may follow. */
  matches: RetrievedChunk[];
  someTermsPass: LexicalSomeTermsPassReport;
}

/**
 * Keyword search over chunk search text. Every match carries its
 * `lexicalTermCoverage`, and the result says what the some-terms pass did.
 */
export interface LexicalSearchPort {
  search(input: LexicalSearchInput): Promise<LexicalSearchResult>;
}

/** The one thing the adapter logs: a some-terms pass that ran out of time. */
export interface LexicalSearchLogger {
  warn(fields: Record<string, unknown>, message: string): void;
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

interface AlternativeCountRow {
  scope_count: number | string | null;
  counts: number[] | null;
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
  constructor(
    private readonly database: Database,
    private readonly options: { logger?: LexicalSearchLogger; someTermsTimeoutMs?: number } = {},
  ) {}

  async search(input: LexicalSearchInput): Promise<LexicalSearchResult> {
    const normalizedQuery = input.query.trim();
    if (!normalizedQuery) {
      return { matches: [], someTermsPass: skippedSomeTermsPass("nothing_to_relax") };
    }

    const plan = input.lexicalPlan ?? buildPlainLexicalQueryPlan(normalizedQuery);
    const allTermsMatches = await this.searchAllTerms(input, plan);
    const keepAllTerms = (reason: LexicalSomeTermsPassSkipReason): LexicalSearchResult =>
      ({ matches: allTermsMatches, someTermsPass: skippedSomeTermsPass(reason) });
    if (input.matchMode === "all_terms") {
      return keepAllTerms("all_terms_only");
    }
    if (allTermsMatches.length >= Math.min(input.topK, RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsBelowAllTermsMatches)) {
      return keepAllTerms("enough_all_terms_matches");
    }
    const someTermsQuery = buildSomeTermsLexicalQuery(plan);
    if (!someTermsQuery) {
      return keepAllTerms("nothing_to_relax");
    }
    // The pass holds a connection for its whole budget; while others queue for one, the
    // wait would spend that budget, and the all-terms hits are a sound answer.
    if (this.database.pool.waitingCount > 0) {
      return keepAllTerms("connections_busy");
    }

    const found = new Set(allTermsMatches.map((match) => match.chunkId));
    const someTerms = await this.searchSomeTermsWithinBudget(input, someTermsQuery, input.topK + found.size);
    return {
      matches: [
        ...allTermsMatches,
        ...someTerms.matches.filter((match) => !found.has(match.chunkId)),
      ].slice(0, input.topK),
      someTermsPass: someTerms.report,
    };
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
   * Counts each alternative's matches, then ranks the chunks the rarer alternatives find
   * by the term weight they hold. Both statements run in one transaction under a shared
   * time budget: a frequent word can make Postgres read every chunk in the workspace.
   * Whatever goes wrong, the all-terms hits are a sound answer on their own, so a
   * timeout or a database error in this pass never fails the search.
   */
  private async searchSomeTermsWithinBudget(
    input: LexicalSearchInput,
    query: SomeTermsLexicalQuery,
    limit: number,
  ): Promise<{ matches: RetrievedChunk[]; report: LexicalSomeTermsPassReport }> {
    const timeoutMs = this.options.someTermsTimeoutMs ?? RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsTimeoutMs;
    const startedAt = performance.now();
    const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
    try {
      const matches = await this.database.withTransaction(async (client) => {
        const run = async <Row>(sql: string, params: unknown[]): Promise<Row[]> => {
          const remainingMs = Math.ceil(timeoutMs - (performance.now() - startedAt));
          if (remainingMs < 1) {
            throw new SomeTermsBudgetExceeded();
          }
          await client.query("SELECT set_config('statement_timeout', $1, true)", [`${remainingMs}ms`]);
          return (await client.query(sql, params)).rows as Row[];
        };
        return this.searchSomeTerms(input, query, limit, run);
      });
      return { matches, report: { outcome: "ran", durationMs: elapsedMs() } };
    } catch (error) {
      const durationMs = elapsedMs();
      const outcome = isSomeTermsTimeout(error) ? "timed_out" as const : "failed" as const;
      const sqlState = sqlStateOf(error);
      this.options.logger?.warn(
        {
          workspaceId: input.workspaceId,
          termCount: query.termCount,
          timeoutMs,
          durationMs,
          ...(outcome === "failed" && sqlState ? { sqlState } : {}),
        },
        outcome === "timed_out"
          ? "lexical some-terms search ran out of time; kept the all-terms matches"
          : "lexical some-terms search failed; kept the all-terms matches",
      );
      return { matches: [], report: { outcome, durationMs } };
    }
  }

  private async searchSomeTerms(
    input: LexicalSearchInput,
    query: SomeTermsLexicalQuery,
    limit: number,
    run: SomeTermsStatementRunner,
  ): Promise<RetrievedChunk[]> {
    const behavior = RETRIEVAL_BEHAVIOR.hybrid;
    const counts = await this.countAlternativeMatches(input, query, behavior.lexicalSomeTermsTermMatchCap, run);
    const ranking = planSomeTermsRanking({
      query,
      alternativeMatchCounts: counts.alternativeMatchCounts,
      scopeChunkCount: counts.scopeChunkCount,
      matchCap: behavior.lexicalSomeTermsTermMatchCap,
      rankedChunkBudget: behavior.lexicalSomeTermsRankedChunkBudget,
      minimumWeightShare: behavior.lexicalSomeTermsMinimumWeightShare,
      minimumHeldWeight: behavior.lexicalSomeTermsMinimumHeldWeight,
      maxRankedTerms: behavior.lexicalSomeTermsMaxRankedTerms,
    });
    if (!ranking) {
      return [];
    }

    const rows = await this.rankSomeTermsMatches(input, query, ranking, limit, run);
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
    run: SomeTermsStatementRunner,
  ): Promise<{ scopeChunkCount: number; alternativeMatchCounts: number[] }> {
    const params: unknown[] = [input.workspaceId];
    const chunkFilterClause = compilePgChunkFilter(input, params);
    const bind = bindParam(params);
    const countLimit = bind(matchCap + 1);
    const scopeCountLimit = bind(RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsScopeCountCap + 1);
    const cappedCount = (condition: string, limit: string, alias: string) => `(
      SELECT count(*)
      FROM (
        SELECT 1
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.workspace_id = $1
          AND ${retrievableDocumentPredicateSql("d")}
          ${chunkFilterClause}
          ${condition}
        LIMIT ${limit}
      ) ${alias}
    )`;
    const counts = query.alternatives.map((alternative) =>
      cappedCount(`AND ${CHUNK_SEARCH_VECTOR_SQL} @@ ${alternativeTsquery(alternative, bind)}`, countLimit, "alternative_matches"));

    const rows = await run<AlternativeCountRow>(
      `SELECT ${cappedCount("", scopeCountLimit, "scope_chunks")} AS scope_count,
              ARRAY[${counts.join(",\n")}]::int[] AS counts`,
      params,
    );
    return {
      scopeChunkCount: Number(rows[0]?.scope_count ?? 0),
      alternativeMatchCounts: (rows[0]?.counts ?? []).map(Number),
    };
  }

  private async rankSomeTermsMatches(
    input: LexicalSearchInput,
    query: SomeTermsLexicalQuery,
    ranking: SomeTermsRankingPlan,
    limit: number,
    run: SomeTermsStatementRunner,
  ): Promise<SomeTermsSearchRow[]> {
    const params: unknown[] = [input.workspaceId];
    const chunkFilterClause = compilePgChunkFilter(input, params);
    const bind = bindParam(params);
    const textParams = new Map(ranking.scoredAlternatives.map((index) => [index, bind(query.alternatives[index]?.text ?? "")]));
    const tsqueryOf = (index: number): string => {
      const alternative = query.alternatives[index];
      const text = textParams.get(index);
      return alternative?.kind === "phrase" ? `phraseto_tsquery('simple', ${text})` : `plainto_tsquery('simple', ${text})`;
    };
    const hitOf = (index: number): string => `h.alternative_${index}`;
    const matchingSql = ranking.matchingAlternatives.map(tsqueryOf).join(" || ");
    const alternativeHitSql = ranking.scoredAlternatives
      .map((index) => `${tsqueryOf(index)} @@ m.search_vector AS alternative_${index}`);
    const exclusionSql = query.excludedTerms.length > 0
      ? query.excludedTerms
          .map((term) => `NOT (plainto_tsquery('simple', ${bind(term)}) @@ m.search_vector)`)
          .join(" AND ")
      : "TRUE";
    const termWeights = bind(ranking.termWeights);
    const coveredWeightSql = ranking.termWeights
      .map((weight, term) => ({ weight, term }))
      .filter(({ weight }) => weight > 0)
      .map(({ term }) => {
        const covering = ranking.scoredAlternatives
          .filter((index) => query.alternatives[index]?.covers.includes(term))
          .map(hitOf);
        return `CASE WHEN ${covering.join(" OR ")} THEN (${termWeights}::float8[])[${term + 1}] ELSE 0 END`;
      })
      .join(" + ");
    // Every term found by its own text, not through a join: the chunk holds the query as
    // written, on the same footing as an all-terms match.
    const coversAllTermsSql = ranking.everyTermRanked
      ? `(${Array.from({ length: query.termCount }, (_, term) => hitOf(term)).join(" AND ")})`
      : "FALSE";
    // ts_rank_cd against the AND of the alternatives this chunk holds, so a some-terms
    // rank reads on the same scale as an all-terms rank.
    const heldAlternativesSql = ranking.scoredAlternatives
      .map((index) => `CASE WHEN ${hitOf(index)} THEN ${textParams.get(index)}::text END`)
      .join(", ");
    const minimumCoveredWeight = bind(ranking.minimumCoveredWeight);
    const rowLimit = bind(limit);

    return run<SomeTermsSearchRow>(
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
       alternative_hits AS (
         SELECT m.*,
                ${alternativeHitSql.join(",\n                ")}
         FROM matched m
         WHERE ${exclusionSql}
       ),
       scored AS (
         SELECT h.chunk_id,
                h.document_id,
                h.title,
                h.content,
                h.search_text,
                h.chunk_index,
                h.start_offset,
                h.end_offset,
                h.metadata,
                ${coveredWeightSql} AS covered_weight,
                ${coversAllTermsSql} AS covers_all_terms,
                ts_rank_cd(h.search_vector, plainto_tsquery('simple', concat_ws(' ', ${heldAlternativesSql}))) AS rank
         FROM alternative_hits h
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

type SomeTermsStatementRunner = <Row>(sql: string, params: unknown[]) => Promise<Row[]>;

class SomeTermsBudgetExceeded extends Error {
  constructor() {
    super("lexical some-terms time budget exhausted");
  }
}

// A SQLSTATE is a five-character class code, never row content, so it is safe to log.
const sqlStateOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    && /^[0-9A-Z]{5}$/.test(error.code)
    ? error.code
    : undefined;

// 57014 is query_canceled: here, the transaction-local statement_timeout firing.
const isSomeTermsTimeout = (error: unknown): boolean =>
  error instanceof SomeTermsBudgetExceeded || sqlStateOf(error) === "57014";

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
