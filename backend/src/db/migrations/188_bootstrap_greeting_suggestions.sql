-- Spec 1150 (Exact Words, Slice A): an exact greeting's chips are part of what the
-- visitor was actually shown, so the delivery record that `chatSessionPreparer`
-- promotes into real conversation history on the first real turn must carry them
-- alongside the greeting text. Nullable: an automatic greeting has no authored
-- chips and leaves this column null.
ALTER TABLE bootstrap_greeting_cache
  ADD COLUMN IF NOT EXISTS suggestions JSONB;
