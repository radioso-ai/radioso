/**
 * Shared spine for agent skill definitions.
 *
 * Skills share generic target/config columns on `agent_skills`. The table owns
 * one @mention namespace per agent across all kinds; runtime services own
 * kind-specific validation.
 */

export const agentSkillKinds = ["external_mcp", "customer_email", "webhook", "slack", "retrieve", "notify"] as const;
export type AgentSkillKind = (typeof agentSkillKinds)[number];

export const agentSkillInvocationModes = ["default_answer", "routine_named", "agent_selectable"] as const;
export type AgentSkillInvocationMode = (typeof agentSkillInvocationModes)[number];

export interface AgentSkillSpine {
  id: string;
  agentId: string;
  workspaceId: string;
  skillName: string;
  kind: AgentSkillKind;
  invocationMode: AgentSkillInvocationMode;
  enabled: boolean;
  targetType?: string | null;
  targetId?: string | null;
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
