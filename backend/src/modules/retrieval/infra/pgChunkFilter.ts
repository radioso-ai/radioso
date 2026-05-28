import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";

export interface ChunkFilter {
  metadataFilter?: Record<string, unknown>;
  sourceFilter?: RetrievalSourceFilter;
}

export const compilePgChunkFilter = (
  input: ChunkFilter,
  params: unknown[],
  aliases: { chunk: string; document: string } = { chunk: "c", document: "d" },
): string => {
  // The returned SQL fragment must be spliced into a query where both aliases
  // are already in scope.
  const clauses = [
    compileSourceFilter(input.sourceFilter, params, aliases.document),
    compileMetadataFilter(input.metadataFilter, params, aliases.chunk),
  ].filter((clause) => clause.length > 0);

  return clauses.join("\n");
};

export const hasNonEmptyFilter = (filter?: Record<string, unknown>): filter is Record<string, unknown> =>
  filter !== undefined && Object.keys(filter).length > 0;

const compileSourceFilter = (
  sourceFilter: RetrievalSourceFilter | undefined,
  params: unknown[],
  documentAlias: string,
): string => {
  const hasConstrainedSourceFilter = sourceFilter?.constrained ?? false;
  let includeUnassignedDocuments = false;
  let sourceIds: string[] = [];
  let hasSourceFilter = false;

  if (hasConstrainedSourceFilter && sourceFilter) {
    const constrainedFilter = sourceFilter;
    if (constrainedFilter.constrained) {
      includeUnassignedDocuments = constrainedFilter.includeUnassignedDocuments;
      sourceIds = constrainedFilter.sourceIds;
      hasSourceFilter = sourceIds.length > 0;
    }
  }

  const sourceClause =
    hasConstrainedSourceFilter && hasSourceFilter && includeUnassignedDocuments
      ? `AND (${documentAlias}.source_id = ANY($${params.length + 1}::uuid[]) OR ${documentAlias}.source_id IS NULL)`
      : hasConstrainedSourceFilter && hasSourceFilter
        ? `AND ${documentAlias}.source_id = ANY($${params.length + 1}::uuid[])`
        : hasConstrainedSourceFilter && includeUnassignedDocuments
          ? `AND ${documentAlias}.source_id IS NULL`
          : hasConstrainedSourceFilter
            ? `AND ${documentAlias}.source_id = ANY($${params.length + 1}::uuid[])`
            : "";

  const sourceIdsParameterRequired = hasConstrainedSourceFilter && (hasSourceFilter || !includeUnassignedDocuments);

  if (sourceIdsParameterRequired) {
    params.push(hasSourceFilter ? sourceIds : []);
  }

  return sourceClause;
};

const compileMetadataFilter = (
  metadataFilter: Record<string, unknown> | undefined,
  params: unknown[],
  chunkAlias: string,
): string => {
  if (!hasNonEmptyFilter(metadataFilter)) {
    return "";
  }

  const metadataClause = `AND ${chunkAlias}.metadata @> $${params.length + 1}::jsonb`;
  params.push(JSON.stringify(metadataFilter));
  return metadataClause;
};
