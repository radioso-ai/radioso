/**
 * Shared spine for agent skill definitions.
 *
 * Both External MCP skills (feature 087) and Customer Email skills (feature 089)
 * are agent-scoped, named, allowlisted skills dispatched through the same skill
 * executor registry. They share one `agent_skills` table (one @mention namespace
 * per agent, enforced across kinds) with per-kind detail tables that keep typed
 * foreign keys and typed config. This module owns the kind vocabulary that the
 * detail tables, repositories, and routine resolver route on.
 */

export const agentSkillKinds = ["external_mcp", "customer_email"] as const;
export type AgentSkillKind = (typeof agentSkillKinds)[number];

export interface AgentSkillSpine {
  id: string;
  agentId: string;
  workspaceId: string;
  skillName: string;
  kind: AgentSkillKind;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
