-- A credential is exchanged repeatedly across MCP process cache loss and Cloud
-- Run revisions. Retain its conversation identity by active grant version.
CREATE TABLE agent_converse_session_mappings (
  grant_id uuid NOT NULL REFERENCES agent_access_grants(id) ON DELETE CASCADE,
  grant_version text NOT NULL,
  public_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, grant_version),
  UNIQUE (public_session_id)
);
