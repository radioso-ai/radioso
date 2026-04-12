ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE accounts
SET name = CONCAT(
  CASE
    WHEN LENGTH(TRIM(split_part(email, '@', 1))) > 0 THEN
      UPPER(LEFT(REGEXP_REPLACE(split_part(email, '@', 1), '[._+-]+', ' ', 'g'), 1)) ||
      SUBSTRING(REGEXP_REPLACE(split_part(email, '@', 1), '[._+-]+', ' ', 'g') FROM 2)
    ELSE 'My'
  END,
  ' Organization'
)
WHERE name IS NULL OR LENGTH(TRIM(name)) = 0;

ALTER TABLE accounts
  ALTER COLUMN name SET NOT NULL;
