-- A workspace holds its voice vendor's API key in the same encrypted store as its model provider
-- keys, so a page can start a vendor voice session without the key ever leaving the backend.
ALTER TABLE workspace_provider_credentials
  DROP CONSTRAINT workspace_provider_credentials_provider_check;

ALTER TABLE workspace_provider_credentials
  ADD CONSTRAINT workspace_provider_credentials_provider_check
  CHECK (provider IN ('openai', 'openai-compatible', 'gemini', 'claude', 'elevenlabs'));
