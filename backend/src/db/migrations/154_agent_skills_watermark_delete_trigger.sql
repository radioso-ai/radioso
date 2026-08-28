-- 153 added agent_skills_watermarks and had AgentSkillRepository touch it on every
-- create/update/delete it performs itself. But webhook, customer_email, external_mcp, and
-- slack skills are written through their own dedicated repositories
-- (webhookSkillDefinitionRepository, emailSkillDefinitionRepository,
-- externalSkillDefinitionRepository, slackSkills/repository.ts) that DELETE FROM agent_skills
-- directly and never touch the watermark — so a delete through one of those never advanced it,
-- and copilot replay evidence captured before that delete could still read as fresh, describing an
-- agent configuration whose skill no longer exists.
--
-- A trigger on agent_skills itself closes that gap for every current AND future writer: it fires
-- on the DELETE statement, not on a call site a repository author has to remember to add, so it
-- cannot be bypassed by a repository nobody has written yet either.
--
-- clock_timestamp() (the wall-clock instant this statement runs), not now() (fixed at the
-- enclosing transaction's start): a transaction that begins early but is delayed and commits late,
-- after a later-starting transaction already advanced the watermark, must not stamp its write with
-- its own stale start-of-transaction time and move the watermark backward. GREATEST on the ON
-- CONFLICT update is a second, storage-level guarantee of the same thing, independent of which
-- writer's statement happens to apply last.
CREATE OR REPLACE FUNCTION touch_agent_skills_watermark_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Skip when the owning agent is already gone within this same transaction (an agent delete
  -- cascading into its skills): agent_skills_watermarks has the same ON DELETE CASCADE FK to
  -- agents, so the watermark row is being removed right along with it, and inserting here would
  -- both be pointless and risk a foreign key violation against an agents row this transaction
  -- already deleted.
  IF NOT EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id) THEN
    RETURN OLD;
  END IF;

  INSERT INTO agent_skills_watermarks (agent_id, workspace_id, updated_at)
  VALUES (OLD.agent_id, OLD.workspace_id, clock_timestamp())
  ON CONFLICT (agent_id) DO UPDATE
    SET updated_at = GREATEST(agent_skills_watermarks.updated_at, EXCLUDED.updated_at);

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_skills_watermark_on_delete
  ON agent_skills;

CREATE TRIGGER trg_agent_skills_watermark_on_delete
AFTER DELETE ON agent_skills
FOR EACH ROW
EXECUTE FUNCTION touch_agent_skills_watermark_on_delete();
