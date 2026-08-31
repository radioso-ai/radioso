-- Retention sweep index for copilot conversations.
--
-- The existing index is (workspace_id, operator_user_id, updated_at DESC), which serves the
-- operator's own conversation list. The retention sweep asks the opposite question — every
-- conversation in the deployment last active before a cutoff, oldest first — and cannot use a
-- leading-column index it never constrains, so without this it degrades to a sequential scan on a
-- table that only ever grows.
--
-- Messages, proposals, and replay evidence all cascade from copilot_conversations. Postgres does
-- not index a referencing column for you, so each cascade needs one that leads with
-- conversation_id or the delete scans that whole table once per batch. copilot_messages and
-- copilot_proposals already have one; copilot_replay_evidence is indexed by operator and creation
-- time only, so it gets one here.
--
-- The cascade is two levels deep, not one. Deleting the messages then fires
-- copilot_proposals.message_id's ON DELETE SET NULL, whose referential-integrity lookup constrains
-- message_id alone — which the (conversation_id, message_id, created_at) index cannot serve,
-- because its leading column is unconstrained there. That one gets an index too.
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

CREATE INDEX IF NOT EXISTS copilot_replay_evidence_conversation_idx
ON copilot_replay_evidence
USING btree (conversation_id);

-- Partial because only an attached proposal can be the target of that lookup: the integrity check
-- searches for `message_id = <deleted id>`, which implies NOT NULL, so the planner can use this
-- index for it while it stays off the pending proposals that carry no message yet.
CREATE INDEX IF NOT EXISTS copilot_proposals_message_idx
ON copilot_proposals
USING btree (message_id)
WHERE message_id IS NOT NULL;
