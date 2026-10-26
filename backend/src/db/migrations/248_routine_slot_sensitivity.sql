-- Whether a routine slot's value may leave the conversation as the visitor gave it (#1543). The
-- author marks a slot sensitive; nothing infers it from the key or the value. A sensitive value
-- stays in routine_states.variables and the transcript, and every copy that leaves (operator
-- notices, action and export payloads, skill arguments no binding named, traces) masks it.
--
-- Slots are stored one column per field and the agent draft snapshot is re-projected from these
-- rows after every routine write, so the field needs a column: without one a save would drop it.
-- Every existing slot reads back as 'normal', so no routine changes behaviour.
--
-- Locks. ADD COLUMN with a constant default is a catalog-only change in PostgreSQL 11+, and the
-- CHECK is validated against existing rows (all 'normal'); both hold ACCESS EXCLUSIVE on
-- routine_slot for milliseconds, and only routine reads and writes wait.
ALTER TABLE routine_slot
  ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE routine_slot
  DROP CONSTRAINT IF EXISTS routine_slot_sensitivity_check;

ALTER TABLE routine_slot
  ADD CONSTRAINT routine_slot_sensitivity_check CHECK (sensitivity IN ('normal', 'sensitive'));
