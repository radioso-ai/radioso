-- Per-conversation rolling summary (issue #866). One row per conversation (keyed
-- by the conversation id, the engine's session id) holding a bounded, regenerated
-- summary of the conversation so far. The summary is refreshed off the critical
-- path after a turn completes and injected alongside the fixed recent-message
-- window into turn interpretation and answer composition, so multi-turn
-- conversations retain context beyond that window.
--
-- `covered_message_count` is the total message count the summary was generated
-- from; it is a monotonic watermark so an older in-flight regeneration can never
-- clobber a newer one (see the guarded upsert in conversationSummaryRepository).
-- `covered_through` is the timestamp of the newest message the summary covers.
-- `expires_at` bounds an abandoned conversation's summary (refreshed on every
-- write; reads filter expired rows, and the upsert treats an expired row as
-- overwritable regardless of its watermark).
--
-- Unlike the structural siblings (routine_states, directive_states) this table
-- holds summarized conversation CONTENT, so it cascades with its conversation:
-- deleting a conversation or its workspace must not leave summary text behind.
CREATE TABLE IF NOT EXISTS conversation_summaries (
  session_id            UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary               TEXT NOT NULL,
  covered_message_count INTEGER NOT NULL,
  covered_through       TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);
