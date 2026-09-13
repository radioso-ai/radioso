ALTER TABLE operator_mcp_authorization_transactions
  DROP CONSTRAINT operator_mcp_authorization_transactions_check,
  DROP CONSTRAINT operator_mcp_authorization_transact_requested_tool_scopes_check,
  DROP CONSTRAINT operator_mcp_authorization_transac_requested_tool_scopes_check1,
  ADD CONSTRAINT operator_mcp_authorization_transactions_requested_tool_scopes_count_check
    CHECK (cardinality(requested_tool_scopes) BETWEEN 1 AND 5),
  ADD CONSTRAINT operator_mcp_authorization_transactions_requested_tool_scopes_values_check
    CHECK (requested_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose', 'operator:write']::TEXT[]),
  ADD CONSTRAINT operator_mcp_authorization_transactions_check
    CHECK (approved_tool_scopes IS NULL OR (
      cardinality(approved_tool_scopes) BETWEEN 1 AND 5
      AND approved_tool_scopes <@ requested_tool_scopes
    ));

ALTER TABLE operator_mcp_grants
  DROP CONSTRAINT operator_mcp_grants_tool_scopes_check,
  DROP CONSTRAINT operator_mcp_grants_tool_scopes_check1,
  ADD CONSTRAINT operator_mcp_grants_tool_scopes_count_check
    CHECK (cardinality(tool_scopes) BETWEEN 1 AND 5),
  ADD CONSTRAINT operator_mcp_grants_tool_scopes_values_check
    CHECK (tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose', 'operator:write']::TEXT[]);

ALTER TABLE operator_mcp_access_credentials
  DROP CONSTRAINT operator_mcp_access_credentials_issued_tool_scopes_check,
  DROP CONSTRAINT operator_mcp_access_credentials_issued_tool_scopes_check1,
  ADD CONSTRAINT operator_mcp_access_credentials_issued_tool_scopes_count_check
    CHECK (cardinality(issued_tool_scopes) BETWEEN 1 AND 5),
  ADD CONSTRAINT operator_mcp_access_credentials_issued_tool_scopes_values_check
    CHECK (issued_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose', 'operator:write']::TEXT[]);

ALTER TABLE operator_mcp_refresh_lineages
  DROP CONSTRAINT operator_mcp_refresh_lineages_issued_tool_scopes_check,
  DROP CONSTRAINT operator_mcp_refresh_lineages_issued_tool_scopes_check1,
  ADD CONSTRAINT operator_mcp_refresh_lineages_issued_tool_scopes_count_check
    CHECK (cardinality(issued_tool_scopes) BETWEEN 1 AND 5),
  ADD CONSTRAINT operator_mcp_refresh_lineages_issued_tool_scopes_values_check
    CHECK (issued_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose', 'operator:write']::TEXT[]);

ALTER TABLE operator_mcp_refresh_generations
  DROP CONSTRAINT operator_mcp_refresh_generations_issued_tool_scopes_check,
  DROP CONSTRAINT operator_mcp_refresh_generations_issued_tool_scopes_check1,
  ADD CONSTRAINT operator_mcp_refresh_generations_issued_tool_scopes_count_check
    CHECK (cardinality(issued_tool_scopes) BETWEEN 1 AND 5),
  ADD CONSTRAINT operator_mcp_refresh_generations_issued_tool_scopes_values_check
    CHECK (issued_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose', 'operator:write']::TEXT[]);
