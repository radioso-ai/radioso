-- Real directive ids a replay excluded, resolved and validated by the replay service against the
-- source agent's actual directives — never read from the model-supplied `overrides` payload,
-- which carries no id a caller can trust. This is what propose_directive_removal evidence checks.
ALTER TABLE copilot_replay_evidence
  ADD COLUMN directives_excluded JSONB NOT NULL DEFAULT '[]'::jsonb;
