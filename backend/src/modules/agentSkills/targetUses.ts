import { sql } from "kysely";

import type { SkillTargetUse, SkillTargetUseReader } from "../../shared/domain/skillTargetUses.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface SkillTargetUseRow {
  agent_id: string;
  agent_name: string;
  skill_name: string;
  in_draft: boolean;
  in_published_release: boolean;
}

/**
 * The skills that use a target, from the draft's skill rows and the skills each agent's published
 * release froze. Read through `agent_skill_target_uses`, the function the targets' delete triggers
 * refuse on, so the refusal a service answers names the skills the database refuses for.
 */
export class AgentSkillTargetUses implements SkillTargetUseReader {
  constructor(private readonly db: Db) {}

  async listSkillTargetUses(target: Parameters<SkillTargetUseReader["listSkillTargetUses"]>[0]): Promise<SkillTargetUse[]> {
    const { rows } = await sql<SkillTargetUseRow>`
      SELECT agent_id, agent_name, skill_name, in_draft, in_published_release
      FROM agent_skill_target_uses(${target.workspaceId}::uuid, ${target.targetType}, ${target.targetId})
    `.execute(this.db);
    return rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      skillName: row.skill_name,
      inDraft: row.in_draft,
      inPublishedRelease: row.in_published_release,
    }));
  }
}
