-- Documents added by hand have no document_sources row, so they have no place
-- to carry the source-level metadata extraction override. This column is their
-- source-override slot: 'inherit' follows the workspace default, 'on' and 'off'
-- decide for every manually added document in the workspace.
ALTER TABLE ingestion_settings
  ADD COLUMN IF NOT EXISTS manual_document_enrichment_override text NOT NULL DEFAULT 'inherit';
