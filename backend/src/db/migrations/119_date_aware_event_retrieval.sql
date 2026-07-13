ALTER TABLE ingestion_settings
  ADD COLUMN IF NOT EXISTS document_enrichment_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE document_processing_jobs
  ADD COLUMN IF NOT EXISTS options jsonb;

-- Text-to-date casts are only STABLE (DateStyle-dependent), so a generated column
-- cannot use them directly. Strict ISO 'YYYY-MM-DD' parsing is deterministic under
-- every DateStyle, which makes this wrapper safe to declare IMMUTABLE.
-- Chunk metadata is caller-writable, so the function must never raise: an invalid
-- calendar date (for example 2026-02-31, which to_date rejects on PostgreSQL 10+)
-- inside a generated column would otherwise fail the entire chunk INSERT and the
-- backfill for existing rows. Invalid values resolve to NULL, and the round-trip
-- comparison rejects any permissive normalization.
CREATE OR REPLACE FUNCTION chunk_metadata_iso_date(value text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
DECLARE
  parsed date;
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  parsed := to_date(value, 'YYYY-MM-DD');
  IF to_char(parsed, 'YYYY-MM-DD') <> value THEN
    RETURN NULL;
  END IF;
  RETURN parsed;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS date_from date,
  ADD COLUMN IF NOT EXISTS date_to date;

-- Do not backfill historical chunks during application startup. Staging and
-- production can have enough chunks that a generated-column table rewrite or
-- index build prevents Cloud Run from binding its port before the startup
-- probe times out. Enrichment updates chunk metadata for the current document
-- revision, and this trigger keeps the structured date columns current for
-- new or updated chunks without scanning the existing table.
CREATE OR REPLACE FUNCTION set_chunk_temporal_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.date_from := chunk_metadata_iso_date(NEW.metadata ->> 'dateFrom');
  NEW.date_to := COALESCE(
    chunk_metadata_iso_date(NEW.metadata ->> 'dateTo'),
    chunk_metadata_iso_date(NEW.metadata ->> 'dateFrom')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chunks_temporal_dates ON chunks;
CREATE TRIGGER trg_chunks_temporal_dates
  BEFORE INSERT OR UPDATE OF metadata ON chunks
  FOR EACH ROW
  EXECUTE FUNCTION set_chunk_temporal_dates();
