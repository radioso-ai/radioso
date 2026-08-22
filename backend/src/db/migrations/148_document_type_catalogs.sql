-- Workspace-level catalog of document types used by metadata extraction.
-- One row per workspace; absent rows read as the default catalog (built-ins
-- only, revision 1), so no backfill is required.
--
-- Built-in type definitions (event, article, profile, reference, generic) live
-- in code as system-owned entries and are merged at read time. Only the set of
-- disabled built-in keys is persisted here.
--
-- retired_fields tombstones deleted field identities (key + value type) so a
-- key can never be recreated under a different value type and re-point a saved
-- retrieval rule.
CREATE TABLE IF NOT EXISTS document_type_catalogs (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1,
  types JSONB NOT NULL DEFAULT '[]'::jsonb,
  retired_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  disabled_built_in_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
