-- The embedding column is TYPELESS on purpose: allowed workspace embedding
-- models differ in width (text-embedding-3-small/ada-002 = 1536, native
-- text-embedding-3-large = 3072). Searches only compare vectors whose
-- recorded model equals the query's model, which also guarantees dimension
-- compatibility for the <=> operator. The model is workspace-configured and
-- recorded per row (chunks convention, 056); on a model change the row counts
-- as unembedded and the activation prefilter's self-heal lazily re-embeds it.
ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS trigger_embedding VECTOR,
  ADD COLUMN IF NOT EXISTS trigger_embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS trigger_embedding_hash TEXT;

-- No ANN index yet — and not merely because per-agent cardinality is small:
-- the prefilter query is candidate-id-scoped (id = ANY(...)), a shape HNSW
-- cannot accelerate. If catalogs ever warrant corpus-scoped nearest-K, this
-- same typeless column takes width-partitioned partial expression indexes
-- with no schema change (verified on pgvector 0.8.2):
--   USING hnsw ((trigger_embedding::vector(1536)) vector_cosine_ops)
--     WHERE vector_dims(trigger_embedding) = 1536
--   USING hnsw ((trigger_embedding::halfvec(3072)) halfvec_cosine_ops)
--     WHERE vector_dims(trigger_embedding) = 3072
-- halfvec is mandatory above 2000 dims: vector-typed HNSW hard-caps there, so
-- a fixed vector(3072) column could not be indexed either.
