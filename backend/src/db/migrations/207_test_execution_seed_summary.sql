-- What a test seeded from a real conversation copied in, so Conversation history can count and
-- label it without reading its transcript. The messages the operator sends afterwards are rows in
-- agent_test_execution_turns; these columns hold only the copied part: how many user messages it
-- brought in and the first of them.
--
-- Rows written before these columns existed start at 0 and null; migration 208 fills them in for
-- tests seeded before then.
--
-- Locks. ADD COLUMN with a constant default and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- agent_test_executions for the catalog change and the CHECK scan; no table rewrite.
ALTER TABLE agent_test_executions
  ADD COLUMN IF NOT EXISTS seeded_turn_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seeded_first_message TEXT;

ALTER TABLE agent_test_executions
  DROP CONSTRAINT IF EXISTS agent_test_executions_seeded_turn_count_check;

ALTER TABLE agent_test_executions
  ADD CONSTRAINT agent_test_executions_seeded_turn_count_check CHECK (seeded_turn_count >= 0);
