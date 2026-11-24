-- Typed attributes (#1884), slice 3a: three more value types, and the attribute a routine slot saves
-- its value to.
--
-- Types. context_variables.value_type admits 'boolean', 'number' and 'date' next to 'string',
-- 'json' and 'enum'. A value of each is stored as JSON: a boolean, a finite number, an ISO calendar
-- date string. The application checks the value against the type (`validateValue`); no option list
-- goes with them, so the options CHECK holds as it is.
--
-- Save targets. A slot that saves its value names the attribute and the scope, `conversation` or
-- `person`, in two columns, set together or not at all. Slots are stored one column per field and
-- the agent draft snapshot is re-projected from these rows after every routine write, so the target
-- needs columns: without them a save would drop it. The attribute is named, not referenced by id,
-- the way a step's `{{context.<name>}}` names it: authoring and publishing check the name against
-- the agent's attributes, and a renamed attribute is reported there rather than followed.
--
-- Locks. The runner applies a file in one transaction, so the ACCESS EXCLUSIVE lock each ALTER
-- takes is held until it commits. The CHECKs are added NOT VALID, which binds new rows at once
-- without scanning the old ones, and the new columns are nullable, which rewrites nothing, so each
-- lock is held for milliseconds. 278 validates the CHECKs after this commits, under a lock no read
-- or write waits for. Every existing row satisfies them: the type CHECK only widens the old one,
-- and no existing slot names a target. The wait for each lock is bounded to three seconds; a deploy
-- that hits the bound rolls back and a retry is safe.
--
-- Rollback is app-only: the previous release runs on this schema and ignores the two slot columns.
-- It knows only the three older types, though, and its readers that parse a variable's type against
-- that closed list fail on a boolean, number or date variable: Ray's and the operator MCP's
-- `conversation_transcript`, attribute tools and attribute proposals. Before a rollback, delete
-- those variables, or accept those tools failing.
SET LOCAL lock_timeout = '3s';

ALTER TABLE context_variables
  DROP CONSTRAINT context_variables_value_type_check,
  ADD CONSTRAINT context_variables_value_type_check
    CHECK (value_type IN ('string', 'json', 'enum', 'boolean', 'number', 'date')) NOT VALID;

ALTER TABLE routine_slot
  ADD COLUMN save_to_context_variable TEXT NULL,
  ADD COLUMN save_to_scope TEXT NULL,
  ADD CONSTRAINT routine_slot_save_to_check CHECK (
    (save_to_context_variable IS NULL) = (save_to_scope IS NULL)
    AND (save_to_scope IS NULL OR save_to_scope IN ('conversation', 'person'))
  ) NOT VALID;
