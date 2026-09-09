import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import { projectInternalAgentConfig, type InternalAgentConfig } from "../../modules/agents/public.js";

/** Live, non-versioned agent settings that remain subject to runtime authorization. */
export interface LiveAgentConfigReaderPort {
  find(input: { workspaceId: string; agentId: string }): Promise<InternalAgentConfig | null>;
}

/**
 * Adapts the agent record to the narrow "current live config" port shared by the test-execution
 * runner and the revision-eval candidate replay. Both need the agent's live, unversioned
 * settings/credentials layered under an immutable revision snapshot; composition is the only
 * place that knows that config is loaded and projected from a repository record.
 */
export const createLiveAgentConfigReader = (deps: {
  readonly agentRepository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
}): LiveAgentConfigReaderPort => ({
  find: async ({ workspaceId, agentId }) => {
    const agent = await deps.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    return agent ? projectInternalAgentConfig(agent) : null;
  },
});
