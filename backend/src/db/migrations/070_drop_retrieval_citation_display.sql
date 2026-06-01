-- Citation display is now a per-agent assistant behavior setting, persisted in
-- the agents.behavior_settings JSONB (citationDisplayEnabled). The workspace-wide
-- retrieval_settings.citation_display_enabled column is no longer read or written
-- by any code path, so drop it. The previous default was TRUE, which matches the
-- per-agent default applied on read.

ALTER TABLE retrieval_settings
  DROP COLUMN IF EXISTS citation_display_enabled;
