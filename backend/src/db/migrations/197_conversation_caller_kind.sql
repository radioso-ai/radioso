-- Whether the other side of a conversation is a person or a calling agent. A stored column rather
-- than a read-time expression over `source_channel`, because Activity and the Inbox filter on it and
-- an expression index over an untyped `TEXT` column would have to be kept in step with the domain
-- rule in two places instead of one.
--
-- The value is decided once, at insert, by `callerKindForSourceChannel` in
-- `shared/domain/conversationSource.ts`. `CreateConversationInput` deliberately has no `callerKind`
-- field: a caller that could pass one could contradict the channel it also passed.
--
-- `NOT NULL DEFAULT 'human'` rather than a nullable column, so a read never has to decide what
-- absence means. No CHECK constraint, matching `source_channel` beside it — the domain owns the
-- vocabulary, and a constraint here would turn adding a caller kind into a migration.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS caller_kind TEXT NOT NULL DEFAULT 'human';

-- Run this migration in a coordinated deploy window, the same as `171_answer_coverage_assessments`.
-- Migrations run at API boot while the previous revision still serves traffic, the runner executes
-- each file in one transaction so PostgreSQL cannot build the index CONCURRENTLY, and the build
-- takes a lock on `conversations` that blocks live chat writes for its duration. Booting a second
-- instance during that window leaves it waiting on the migration advisory lock.
--
-- Adding the column itself is cheap: a `NOT NULL DEFAULT` on PostgreSQL 11+ does not rewrite the
-- table. The backfill touches only the two agent channels, and the index is partial over the same
-- rare rows — it is the scan to build it, not the rows it holds, that costs.

-- Backfill by the same rule the domain applies, so history reads the way new rows will.
UPDATE conversations
  SET caller_kind = 'agent'
  WHERE source_channel IN ('mcp', 'agent_api')
    AND caller_kind <> 'agent';

-- Agent callers are the rare kind, and both read surfaces filter within one workspace. A partial
-- index over just those rows stays small and serves `caller_kind = 'agent'`; the `human` case is the
-- unfiltered list, which already has its own path.
--
-- The column order matches the feed's `ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC`
-- exactly, so a filtered page reads the index in order instead of sorting the matched set.
CREATE INDEX IF NOT EXISTS conversations_workspace_agent_caller_idx
  ON conversations (workspace_id, updated_at DESC, created_at DESC, id DESC)
  WHERE caller_kind = 'agent';
