-- VECTOR(1536) fixes the storage DIMENSION, not the embedding model: 1536 is the
-- platform-wide storage width shared with chunks (001/044), and provider adapters
-- normalize to it (e.g. the Gemini adapter requests output_dimensionality 1536).
-- The model itself is workspace-configured and recorded per row below (chunks
-- convention, 056); on a model change the row is treated as unembedded and lazily
-- re-embedded by the activation prefilter's self-heal.
ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS trigger_embedding VECTOR(1536),
  ADD COLUMN IF NOT EXISTS trigger_embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS trigger_embedding_hash TEXT;

-- No HNSW index — per-agent routine cardinality is hundreds at most, a scan behind the existing agent index is fine.
