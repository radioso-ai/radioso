-- Auto-generated conversation title. A short, LLM-produced topic label for the
-- conversation list (an "All lens" row, a Needs-you queue gist), replacing the
-- raw first-message preview once one exists.
--
-- Lives on `conversations`, not `conversation_summaries`: the rolling summary
-- row expires and is reclaimed for an abandoned conversation (see migration
-- 125), but a conversation's title must survive that reclamation and keep
-- labeling the row for as long as the conversation itself exists. The
-- generator (`ConversationSummaryService`) still produces both from the same
-- LLM call that refreshes the summary; only persistence is split.
--
-- Nullable: absent until the summary service's first successful refresh:
-- callers fall back to the existing first-message preview until then.
ALTER TABLE conversations
  ADD COLUMN title TEXT;
