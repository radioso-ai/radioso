ALTER TABLE retrieval_settings
ADD COLUMN IF NOT EXISTS attribute_controls JSONB NOT NULL DEFAULT '[
  {"family":"date_point","enabled":true,"mode":"boost_only"},
  {"family":"date_range","enabled":true,"mode":"boost_only"},
  {"family":"money_value","enabled":true,"mode":"boost_only"},
  {"family":"location","enabled":true,"mode":"boost_only"}
]'::jsonb;

ALTER TABLE chunks
ADD COLUMN IF NOT EXISTS search_text TEXT,
ADD COLUMN IF NOT EXISTS structured_attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS chunks_search_text_fts_idx
ON chunks
USING GIN (to_tsvector('simple', coalesce(search_text, '')));
