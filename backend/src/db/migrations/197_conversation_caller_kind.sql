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
