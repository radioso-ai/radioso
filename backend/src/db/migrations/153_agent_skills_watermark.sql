-- `agent_skills.latestUpdatedAt` used to be `MAX(updated_at)` over surviving rows, so deleting a
-- skill left the max unchanged (or lower) and `agents.updated_at` never moved either — copilot
-- replay evidence captured before the delete still read as fresh even though the agent it
-- described had a skill that no longer exists. A durable per-agent watermark, touched on every
-- skill write AND delete, replaces that read: it can only move forward.
--
-- Kept off `agents.updated_at` itself on purpose: that column also backs optimistic-concurrency
-- version tokens for unrelated proposal types (directive, agent_setting, routine) on the same
-- agent, so bumping it on every skill edit would make those go spuriously stale too.
CREATE TABLE IF NOT EXISTS agent_skills_watermarks (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_watermarks_workspace ON agent_skills_watermarks (workspace_id);
