-- Typed attributes (#1884), slice 3a, second step: proves the existing rows against the CHECKs 277
-- added NOT VALID. A separate file from 277, so 277's ACCESS EXCLUSIVE locks were released when it
-- committed. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE for its scan, which no read or write
-- waits for, so like 271 it needs no time bound.
ALTER TABLE context_variables VALIDATE CONSTRAINT context_variables_value_type_check;
ALTER TABLE routine_slot VALIDATE CONSTRAINT routine_slot_save_to_check;
