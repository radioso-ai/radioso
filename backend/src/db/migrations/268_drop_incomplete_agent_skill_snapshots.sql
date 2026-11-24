-- Drop the skill sets recorded in agent drafts and revisions (#1793).
--
-- Conversations now run the skill rows their release recorded (`snapshot.agentSkills`) instead of the
-- live `agent_skills` table. Those recorded sets are incomplete: until this change the per-kind skill
-- routes (external MCP, customer email, Slack and webhook skills) wrote `agent_skills` and never
-- touched the draft, so a skill created or edited through them is missing or stale in every draft and
-- release since. Running those sets would drop skills that run today.
--
-- A snapshot with no `agentSkills` is one that predates skill tracking, and the runtime already reads
-- the live table for it, as every conversation's skill executors did before this change. The first
-- skill write rebuilds the draft's set from the live table, and the next publish records a complete
-- set from there on (agentRevisionRepository.createCandidate). Revisions are otherwise immutable;
-- only this key is removed.

UPDATE agent_drafts
SET snapshot = snapshot - 'agentSkills'
WHERE snapshot ? 'agentSkills';

UPDATE agent_revisions
SET snapshot = snapshot - 'agentSkills'
WHERE snapshot ? 'agentSkills';
