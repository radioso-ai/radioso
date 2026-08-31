import type { RetrievalResponseBehavior } from "../public.js";
import type { RetrievalSourceScope } from "./retrievalSourceFilter.js";

/**
 * The agent fields that decide how retrieval runs for that agent. Declared
 * structurally so retrieval stays independent of the agents module.
 */
export interface AgentRetrievalScopeSource {
  readonly sourceScope: RetrievalSourceScope;
  readonly customInstruction: string;
  readonly citationDisplayEnabled: boolean;
  readonly retrievalEnabled: boolean;
  readonly skillSettings: Record<string, unknown>;
}

/** Pipeline inputs an agent's configuration contributes to a retrieval run. */
export interface AgentRetrievalInputs {
  readonly sourceScope: RetrievalSourceScope;
  readonly responseBehaviorEnabled: true;
  readonly responseBehavior: RetrievalResponseBehavior;
  readonly agentSkillSettings: Record<string, unknown>;
}

export type AgentRetrievalScope = AgentRetrievalInputs & {
  /**
   * Reported rather than enforced: an operator probing an agent that answers
   * without retrieval needs to see that fact, not an empty result set.
   */
  readonly retrievalEnabled: boolean;
};

export interface AgentRetrievalScopePort {
  resolveForAgent(input: { workspaceId: string; agentId: string }): Promise<AgentRetrievalScope | null>;
}

/**
 * Single derivation of "how does this agent retrieve". Every surface that runs
 * retrieval on an agent's behalf reads it from here, so an agent-attributed run
 * cannot drift from the settings the agent actually answers with.
 */
export const resolveAgentRetrievalScope = (agent: AgentRetrievalScopeSource): AgentRetrievalInputs => ({
  sourceScope: agent.sourceScope,
  responseBehaviorEnabled: true,
  responseBehavior: {
    customInstruction: agent.customInstruction,
    citationDisplayEnabled: agent.citationDisplayEnabled,
  },
  agentSkillSettings: agent.skillSettings,
});
