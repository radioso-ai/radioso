import type { Database } from "../../../shared/infra/database.js";
import { buildPlainLexicalQueryPlan } from "../domain/lexicalQueryPlan.js";
import type { LexicalQueryPlan, RetrievalSourceFilter } from "../domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "./vectorSearch.js";
import { hasNonEmptyFilter } from "./vectorSearch.js";

export interface LexicalSearchPort {
  search(input: {
    workspaceId: string;
    query: string;
    topK: number;
    metadataFilter?: Record<string, unknown>;
    sourceFilter?: RetrievalSourceFilter;
    lexicalPlan?: LexicalQueryPlan;
  }): Promise<RetrievedChunk[]>;
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

export class PgLexicalSearch implements LexicalSearchPort {
  constructor(private readonly database: Database) {}

  async search(input: {
    workspaceId: string;
    query: string;
    topK: number;
    metadataFilter?: Record<string, unknown>;
    sourceFilter?: RetrievalSourceFilter;
    lexicalPlan?: LexicalQueryPlan;
  }): Promise<RetrievedChunk[]> {
    const normalizedQuery = input.query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const plan = input.lexicalPlan ?? buildPlainLexicalQueryPlan(normalizedQuery);
    const compiledPlan = compilePostgresLexicalPlan(plan);
    if (!compiledPlan) {
      return [];
    }

    const params: unknown[] = [input.workspaceId];
    const hasConstrainedSourceFilter = input.sourceFilter?.constrained ?? false;
    let includeUnassignedDocuments = false;
    let sourceIds: string[] = [];
    let hasSourceFilter = false;

    if (hasConstrainedSourceFilter && input.sourceFilter) {
      const constrainedFilter = input.sourceFilter;
      if (constrainedFilter.constrained) {
        includeUnassignedDocuments = constrainedFilter.includeUnassignedDocuments;
        sourceIds = constrainedFilter.sourceIds;
        hasSourceFilter = sourceIds.length > 0;
      }
    }

    const sourceClause =
      hasConstrainedSourceFilter && hasSourceFilter && includeUnassignedDocuments
        ? `AND (d.source_id = ANY($${params.length + 1}::uuid[]) OR d.source_id IS NULL)`
        : hasConstrainedSourceFilter && hasSourceFilter
          ? `AND d.source_id = ANY($${params.length + 1}::uuid[])`
          : hasConstrainedSourceFilter && includeUnassignedDocuments
            ? `AND d.source_id IS NULL`
            : hasConstrainedSourceFilter
              ? `AND d.source_id = ANY($${params.length + 1}::uuid[])`
              : "";

    const sourceIdsParameterRequired = hasConstrainedSourceFilter && (hasSourceFilter || !includeUnassignedDocuments);

    if (sourceIdsParameterRequired) {
      params.push(hasSourceFilter ? sourceIds : []);
    }

    const hasFilter = hasNonEmptyFilter(input.metadataFilter);
    const metadataClause = hasFilter ? `AND c.metadata @> $${params.length + 1}::jsonb` : "";

    if (hasFilter) {
      params.push(JSON.stringify(input.metadataFilter));
    }

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
                to_tsvector('simple', coalesce(c.search_text, c.content, '')) AS search_vector
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.workspace_id = $1
           AND d.status = 'ready'
           ${sourceClause}
           ${metadataClause}
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
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      searchText: row.search_text,
      similarity: normalizeLexicalRank(Number(row.rank), maxRank),
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      metadata: row.metadata ?? {},
    }));
  }
}

const normalizeLexicalRank = (rank: number, maxRank: number): number => {
  if (!Number.isFinite(rank) || rank <= 0 || maxRank <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, rank / maxRank));
};

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
