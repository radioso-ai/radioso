ALTER TABLE retrieval_settings
  DROP COLUMN IF EXISTS query_rewrite_enabled,
  DROP COLUMN IF EXISTS rerank_enabled,
  DROP COLUMN IF EXISTS vector_top_k,
  DROP COLUMN IF EXISTS similarity_threshold,
  DROP COLUMN IF EXISTS rerank_top_k,
  DROP COLUMN IF EXISTS custom_instruction,
  DROP COLUMN IF EXISTS attribute_controls,
  DROP COLUMN IF EXISTS warmth_level;
