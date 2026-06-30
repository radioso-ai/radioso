-- Operator-only label to disambiguate identically-named agents in the dashboard
-- (e.g. two "Claudio" agents, one EN and one IT). Never shown on public surfaces.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS internal_name TEXT NOT NULL DEFAULT '';
