-- Document metadata is a flat scalar-value contract (validated at the API), so
-- extraction provenance cannot live inside it. Move it to its own column and
-- clean historical rows that nested it under metadata.enrichment.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS enrichment jsonb;

UPDATE documents
SET enrichment = metadata -> 'enrichment',
    metadata = metadata - 'enrichment'
WHERE metadata ? 'enrichment';

UPDATE chunks
SET metadata = metadata - 'enrichment'
WHERE metadata ? 'enrichment';
