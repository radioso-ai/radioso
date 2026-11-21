-- Typed attributes (#1884), second step: proves the existing rows against the CHECKs 270 added NOT
-- VALID, and builds the filter and scope indexes. Every existing row satisfies the CHECKs: the type
-- and scope CHECKs widen the sets they replace, no variable written before 270 is `enum` or has
-- options, and every value written before it has the `api` default as its writer.
--
-- Filter index. The Inbox filter reads the conversation values of enum variables by key. An enum
-- key is a short string, while other values may be up to 32 KB, past the size a btree entry can
-- hold, so the index takes only short string values and never refuses a write. A read is served by
-- it only when its WHERE carries the same predicate (`filterIndexPredicate`).
--
-- Scope index. Erasure and the data subject export read a person's values by workspace, scope type
-- and scope id, across every variable: the `conversation` values of erased conversations, the
-- `session` values of their chat sessions, the `customer` values of a verified customer. The
-- existing indexes lead with the variable, or put it second after the workspace, so without this
-- one each erasure walks every value the workspace holds.
--
-- Locks. A separate file from 270, so 270's ACCESS EXCLUSIVE was released when it committed, before
-- either scan here begins. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE for its scan, which no
-- read or write waits for, so like 212 it needs no time bound. Each CREATE INDEX takes SHARE on
-- `context_variable_values`: reads go through, while every value write (a host push, a resolver
-- cache write, an erasure) waits until this file commits. The runner applies each file in one
-- transaction and has no path that runs a file outside one, so neither index can be built
-- CONCURRENTLY. The CHECKs are validated first, so writes are held for the two index builds alone,
-- and the wait for that lock is bounded to three seconds, because writes queue behind a waiting
-- SHARE; a deploy that hits the bound rolls back and a retry is safe.
ALTER TABLE context_variables VALIDATE CONSTRAINT context_variables_value_type_check;
ALTER TABLE context_variables VALIDATE CONSTRAINT context_variables_options_check;

ALTER TABLE context_variable_values VALIDATE CONSTRAINT context_variable_values_scope_type_check;
ALTER TABLE context_variable_values VALIDATE CONSTRAINT context_variable_values_written_by_kind_check;

SET LOCAL lock_timeout = '3s';

CREATE INDEX idx_context_variable_values_variable_scope_data
  ON context_variable_values (variable_id, scope_type, data)
  WHERE jsonb_typeof(data) = 'string' AND octet_length(data #>> '{}') <= 120;

CREATE INDEX idx_context_variable_values_workspace_scope
  ON context_variable_values (workspace_id, scope_type, scope_id);
