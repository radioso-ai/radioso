ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS public_route_key TEXT;

UPDATE workspaces
SET public_route_key = CONCAT(
  COALESCE(
    NULLIF(
      TRIM(
        BOTH '-'
        FROM SUBSTRING(
          TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g'))
          FROM 1 FOR 24
        )
      ),
      ''
    ),
    'workspace'
  ),
  '-',
  SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 6)
)
WHERE public_route_key IS NULL;

ALTER TABLE workspaces
ALTER COLUMN public_route_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_public_route_key
ON workspaces (public_route_key);
