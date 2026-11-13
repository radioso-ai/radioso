-- An `item` slot holds the card a visitor picked from a routine step that shows a tool step's
-- results (#1763). The value lives in routine_states.variables like every slot's; the slot row only
-- names the type, so the type check gains the new value and nothing else changes. The binding
-- itself lives in routine_step.metadata, which needs no column.
--
-- Locks. Re-adding the CHECK holds ACCESS EXCLUSIVE on routine_slot while it validates the existing
-- rows, none of which hold the new type; routine_slot is small, and only routine reads and writes
-- wait. The lock timeout fails the migration rather than queue behind a long transaction.
SET LOCAL lock_timeout = '3s';

ALTER TABLE routine_slot
  DROP CONSTRAINT IF EXISTS routine_slot_type_check;

ALTER TABLE routine_slot
  ADD CONSTRAINT routine_slot_type_check CHECK (type IN ('text', 'number', 'boolean', 'email', 'date', 'item'));
