DROP INDEX IF EXISTS skill_intake_states_one_open_flow_idx;

CREATE UNIQUE INDEX IF NOT EXISTS skill_intake_states_one_open_flow_idx
  ON skill_intake_states (workspace_id, conversation_id, skill_name)
  WHERE status IN ('active', 'paused', 'awaiting_confirmation', 'awaiting_tool');
