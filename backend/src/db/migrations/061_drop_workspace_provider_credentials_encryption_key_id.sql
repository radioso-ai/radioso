-- The encryption_key_id column was reserved for future encryption key
-- rotation, but no code path reads it on decrypt — every getApiKey call uses
-- the current process-wide key. Carrying the column suggests rotation is
-- supported when it isn't. Drop it now; reintroduce when a real key registry
-- ships.

ALTER TABLE workspace_provider_credentials
  DROP COLUMN IF EXISTS encryption_key_id;
