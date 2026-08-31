import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import {
  resolveAgentRetrievalScope,
  type AgentRetrievalScopePort,
} from "../../modules/retrieval/public.js";

/**
 * Adapts the agent record to the retrieval-owned scope port. Retrieval declares
 * what it needs to run as an agent; composition is the only place that knows an
 * agent is loaded from a repository.
 */
export const createAgentRetrievalScopeResolver = (deps: {
  readonly agentRepository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
}): AgentRetrievalScopePort => ({
  resolveForAgent: async ({ workspaceId, agentId }) => {
    const agent = await deps.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      return null;
    }
    return {
      ...resolveAgentRetrievalScope(agent),
      retrievalEnabled: agent.retrievalEnabled,
    };
  },
});
