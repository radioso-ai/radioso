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

-- Backfill by the same rule the domain applies, so history reads the way new rows will. Adding the
-- column is cheap — a `NOT NULL DEFAULT` on PostgreSQL 11+ does not rewrite the table — and the
-- backfill touches only the two agent channels, so this migration needs no coordinated deploy
-- window.
--
-- No index. The only query that filters on `caller_kind` is the Activity and Inbox filter, whose
-- interface is a later slice, and a non-concurrent `CREATE INDEX` on `conversations` would block
-- live chat writes for the length of its scan: migrations run at API boot while the previous
-- revision still serves, and the runner executes each file in one transaction, so PostgreSQL
-- cannot build it CONCURRENTLY. The index belongs with the surface that reads it, when there is
-- traffic to size it against.
UPDATE conversations
  SET caller_kind = 'agent'
  WHERE source_channel IN ('mcp', 'agent_api')
    AND caller_kind <> 'agent';
