ALTER TABLE ingestion_settings
  ADD COLUMN IF NOT EXISTS document_enrichment_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE document_processing_jobs
  ADD COLUMN IF NOT EXISTS options jsonb;

-- Text-to-date casts are only STABLE (DateStyle-dependent), so a generated column
-- cannot use them directly. Strict ISO 'YYYY-MM-DD' parsing is deterministic under
-- every DateStyle, which makes this wrapper safe to declare IMMUTABLE.
CREATE OR REPLACE FUNCTION chunk_metadata_iso_date(value text)
RETURNS date
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT CASE
    WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN to_date(value, 'YYYY-MM-DD')
    ELSE NULL
  END
$$;

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS date_from date GENERATED ALWAYS AS (
    chunk_metadata_iso_date(metadata ->> 'dateFrom')
  ) STORED,
  ADD COLUMN IF NOT EXISTS date_to date GENERATED ALWAYS AS (
    COALESCE(
      chunk_metadata_iso_date(metadata ->> 'dateTo'),
      chunk_metadata_iso_date(metadata ->> 'dateFrom')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_workspace_temporal_dates
  ON chunks (workspace_id, date_from, date_to)
  WHERE date_from IS NOT NULL OR date_to IS NOT NULL;
