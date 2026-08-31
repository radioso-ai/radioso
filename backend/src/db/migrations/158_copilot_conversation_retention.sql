-- Retention sweep index for copilot conversations.
--
-- The existing index is (workspace_id, operator_user_id, updated_at DESC), which serves the
-- operator's own conversation list. The retention sweep asks the opposite question — every
-- conversation in the deployment last active before a cutoff, oldest first — and cannot use a
-- leading-column index it never constrains, so without this it degrades to a sequential scan on a
-- table that only ever grows.
--
-- Messages, proposals, and replay evidence all cascade from copilot_conversations, so no
-- companion index is needed for the rows the delete takes with it.
--
-- Built in the migration transaction like every other index in this schema, which means it holds a
-- write-blocking SHARE lock for the build. Two things make that the right trade here rather than a
-- reason to reach for CREATE INDEX CONCURRENTLY: the runner wraps each migration in a transaction
-- and CONCURRENTLY cannot run inside one, so adopting it means giving the runner a non-transactional
-- mode; and copilot_conversations holds one row per operator Ray thread, which is the smallest scale
-- in this schema — orders of magnitude below the chunks and messages tables that already take plain
-- index builds. The lock question is worth answering for the schema as a whole, not for this table.
CREATE INDEX IF NOT EXISTS copilot_conversations_updated_at_idx
ON copilot_conversations
USING btree (updated_at);
