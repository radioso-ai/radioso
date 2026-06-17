/**
 * Shared spine for agent skill definitions.
 *
 * Skills share generic target/config columns on `agent_skills`. The table owns
 * one @mention namespace per agent across all kinds; runtime services own
 * kind-specific validation.
 */

export const agentSkillKinds = ["external_mcp", "customer_email", "webhook"] as const;
export type AgentSkillKind = (typeof agentSkillKinds)[number];

const agentSkillKindSet = new Set<string>(agentSkillKinds);

export const isAgentSkillKind = (value: string): value is AgentSkillKind =>
  agentSkillKindSet.has(value);

export interface AgentSkillSpine {
  id: string;
  agentId: string;
  workspaceId: string;
  skillName: string;
  kind: AgentSkillKind;
  enabled: boolean;
  targetType?: string | null;
  targetId?: string | null;
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
