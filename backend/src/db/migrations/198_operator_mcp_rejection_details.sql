ALTER TABLE operator_mcp_invocations
  ADD COLUMN safe_rejection_details jsonb NOT NULL DEFAULT '[]'::jsonb;
