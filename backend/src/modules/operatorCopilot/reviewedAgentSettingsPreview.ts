export interface AgentNamePort {
  get(workspaceId: string, agentId: string): Promise<{ readonly name: string }>;
}

/**
 * A reviewed agent-settings change shown as what it is: the agent it belongs to, each touched
 * field's current value (the review's fence already holds them) against the patch.
 */
export const previewReviewedAgentSettings = async (
  agents: AgentNamePort,
  workspaceId: string,
  target: { readonly agentId: string; readonly expectedFields: ReadonlyArray<{ readonly key: string; readonly value?: unknown }> },
  patch: unknown,
) => {
  const agent = await agents.get(workspaceId, target.agentId).catch(() => null);
  return {
    targetLabel: agent ? `${agent.name} settings` : "Agent settings",
    current: Object.fromEntries(target.expectedFields.map((field) => [field.key, field.value])),
    proposed: patch,
  };
};
