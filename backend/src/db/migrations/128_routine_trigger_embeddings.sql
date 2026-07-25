-- The embedding column is TYPELESS on purpose: allowed workspace embedding
-- models differ in width (text-embedding-3-small/ada-002 = 1536, native
-- text-embedding-3-large = 3072), and unlike chunks — which split bounded
-- vector(1536) + unbounded columns because HNSW needs a fixed dimension —
-- this column carries no index, so no fixed width is required. Searches only
-- compare vectors whose recorded model equals the query's model, which also
-- guarantees dimension compatibility for the <=> operator. The model is
-- workspace-configured and recorded per row (chunks convention, 056); on a
-- model change the row counts as unembedded and the activation prefilter's
-- self-heal lazily re-embeds it.
ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS trigger_embedding VECTOR,
  ADD COLUMN IF NOT EXISTS trigger_embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS trigger_embedding_hash TEXT;

-- No HNSW index — per-agent routine cardinality is hundreds at most, a scan behind the existing agent index is fine.
