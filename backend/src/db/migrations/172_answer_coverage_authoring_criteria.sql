ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS coverage_criteria jsonb;
ALTER TABLE routine_definition ADD COLUMN IF NOT EXISTS activation_coverage_criteria jsonb;
