-- The name a person chooses for themselves, which teammates see in the dashboard. Null until
-- they set one; the dashboard labels them by email in the meantime. Trimming, the length limit,
-- and the control-character rule live in the one domain helper every writer uses; the check
-- keeps a blank name from reaching the column by any path.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT NULL CHECK (display_name IS NULL OR btrim(display_name) <> '');
