-- Generator scope for authored directives. A turn writes visitor-facing text from more
-- than one model call, and a directive that governs one of them does not necessarily
-- govern another. An empty array means the answering voice only, which is what every
-- directive authored before this column meant.
ALTER TABLE agent_directives
  ADD COLUMN IF NOT EXISTS surfaces TEXT[] NOT NULL DEFAULT '{}';
