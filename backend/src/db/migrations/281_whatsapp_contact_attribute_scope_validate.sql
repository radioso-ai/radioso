-- Typed attributes (#1884), slice 4, second step: proves the existing rows against the scope CHECK
-- 280 swapped in NOT VALID. A separate file from 280, so 280's ACCESS EXCLUSIVE lock was released
-- when it committed. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE for its scan, which no read or
-- write waits for, so like 271 and 279 it needs no time bound.
ALTER TABLE context_variable_values VALIDATE CONSTRAINT context_variable_values_scope_type_check;
