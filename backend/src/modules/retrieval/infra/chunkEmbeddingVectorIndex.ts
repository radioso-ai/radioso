// Single source of truth for how a chunk_embeddings vector of a given width is
// indexed and compared.
//
// `chunk_embeddings.embedding` is a typeless `vector` column so one table can hold
// several embedding widths. A typeless column cannot carry an HNSW index directly,
// so each width gets its own partial expression index over a fixed-width cast. An
// expression index is only used when the query's ORDER BY expression is textually
// equivalent to the indexed expression, so the index definition and the query must
// be generated from the same rule — otherwise the index is silently ignored and
// every search degrades to a full scan.

// pgvector refuses an HNSW index on a `vector` wider than this ("column cannot have
// more than 2000 dimensions for hnsw index"). Above it, halfvec (half precision) is
// the supported route.
export const VECTOR_HNSW_MAX_DIMENSIONS = 2000;

// halfvec has its own, higher ceiling — "column cannot have more than 4000 dimensions
// for hnsw index". Both limits verified against pgvector 0.8.5. A width beyond this
// cannot be HNSW-indexed at all, so it is searched exactly at full precision.
export const HALFVEC_HNSW_MAX_DIMENSIONS = 4000;

// Mirrors chunk_embeddings_dimensions_check in the schema.
const MAX_DIMENSIONS = 16_000;

const assertIndexableDimensions = (dimensions: number): number => {
  if (
    !Number.isInteger(dimensions)
    || dimensions < 1
    || dimensions > MAX_DIMENSIONS
  ) {
    throw new Error(
      `invalid_embedding_dimension: ${dimensions} is not an integer in 1..${MAX_DIMENSIONS}`,
    );
  }
  return dimensions;
};

export const isHnswIndexable = (dimensions: number): boolean =>
  assertIndexableDimensions(dimensions) <= HALFVEC_HNSW_MAX_DIMENSIONS;

// Half precision is only worth taking where it buys an index. Beyond the halfvec
// ceiling there is no index to match, so the comparison stays at full precision.
const vectorTypeFor = (dimensions: number): "vector" | "halfvec" =>
  dimensions <= VECTOR_HNSW_MAX_DIMENSIONS
    || dimensions > HALFVEC_HNSW_MAX_DIMENSIONS
    ? "vector"
    : "halfvec";

export const buildChunkEmbeddingIndexName = (dimensions: number): string =>
  `chunk_embeddings_hnsw_${assertIndexableDimensions(dimensions)}_idx`;

// Matches the names this module generates, so unused indexes can be found in the
// catalog and their width recovered without a separate bookkeeping table.
export const CHUNK_EMBEDDING_INDEX_NAME_PATTERN = /^chunk_embeddings_hnsw_(\d+)_idx$/;

export const parseChunkEmbeddingIndexWidth = (indexName: string): number | null => {
  const width = CHUNK_EMBEDDING_INDEX_NAME_PATTERN.exec(indexName)?.[1];
  return width === undefined ? null : Number(width);
};

export const buildChunkEmbeddingIndexDropSql = (dimensions: number): string =>
  `DROP INDEX IF EXISTS ${buildChunkEmbeddingIndexName(dimensions)}`;

/**
 * The indexed operand and the matching cast for the query parameter. Both sides of
 * the `<=>` must use the same type, and the operand must appear verbatim in the
 * index definition for the planner to match it.
 */
export const buildChunkEmbeddingDistanceExpression = (
  dimensions: number,
  queryParameter: string,
): { operand: string; queryCast: string } => {
  const width = assertIndexableDimensions(dimensions);
  const type = vectorTypeFor(width);
  return {
    operand: `embedding::${type}(${width})`,
    queryCast: `${queryParameter}::${type}(${width})`,
  };
};

/**
 * DDL for the width's partial HNSW index, or null when the width is beyond what
 * pgvector can HNSW-index. Callers skip index creation in that case and fall back to
 * exact search, which stays correct — only slower.
 */
export const buildChunkEmbeddingIndexSql = (dimensions: number): string | null => {
  const width = assertIndexableDimensions(dimensions);
  if (!isHnswIndexable(width)) {
    return null;
  }
  const type = vectorTypeFor(width);
  const { operand } = buildChunkEmbeddingDistanceExpression(width, "$1");
  return `CREATE INDEX IF NOT EXISTS ${buildChunkEmbeddingIndexName(width)} `
    + `ON chunk_embeddings USING hnsw ((${operand}) ${type}_cosine_ops) `
    + `WHERE dimensions = ${width}`;
};
