-- Spec 094 Phase F0: add invocation mode to the shared agent_skills spine.
-- Existing runtime-dispatched skills are routine-named today, so the backfill
-- preserves behavior.

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS invocation_mode TEXT;

UPDATE agent_skills
SET invocation_mode = 'routine_named'
WHERE invocation_mode IS NULL;

ALTER TABLE agent_skills
  ALTER COLUMN invocation_mode SET DEFAULT 'routine_named',
  ALTER COLUMN invocation_mode SET NOT NULL;

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_invocation_mode_check;

ALTER TABLE agent_skills
  ADD CONSTRAINT agent_skills_invocation_mode_check
  CHECK (invocation_mode IN ('default_answer', 'routine_named', 'agent_selectable'));

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_kind_check;

ALTER TABLE agent_skills
  ADD CONSTRAINT agent_skills_kind_check
  CHECK (kind IN ('external_mcp', 'customer_email', 'webhook', 'slack', 'retrieve', 'notify'));

CREATE UNIQUE INDEX IF NOT EXISTS agent_skills_one_default_answer
  ON agent_skills (agent_id)
  WHERE invocation_mode = 'default_answer';
