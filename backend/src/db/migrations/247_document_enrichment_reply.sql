-- Document enrichment reuse (#1578): documents.enrichment_reply holds the last usable reply the
-- metadata extraction model gave for the document, with the fingerprint of the request it
-- answered and the revision whose run stored it:
-- { "requestFingerprint": text, "revision": int, "model": text, "output": <reply JSON> }. A later
-- enrich run that would send the same request applies this reply instead of calling the model,
-- so re-indexing unchanged content costs no model call.
--
-- Kept apart from documents.enrichment (the provenance of the run that owns the current tags):
-- a re-sync resets provenance, but a stored reply stays valid while the title and text it
-- quotes are unchanged. Document writes that change either clear it, and it is deleted with
-- the document row.
--
-- Nullable, no default: adding the column is a catalog-only change.
SET LOCAL lock_timeout = '3s';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS enrichment_reply jsonb;
