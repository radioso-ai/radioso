ALTER TABLE ingestion_settings
  ADD COLUMN IF NOT EXISTS document_enrichment_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE document_processing_jobs
  ADD COLUMN IF NOT EXISTS options jsonb;

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS date_from date GENERATED ALWAYS AS (
    CASE
      WHEN metadata ->> 'dateFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      THEN (metadata ->> 'dateFrom')::date
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN IF NOT EXISTS date_to date GENERATED ALWAYS AS (
    CASE
      WHEN metadata ->> 'dateTo' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      THEN (metadata ->> 'dateTo')::date
      WHEN metadata ->> 'dateFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      THEN (metadata ->> 'dateFrom')::date
      ELSE NULL
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_workspace_temporal_dates
  ON chunks (workspace_id, date_from, date_to)
  WHERE date_from IS NOT NULL OR date_to IS NOT NULL;
