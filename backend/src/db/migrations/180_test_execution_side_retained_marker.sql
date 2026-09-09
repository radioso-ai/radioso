-- Marks a comparison side "consumed" once it has been retained as a standalone test, so a
-- repeated retain call replays the same retained execution instead of spawning another one.
ALTER TABLE agent_test_execution_sides
  ADD COLUMN retained_execution_id UUID REFERENCES agent_test_executions(id) ON DELETE SET NULL;
